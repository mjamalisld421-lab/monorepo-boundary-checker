import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runBoundaryCheck } from "../dist/check.js";
import { discoverWorkspaces } from "../dist/workspaces.js";
import { scanSourceTree } from "../dist/scanner.js";
import { findOwningWorkspace } from "../dist/resolver.js";
import { formatHumanReport } from "../dist/reporter.js";
import { copyFixture, executeCli } from "./helpers/fixtures.mjs";

test("committed clean monorepo runs the full pipeline and built CLI", async (t) => {
  const root = await copyFixture(t, "clean");
  const check = await runBoundaryCheck({ rootDirectory: root });
  assert.equal(check.exitCode, 0);
  assert.equal(check.workspaceCount, 4);
  assert.equal(check.evaluations.filter((e) => e.relationship.classification === "cross-workspace").length, 5);
  assert.ok(check.evaluations.some((e) => e.relationship.kind === "require" && e.status === "skipped"));
  assert.ok(check.evaluations.some((e) => e.relationship.classification === "external"));
  assert.ok(check.evaluations.some((e) => e.relationship.classification === "builtin"));
  assert.ok(!check.evaluations.some((e) => e.relationship.specifier.includes("@fixture/domain")));
  const cli = executeCli(root);
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, "");
  assert.equal(cli.stdout, formatHumanReport(check));
  assert.match(cli.stdout, /No dependency boundary violations found/);
  assert.match(cli.stdout, /Workspaces checked: 4/);
  assert.match(cli.stdout, /Cross-workspace imports checked: 5/);
});

test("committed violation monorepo reports exactly two ordered violations", async (t) => {
  const root = await copyFixture(t, "violations");
  const result = executeCli(root);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Boundary violations: 2/);
  assert.match(result.stdout, /Missing source rules: 0/);
  assert.match(result.stdout, /Unresolved references: 0/);
  assert.equal(result.stdout.split("target-not-allowed").length - 1, 2);
  assert.ok(result.stdout.indexOf("@fixture/domain -> @fixture/database") <
    result.stdout.indexOf("@fixture/shared -> @fixture/domain"));
  assert.match(result.stdout, /packages\/domain\/src\/service.ts/);
  assert.match(result.stdout, /import: @fixture\/database\/client/);
  assert.match(result.stdout, /packages\/shared\/src\/index.ts/);
  assert.match(result.stdout, /require: @fixture\/domain/);
  assert.doesNotMatch(result.stdout, /react|node:fs|\.\/model/);
  assert.ok(!result.stdout.includes(root));
});

test("committed alias monorepo exercises extends, fallbacks, ownership and exit-2 precedence", async (t) => {
  const root = await copyFixture(t, "aliases");
  const check = await runBoundaryCheck({ rootDirectory: root });
  assert.equal(check.exitCode, 2);
  assert.deepEqual(check.evaluations.map((e) => [e.relationship.specifier, e.status]), [
    ["@ui/button", "allowed"], ["@alias/index", "allowed"], ["@db/client", "violation"],
    ["@domain/model", "skipped"], ["@broken/missing", "skipped"],
  ]);
  assert.equal(check.evaluations[3].relationship.classification, "internal");
  assert.equal(check.evaluations[4].relationship.reason, "alias-target-not-found");
  const result = executeCli(root);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /@fixture\/domain -> @fixture\/database/);
  assert.match(result.stdout, /could not resolve: @broken\/missing \(alias-target-not-found\)/);
  assert.match(result.stdout, /Boundary violations: 1/);
  assert.match(result.stdout, /Unresolved references: 1/);
});

test("built CLI output is byte-for-byte deterministic across repeated runs", async (t) => {
  for (const name of ["clean", "violations", "aliases"]) {
    const root = await copyFixture(t, name);
    const runs = Array.from({ length: 3 }, () => executeCli(root));
    assert.ok(runs.every((run) => run.status === runs[0].status &&
      run.stdout === runs[0].stdout && run.stderr === runs[0].stderr));
  }
});

test("duplicate forbidden imports remain separate and source ordered", async (t) => {
  const root = await copyFixture(t, "violations");
  await writeFile(path.join(root, "packages/domain/src/service.ts"),
    'import "@fixture/database/first"; require("@fixture/database/second"); import "@fixture/database/first";');
  await writeFile(path.join(root, "packages/shared/src/index.ts"), "export {};");
  const result = executeCli(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Boundary violations: 3/);
  assert.equal(result.stdout.split("@fixture/domain -> @fixture/database").length - 1, 3);
  const first = result.stdout.indexOf("import: @fixture/database/first");
  const second = result.stdout.indexOf("require: @fixture/database/second");
  const duplicate = result.stdout.indexOf("import: @fixture/database/first", first + 1);
  assert.ok(first < second && second < duplicate);
});

