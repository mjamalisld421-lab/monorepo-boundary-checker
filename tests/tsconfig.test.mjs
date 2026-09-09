import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverWorkspaces } from "../dist/workspaces.js";
import { resolveImportReference, resolveScans } from "../dist/resolver.js";
import { scanSourceTree } from "../dist/scanner.js";
import { createConfigLoader, TypeScriptConfigError } from "../dist/tsconfig.js";
import { runBoundaryCheck } from "../dist/check.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const rootConfig = { compilerOptions: { baseUrl: ".", paths: {
  "@shared": ["packages/shared/src/index.ts"],
  "@shared/*": ["packages/shared/src/*"],
  "@db/*": ["packages/database/src/*"],
  "@ui/*": ["packages/ui/src/*"],
  "@domain/*": ["packages/domain/src/*"],
} } };

async function fixture(t, config = rootConfig) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mbc-tsconfig-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, contents) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  await put("package.json", { workspaces: ["apps/*", "packages/*"] });
  for (const [directory, name] of [["apps/web", "web"], ["packages/ui", "ui"],
    ["packages/domain", "domain"], ["packages/database", "database"], ["packages/shared", "shared"]]) {
    await put(`${directory}/package.json`, { name: `@demo/${name}` });
  }
  for (const name of ["apps/web/src/page.ts", "packages/ui/src/button.ts", "packages/domain/src/service.ts",
    "packages/domain/src/models.ts", "packages/database/src/client.ts", "packages/shared/src/index.ts",
    "packages/shared/src/utils/index.ts", "packages/shared/src/foo.ts"]) await put(name, "export {};");
  await put("monorepo-boundary.config.json", { boundaries: {
    "@demo/web": ["@demo/ui"], "@demo/domain": ["@demo/shared"],
  } });
  if (config !== null) await put("tsconfig.json", config);
  const workspaces = await discoverWorkspaces(root);
  const source = path.join(root, "packages/domain/src/service.ts");
  const resolve = (specifier) => resolveImportReference(source, { specifier, kind: "import" }, workspaces, { rootDirectory: root });
  const cli = () => {
    const result = spawnSync(process.execPath, [cliPath], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  return { root, source, workspaces, put, resolve, cli };
}

for (const [specifier, target, classification] of [
  ["@shared", "@demo/shared", "cross-workspace"],
  ["@shared/foo", "@demo/shared", "cross-workspace"],
  ["@shared/utils", "@demo/shared", "cross-workspace"],
  ["@domain/models", "@demo/domain", "internal"],
  ["@demo/shared", "@demo/shared", "cross-workspace"],
  ["@demo/shared/nonexistent-subpath", "@demo/shared", "cross-workspace"],
  ["react", undefined, "external"],
  ["@babel/parser", undefined, "external"],
  ["node:fs", undefined, "builtin"],
  ["fs", undefined, "builtin"],
]) {
  test(`TS configuration preserves/resolves ${specifier} as ${classification}`, async (t) => {
    const { resolve } = await fixture(t);
    const result = await resolve(specifier);
    assert.equal(result.classification, classification);
    assert.equal(result.targetWorkspace?.name, target);
  });
}

test("no tsconfig preserves JavaScript workspace, relative and external behavior", async (t) => {
  const { resolve, put } = await fixture(t, null);
  await put("packages/domain/src/helper.js", "export {};");
  assert.equal((await resolve("./helper")).classification, "internal");
  assert.equal((await resolve("@demo/shared")).targetWorkspace.name, "@demo/shared");
  assert.equal((await resolve("@shared/foo")).classification, "external");
});

test("multiple targets use first existing target in declared order", async (t) => {
  const { resolve, put } = await fixture(t, { compilerOptions: { paths: {
    "@fallback/*": ["missing/*", "packages/shared/src/*", "packages/database/src/*"],
  } } });
  await put("packages/database/src/index.ts", "export {};");
  assert.equal((await resolve("@fallback/index")).targetWorkspace.name, "@demo/shared");
  assert.equal((await resolve("@fallback/client")).targetWorkspace.name, "@demo/database");
});

test("first physical target wins even if it is outside discovered workspaces", async (t) => {
  const { resolve, put } = await fixture(t, { compilerOptions: { paths: {
    "@outside": ["outside.ts", "packages/shared/src/index.ts"],
  } } });
  await put("outside.ts", "export {};");
  assert.equal((await resolve("@outside")).reason, "unowned-alias-target");
});

test("broken matched alias is unresolved rather than external or baseUrl fallback", async (t) => {
  const { resolve, put } = await fixture(t);
  await put("@shared/missing.ts", "export {};");
  assert.equal((await resolve("@shared/missing")).reason, "alias-target-not-found");
  assert.equal((await resolve("./missing")).reason, "missing-relative-target");
});

test("exact aliases beat wildcard aliases and longest wildcard prefix wins", async (t) => {
  const { resolve } = await fixture(t, { compilerOptions: { paths: {
    "@*": ["missing/*"],
    "@shared/*": ["packages/shared/src/*"],
    "@shared/client": ["packages/database/src/client.ts"],
  } } });
  assert.equal((await resolve("@shared/foo")).targetWorkspace.name, "@demo/shared");
  assert.equal((await resolve("@shared/client")).targetWorkspace.name, "@demo/database");
});

test("wildcards support suffixes, empty capture and literal dollar substitution", async (t) => {
  const { resolve, put } = await fixture(t, { compilerOptions: { paths: {
    "@suffix/*/value": ["packages/shared/src/*"],
    "@empty*": ["packages/shared/src/*index.ts"],
  } } });
  await put("packages/shared/src/$&.ts", "export {};");
  assert.equal((await resolve("@suffix/$&/value")).targetWorkspace.name, "@demo/shared");
  assert.equal((await resolve("@empty")).targetWorkspace.name, "@demo/shared");
});

test("builtin and workspace identity cannot be overridden by paths", async (t) => {
  const { resolve } = await fixture(t, { compilerOptions: { paths: {
    "fs": ["missing.ts"], "node:fs": ["missing.ts"], "@demo/shared": ["missing.ts"],
    "@demo/shared/*": ["packages/database/src/*"],
  } } });
  for (const specifier of ["fs", "node:fs"]) assert.equal((await resolve(specifier)).classification, "builtin");
  for (const specifier of ["@demo/shared", "@demo/shared/client"]) {
    assert.equal((await resolve(specifier)).targetWorkspace.name, "@demo/shared");
  }
});

test("workspace config is selected before root without implicitly merging", async (t) => {
  const { resolve, put } = await fixture(t);
  await put("packages/domain/tsconfig.json", { compilerOptions: { paths: { "@local": ["src/models.ts"] } } });
  assert.equal((await resolve("@local")).classification, "internal");
  assert.equal((await resolve("@shared/foo")).classification, "external");
});

test("extends inherits root paths and their original directory without baseUrl", async (t) => {
  const { resolve, put } = await fixture(t, { compilerOptions: { paths: rootConfig.compilerOptions.paths } });
  await put("packages/domain/tsconfig.json", { extends: "../../tsconfig.json" });
  assert.equal((await resolve("@shared/foo")).targetWorkspace.name, "@demo/shared");
});

test("extends uses the inherited baseUrl, and an explicit child baseUrl override", async (t) => {
  const { resolve, put } = await fixture(t);
  await put("packages/domain/tsconfig.json", { extends: "../../tsconfig.json" });
  assert.equal((await resolve("@shared/foo")).targetWorkspace.name, "@demo/shared");
  await put("packages/domain/tsconfig.json", { extends: "../../tsconfig.json", compilerOptions: { baseUrl: "." } });
  await put("packages/domain/packages/shared/src/foo.ts", "export {};");
  assert.equal((await resolve("@shared/foo")).classification, "internal");
});

test("comments and trailing commas are accepted by TS configuration parser", async (t) => {
  const { resolve } = await fixture(t, `{
    // Configuration is JSONC, not strict JSON.
    "compilerOptions": { "paths": { "@shared": ["packages/shared/src/index.ts",], }, },
  }`);
  assert.equal((await resolve("@shared")).targetWorkspace.name, "@demo/shared");
});

test("malformed inherited config fails rather than falling back", async (t) => {
  const { put, resolve } = await fixture(t);
  await put("packages/domain/tsconfig.json", { extends: "../../broken.json" });
  await put("broken.json", "{");
  await assert.rejects(resolve("@shared/foo"), (error) => {
    assert.ok(error instanceof TypeScriptConfigError);
    assert.equal(error.code, "TSCONFIG_PARSE_ERROR");
    assert.ok(error.cause.length > 0);
    return true;
  });
});

test("baseUrl resolves existing local sources, including package-like names", async (t) => {
  const { resolve, put } = await fixture(t, { compilerOptions: { baseUrl: "packages/domain/src" } });
  await put("packages/domain/src/utils/helper.ts", "export {};");
  await put("packages/domain/src/react.ts", "export {};");
  assert.equal((await resolve("utils/helper")).classification, "internal");
  // TS 5.9 baseUrl probes local paths before external packages.
  assert.equal((await resolve("react")).classification, "internal");
  assert.equal((await resolve("lodash")).classification, "external");
});

for (const [name, config] of [
  ["malformed JSONC", "{"],
  ["invalid compiler option", { compilerOptions: { baseUrl: 42 } }],
  ["invalid paths value", { compilerOptions: { paths: { "@bad": "src/file" } } }],
  ["empty targets", { compilerOptions: { paths: { "@bad": [] } } }],
  ["multiple pattern stars", { compilerOptions: { paths: { "@bad/*/*": ["src/*"] } } }],
  ["multiple target stars", { compilerOptions: { paths: { "@bad/*": ["src/*/*"] } } }],
  ["missing extends", { extends: "./missing.json" }],
  ["cyclic extends", { extends: "./tsconfig.json" }],
]) {
  test(`${name} produces typed file-specific configuration error`, async (t) => {
    const { resolve, root } = await fixture(t, config);
    await assert.rejects(resolve("@shared"), (error) => {
      assert.ok(error instanceof TypeScriptConfigError);
      assert.equal(error.code, "TSCONFIG_PARSE_ERROR");
      assert.equal(error.configPath, path.join(root, "tsconfig.json"));
      assert.match(error.message, /TypeScript configuration/);
      return true;
    });
  });
}

test("unreadable config shape produces TSCONFIG_READ_ERROR", async (t) => {
  const { resolve, root } = await fixture(t, null);
  await mkdir(path.join(root, "tsconfig.json"));
  await assert.rejects(resolve("react"), { code: "TSCONFIG_READ_ERROR" });
});

for (const [specifier, file] of [["./helper.js", "helper.ts"], ["./view.js", "view.tsx"],
  ["./view.jsx", "view.tsx"], ["./helper", "helper.ts"], ["./utils", "utils/index.ts"]]) {
  test(`${specifier} resolves supported source candidate ${file}`, async (t) => {
    const { resolve, put } = await fixture(t);
    await put(`packages/domain/src/${file}`, "export {};");
    assert.equal((await resolve(specifier)).classification, "internal");
  });
}

test("exact .js files win over substitutions; extensionless .js wins over .ts", async (t) => {
  const { resolve, root, workspaces, put } = await fixture(t);
  await put("packages/domain/src/helper.js", "export {};");
  await put("packages/domain/src/helper.ts", "export {};");
  // A nested owner lets us observe which physical file was selected.
  workspaces.push({ name: "exact-js", root: path.join(root, "packages/domain/src/helper.js"), packageJsonPath: "unused" });
  for (const specifier of ["./helper.js", "./helper"]) assert.equal((await resolve(specifier)).targetWorkspace.name, "exact-js");
});

test("alias probing shares extension substitution and ignores unsupported targets", async (t) => {
  const { resolve, put } = await fixture(t, { compilerOptions: { paths: {
    "@sub": ["packages/shared/src/foo.js"], "@json": ["packages/shared/data.json"],
  } } });
  await put("packages/shared/data.json", {});
  assert.equal((await resolve("@sub")).targetWorkspace.name, "@demo/shared");
  assert.equal((await resolve("@json")).reason, "alias-target-not-found");
});

test("alias targets use canonical realpaths and do not scan node_modules", async (t) => {
  const { resolve, root, put } = await fixture(t, { compilerOptions: { paths: {
    "@link/*": ["linked/*"], "@vendor": ["node_modules/vendor/index.ts"],
  } } });
  await symlink(path.join(root, "packages/shared/src"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await put("node_modules/vendor/index.ts", "export {};");
  assert.equal((await resolve("@link/foo")).targetWorkspace.name, "@demo/shared");
  assert.equal((await resolve("@vendor")).reason, "alias-target-not-found");
});

test("config cache is per-run and reuses one root parse across workspaces", async (t) => {
  const { root, workspaces, put } = await fixture(t);
  const load = createConfigLoader(root);
  const first = await load(workspaces[0].root);
  await put("tsconfig.json", "{");
  assert.equal(await load(workspaces[0].root), first);
  assert.equal(await load(workspaces[1].root), first);
  await assert.rejects(createConfigLoader(root)(workspaces[0].root), { code: "TSCONFIG_PARSE_ERROR" });
});

test("realistic alias pipeline preserves order/duplicates and evaluates allowed/forbidden edges", async (t) => {
  const { root, workspaces, put, cli } = await fixture(t);
  await put("apps/web/tsconfig.json", { extends: "../../tsconfig.json" });
  await put("apps/web/src/page.ts", 'import "@ui/button";');
  await put("packages/domain/src/service.ts", 'import "@shared/index"; import "@db/client"; import "@domain/models"; import "@shared/index";');
  const scans = await scanSourceTree(root);
  const first = await resolveScans(scans, workspaces, { rootDirectory: root });
  assert.deepEqual(await resolveScans(scans, workspaces, { rootDirectory: root }), first);
  assert.deepEqual(first.map((r) => r.specifier), ["@ui/button", "@shared/index", "@db/client", "@domain/models", "@shared/index"]);
  const result = await runBoundaryCheck({ rootDirectory: root });
  assert.deepEqual(result.evaluations.map((r) => r.status), ["allowed", "allowed", "violation", "skipped", "allowed"]);
  assert.equal(result.exitCode, 1);
  const output = cli();
  assert.equal(output.status, 1);
  assert.equal(output.stderr, "");
  assert.match(output.stdout, /@demo\/domain -> @demo\/database/);
  assert.match(output.stdout, /import: @db\/client/);
  assert.match(output.stdout, /Boundary violations: 1/);
});

test("CLI accepts allowed and internal aliases without reporting violations", async (t) => {
  const { put, cli } = await fixture(t);
  await put("packages/domain/src/service.ts", 'import "@shared/foo"; import "@domain/models";');
  const output = cli();
  assert.equal(output.status, 0);
  assert.match(output.stdout, /No dependency boundary violations found/);
  assert.match(output.stdout, /Cross-workspace imports checked: 1/);
});

test("CLI reports broken aliases as operational exit 2", async (t) => {
  const { put, cli } = await fixture(t);
  await put("packages/domain/src/service.ts", 'import "@shared/missing";');
  const output = cli();
  assert.equal(output.status, 2);
  assert.match(output.stdout, /@shared\/missing \(alias-target-not-found\)/);
});

test("CLI formats invalid tsconfig as operational error even with no imports", async (t) => {
  const { cli, root } = await fixture(t, "{");
  const output = cli();
  assert.equal(output.status, 2);
  assert.equal(output.stdout, "");
  assert.match(output.stderr, /TSCONFIG_PARSE_ERROR/);
  assert.match(output.stderr, /tsconfig.json/);
  assert.match(output.stderr, /TS\d+/);
  assert.ok(!output.stderr.includes(root));
  assert.doesNotMatch(output.stderr, /\n\s+at /);
});

test("built CLI still supports no-tsconfig JS-only monorepos", async (t) => {
  const { root, put, cli } = await fixture(t, null);
  for (const file of await scanSourceTree(root)) await rm(file.filePath);
  await put("packages/domain/src/service.js", 'require("@demo/shared"); require("./helper");');
  await put("packages/domain/src/helper.js", "module.exports = {};");
  await put("packages/shared/src/index.js", "module.exports = {};");
  assert.equal(cli().status, 0);
});
