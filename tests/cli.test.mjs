import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runBoundaryCheck } from "../dist/check.js";
import { formatHumanReport, formatCheckError } from "../dist/reporter.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function fixture(t, source = 'import "@demo/ui";', boundaries = { "@demo/web": ["@demo/ui"], "@demo/ui": [] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mbc-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    "apps/web/package.json": JSON.stringify({ name: "@demo/web" }),
    "packages/ui/package.json": JSON.stringify({ name: "@demo/ui" }),
    "apps/web/src/page.ts": source,
    "apps/web/src/helper.ts": "export {};",
    "monorepo-boundary.config.json": JSON.stringify({ boundaries }),
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  return root;
}
function execute(root, args = []) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test("built CLI uses cwd and produces concise success output", async (t) => {
  const root = await fixture(t);
  const result = execute(root);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "Monorepo Boundary Checker\n\nNo dependency boundary violations found.\nWorkspaces checked: 2\nCross-workspace imports checked: 1\n");
  assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node/);
});

for (const [label, source] of [["internal", 'import "./helper";'], ["external", 'import "react";'], ["builtin", 'import "node:path";']]) {
  test(`${label} imports alone succeed without individual noise`, async (t) => {
    const result = execute(await fixture(t, source));
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Cross-workspace imports checked: 0/);
    assert.doesNotMatch(result.stdout, /helper|react|node:path/);
  });
}

test("duplicate violations retain file, specifier, reason, order and exit 1", async (t) => {
  const root = await fixture(t, 'require("@demo/ui/button"); require("@demo/ui/button");', { "@demo/web": [] });
  const result = execute(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Boundary violations: 2/);
  assert.equal(result.stdout.split("@demo/web -> @demo/ui").length - 1, 2);
  assert.match(result.stdout, /apps\/web\/src\/page.ts/);
  assert.match(result.stdout, /require: @demo\/ui\/button/);
  assert.match(result.stdout, /target is not allowed by @demo\/web/);
  assert.ok(!result.stdout.includes(root));
  const run = await runBoundaryCheck({ rootDirectory: root });
  assert.equal(formatHumanReport(run), result.stdout);
  assert.equal(execute(root).stdout, result.stdout);
});

test("missing source rule is distinct and returns 1", async (t) => {
  const result = execute(await fixture(t, 'import "@demo/ui";', {}));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /source-not-configured/);
  assert.match(result.stdout, /has no boundary rule configured/);
  assert.match(result.stdout, /Boundary violations: 0/);
  assert.doesNotMatch(result.stdout, /target-not-allowed/);
});

for (const [label, contents, code] of [
  ["missing", null, "CONFIG_NOT_FOUND"], ["malformed", "{", "CONFIG_PARSE_ERROR"],
  ["unknown target", JSON.stringify({ boundaries: { "@demo/web": ["absent"] } }), "CONFIG_UNKNOWN_TARGET"],
]) {
  test(`${label} config returns operational exit 2`, async (t) => {
    const root = await fixture(t);
    const config = path.join(root, "monorepo-boundary.config.json");
    if (contents === null) await rm(config); else await writeFile(config, contents);
    const result = execute(root);
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(code));
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(root));
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
}

test("scan parse failure has relative file and parser details", async (t) => {
  const result = execute(await fixture(t, "const x: = ;"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /SOURCE_PARSE_ERROR/);
  assert.match(result.stderr, /apps\/web\/src\/page.ts/);
  assert.match(result.stderr, /Unexpected token/);
});

for (const withViolation of [false, true]) {
  test(`unresolved import returns 2, including mixed violations=${withViolation}`, async (t) => {
    const root = await fixture(t, 'import "./missing";' + (withViolation ? 'import "@demo/ui";' : ''), { "@demo/web": [] });
    const result = execute(root);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /could not resolve: .\/missing/);
    assert.match(result.stdout, new RegExp(`Boundary violations: ${withViolation ? 1 : 0}`));
    assert.match(result.stdout, /Unresolved references: 1/);
    assert.doesNotMatch(result.stdout, /No dependency boundary violations found/);
  });
}

for (const absolute of [false, true]) {
  test(`explicit config path works, absolute=${absolute}`, async (t) => {
    const root = await fixture(t);
    const defaultFile = path.join(root, "monorepo-boundary.config.json");
    await mkdir(path.join(root, "config"));
    const alternate = path.join(root, "config", "rules.json");
    await writeFile(alternate, await readFile(defaultFile));
    await rm(defaultFile);
    assert.equal(execute(root, ["--config", absolute ? alternate : "config/rules.json"]).status, 0);
  });
}

for (const args of [["--config"], ["--config", "--unknown"], ["--json"], ["--config", "x", "extra"]]) {
  test(`invalid arguments ${args.join(" ")} return 2`, async (t) => {
    const result = execute(await fixture(t), args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires a file path|Unknown argument|Unexpected argument/);
  });
}

test("unexpected errors retain useful message without stack", () => {
  const error = new Error("disk failure", { cause: new Error("underlying") });
  assert.equal(formatCheckError(error, process.cwd()), "Check failed: disk failure\n");
  assert.equal(error.cause.message, "underlying");
});

test("realistic five-workspace fixture reports exactly two architecture violations", async (t) => {
  const root = await fixture(t, 'import "@demo/ui"; import "react"; import "node:path"; import "./helper";');
  for (const [name, source] of [["ui", 'import "@demo/shared";'], ["domain", 'import "@demo/database";'], ["database", ""], ["shared", 'import "@demo/domain";']]) {
    const dir = path.join(root, "packages", name);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: `@demo/${name}` }));
    await writeFile(path.join(dir, "src/index.ts"), source);
  }
  await writeFile(path.join(root, "monorepo-boundary.config.json"), JSON.stringify({ boundaries: {
    "@demo/web": ["@demo/ui", "@demo/shared"], "@demo/ui": ["@demo/shared"],
    "@demo/domain": ["@demo/shared"], "@demo/database": ["@demo/domain", "@demo/shared"], "@demo/shared": [],
  } }));
  const result = execute(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Boundary violations: 2/);
  assert.match(result.stdout, /Workspaces checked: 5/);
  assert.match(result.stdout, /Cross-workspace imports checked: 4/);
  assert.doesNotMatch(result.stdout, /react|node:path|helper/);
  assert.ok(result.stdout.indexOf("@demo/domain ->") < result.stdout.indexOf("@demo/shared ->"));
});