test("nested workspace discovery assigns a shared scanned file to deepest owner", async (t) => {
  const root = await copyFixture(t, "nested");
  const workspaces = await discoverWorkspaces(root);
  assert.deepEqual(workspaces.map((workspace) => workspace.name),
    ["@fixture/application", "@fixture/plugin", "@fixture/foo"]);
  const nestedFile = path.join(root, "packages/plugin/extensions/foo/src/index.ts");
  assert.equal(findOwningWorkspace(nestedFile, workspaces).name, "@fixture/foo");
  assert.equal(findOwningWorkspace(path.join(root, "packages/application/src/index.ts"), workspaces).name,
    "@fixture/application");
  assert.equal(findOwningWorkspace(path.join(root, "packages/app/src/index.ts"), workspaces), null);
  const check = await runBoundaryCheck({ rootDirectory: root });
  assert.equal(check.exitCode, 0);
  assert.equal(check.workspaceCount, 3);
  assert.equal(check.evaluations.length, 1);
  assert.equal(check.evaluations[0].relationship.sourceWorkspace.name, "@fixture/foo");
});

test("symlinked alias target canonicalizes to one workspace when supported", async (t) => {
  const root = await copyFixture(t, "aliases");
  try {
    await symlink(path.join(root, "packages/shared/src"), path.join(root, "linked-shared"),
      process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip(`symlink unavailable: ${error.code}`);
    throw error;
  }
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    paths: { "@link/*": ["linked-shared/*"] },
  } }));
  await writeFile(path.join(root, "packages/domain/src/service.ts"), 'import "@link/index";');
  const check = await runBoundaryCheck({ rootDirectory: root });
  assert.equal(check.exitCode, 0);
  const relationship = check.evaluations.find((e) => e.relationship.specifier === "@link/index").relationship;
  assert.equal(relationship.targetWorkspace.name, "@fixture/shared");
  assert.equal(relationship.classification, "cross-workspace");
});

for (const [label, mutate, code] of [
  ["missing config", (root) => rm(path.join(root, "monorepo-boundary.config.json")), "CONFIG_NOT_FOUND"],
  ["malformed strict config", (root) => writeFile(path.join(root, "monorepo-boundary.config.json"), "{"), "CONFIG_PARSE_ERROR"],
  ["commented strict config", (root) => writeFile(path.join(root, "monorepo-boundary.config.json"),
    '{ // comments are not JSON\n"boundaries":{}}'), "CONFIG_PARSE_ERROR"],
  ["duplicate targets", (root) => writeFile(path.join(root, "monorepo-boundary.config.json"), JSON.stringify({
    boundaries: { "@fixture/web": ["@fixture/ui", "@fixture/ui"] },
  })), "CONFIG_DUPLICATE_TARGET"],
  ["unknown source", (root) => writeFile(path.join(root, "monorepo-boundary.config.json"), JSON.stringify({
    boundaries: { "@fixture/absent": [] },
  })), "CONFIG_UNKNOWN_SOURCE"],
  ["unknown target", (root) => writeFile(path.join(root, "monorepo-boundary.config.json"), JSON.stringify({
    boundaries: { "@fixture/web": ["@fixture/absent"] },
  })), "CONFIG_UNKNOWN_TARGET"],
]) {
  test(`${label} is a distinct built-CLI operational failure`, async (t) => {
    const root = await copyFixture(t, "clean");
    await mutate(root);
    const result = executeCli(root);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(code));
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.ok(!result.stderr.includes(root));
  });
}

test("committed malformed fixture remains an operational failure", async (t) => {
  const result = executeCli(await copyFixture(t, "invalid"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CONFIG_PARSE_ERROR/);
});

test("empty target lists cause violations while missing source rules stay distinct", async (t) => {
  const root = await copyFixture(t, "clean");
  await writeFile(path.join(root, "monorepo-boundary.config.json"), JSON.stringify({ boundaries: {
    "@fixture/web": [], "@fixture/ui": [], "@fixture/domain": [],
  } }));
  const empty = executeCli(root);
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /Boundary violations: 5/);
  await writeFile(path.join(root, "monorepo-boundary.config.json"), JSON.stringify({ boundaries: {} }));
  const missing = executeCli(root);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Boundary violations: 0/);
  assert.match(missing.stdout, /Missing source rules: 5/);
  assert.match(missing.stdout, /source-not-configured/);
});

for (const [label, mutate, code] of [
  ["source parse error", (root) => writeFile(path.join(root, "apps/web/src/page.ts"), "const x: = ;"), "SOURCE_PARSE_ERROR"],
  ["unresolved local import", (root) => writeFile(path.join(root, "apps/web/src/page.ts"), 'import "./missing";'), null],
  ["tsconfig parse error", (root) => writeFile(path.join(root, "tsconfig.json"), "{"), "TSCONFIG_PARSE_ERROR"],
]) {
  test(`${label} exits 2 through the complete pipeline`, async (t) => {
    const root = await copyFixture(t, "clean");
    await mutate(root);
    const result = executeCli(root);
    assert.equal(result.status, 2);
    assert.match(code ? result.stderr : result.stdout, new RegExp(code ?? "missing-relative-target"));
  });
}

test("invalid CLI arguments exit 2 without reading the fixture", async (t) => {
  const root = await copyFixture(t, "clean");
  const result = executeCli(root, ["--json"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown argument/);
});

test("unreadable tsconfig shape exits 2 with a typed read error", async (t) => {
  const root = await copyFixture(t, "clean");
  await rm(path.join(root, "tsconfig.json"));
  await mkdir(path.join(root, "tsconfig.json"));
  const result = executeCli(root);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /TSCONFIG_READ_ERROR/);
});

test("relative and absolute alternate config paths resolve from process.cwd", async (t) => {
  for (const absolute of [false, true]) {
    const root = await copyFixture(t, "clean");
    const config = path.join(root, "custom", "rules.json");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, await readFile(path.join(root, "monorepo-boundary.config.json")));
    await rm(path.join(root, "monorepo-boundary.config.json"));
    const result = executeCli(root, ["--config", absolute ? config : "custom/rules.json"]);
    assert.equal(result.status, 0);
  }
});

test("workspace tsconfig takes precedence and root tsconfig otherwise falls back", async (t) => {
  const root = await copyFixture(t, "aliases");
  await writeFile(path.join(root, "packages/domain/tsconfig.json"), JSON.stringify({ compilerOptions: {
    paths: { "@local": ["src/model.ts"] },
  } }));
  await writeFile(path.join(root, "packages/domain/src/service.ts"), 'import "@local"; import "@db/client";');
  const check = await runBoundaryCheck({ rootDirectory: root });
  const local = check.evaluations.find((e) => e.relationship.specifier === "@local").relationship;
  const unavailableRootAlias = check.evaluations.find((e) => e.relationship.specifier === "@db/client").relationship;
  assert.equal(local.classification, "internal");
  assert.equal(unavailableRootAlias.classification, "external");
  assert.equal(check.evaluations.find((e) => e.relationship.specifier === "@ui/button").status, "allowed");
});

test("exact and longest wildcard alias precedence work in a full check", async (t) => {
  const root = await copyFixture(t, "aliases");
  const configPath = path.join(root, "tsconfig.json");
  await writeFile(configPath, JSON.stringify({ compilerOptions: { paths: {
    "@*": ["packages/database/src/*"],
    "@alias/*": ["packages/shared/src/*"],
    "@alias/specific/*": ["packages/ui/src/*"],
    "@alias/exact": ["packages/domain/src/model.ts"],
  } } }));
  await rm(path.join(root, "apps/web/tsconfig.json"));
  await writeFile(path.join(root, "apps/web/src/page.ts"), "export {};");
  await writeFile(path.join(root, "packages/domain/src/service.ts"),
    'import "@alias/index"; import "@alias/specific/button"; import "@alias/exact";');
  const check = await runBoundaryCheck({ rootDirectory: root });
  assert.deepEqual(check.evaluations.map((e) => [e.relationship.specifier,
    e.relationship.targetWorkspace?.name, e.relationship.classification]), [
    ["@alias/index", "@fixture/shared", "cross-workspace"],
    ["@alias/specific/button", "@fixture/ui", "cross-workspace"],
    ["@alias/exact", "@fixture/domain", "internal"],
  ]);
});

test("no-tsconfig JavaScript-only fixture remains supported", async (t) => {
  const root = await copyFixture(t, "clean");
  await rm(path.join(root, "tsconfig.json"));
  for (const scan of await scanSourceTree(root)) await rm(scan.filePath);
  await writeFile(path.join(root, "apps/web/src/page.js"), 'require("@fixture/ui"); require("./helper");');
  await writeFile(path.join(root, "apps/web/src/helper.js"), "module.exports = {};");
  await writeFile(path.join(root, "packages/ui/src/index.js"), 'require("@fixture/shared");');
  await writeFile(path.join(root, "packages/domain/src/service.js"), 'require("@fixture/shared");');
  await writeFile(path.join(root, "packages/shared/src/index.js"), "module.exports = {};");
  const result = executeCli(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Cross-workspace imports checked: 3/);
});
