import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createJsonError, createJsonReport, formatJsonError, formatJsonReport } from "../dist/reporter.js";
import { runBoundaryCheck } from "../dist/check.js";
import { copyFixture, executeCli, linkFixtureRoot } from "./helpers/fixtures.mjs";

function executeJson(root, args = ["--json"]) {
  const result = executeCli(root, args);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n"));
  const document = JSON.parse(result.stdout);
  assert.ok(!result.stdout.includes("Monorepo Boundary Checker"));
  return { result, document };
}

test("clean JSON is one successful document with stable empty collections", async (t) => {
  const root = await copyFixture(t, "clean");
  const { result, document } = executeJson(root);
  assert.equal(result.status, 0);
  assert.deepEqual(document, {
    ok: true,
    summary: { workspaces: 4, crossWorkspaceImports: 5, violations: 0,
      missingSourceRules: 0, unresolved: 0 },
    violations: [], missingSourceRules: [], unresolved: [],
  });
});

test("violation JSON retains ordered details, reasons, and relative paths", async (t) => {
  const root = await copyFixture(t, "violations");
  const { result, document } = executeJson(root);
  assert.equal(result.status, 1);
  assert.equal(document.ok, false);
  assert.deepEqual(document.summary, { workspaces: 3, crossWorkspaceImports: 2,
    violations: 2, missingSourceRules: 0, unresolved: 0 });
  assert.deepEqual(document.violations.map((entry) => ({
    source: entry.sourceWorkspace, target: entry.targetWorkspace, file: entry.file,
    specifier: entry.specifier, kind: entry.importKind, reason: entry.reason,
  })), [
    { source: "@fixture/domain", target: "@fixture/database",
      file: "packages/domain/src/service.ts", specifier: "@fixture/database/client",
      kind: "import", reason: "target-not-allowed" },
    { source: "@fixture/shared", target: "@fixture/domain",
      file: "packages/shared/src/index.ts", specifier: "@fixture/domain",
      kind: "require", reason: "target-not-allowed" },
  ]);
  assert.ok(document.violations.every((entry) => !path.isAbsolute(entry.file) && !entry.file.includes("\\")));
});

test("JSON reporting stays project-relative through a symlinked root", async (t) => {
  const physicalRoot = await copyFixture(t, "violations");
  const linkedRoot = await linkFixtureRoot(t, physicalRoot);
  if (linkedRoot === null) return;

  const direct = createJsonReport(await runBoundaryCheck({ rootDirectory: linkedRoot }));
  const { result, document } = executeJson(linkedRoot);

  assert.equal(result.status, 1);
  assert.deepEqual(document.violations, direct.violations);
  assert.equal(document.violations[0].file, "packages/domain/src/service.ts");
  assert.ok(document.violations.every((entry) => !entry.file.startsWith("../")));
  assert.ok(!result.stdout.includes(physicalRoot));
  assert.ok(!result.stdout.includes(linkedRoot));
});

test("source-not-configured has its own JSON collection and reason", async (t) => {
  const root = await copyFixture(t, "clean");
  await writeFile(path.join(root, "monorepo-boundary.config.json"), '{"boundaries":{}}');
  const { result, document } = executeJson(root);
  assert.equal(result.status, 1);
  assert.equal(document.summary.violations, 0);
  assert.equal(document.summary.missingSourceRules, 5);
  assert.equal(document.missingSourceRules.length, 5);
  assert.ok(document.missingSourceRules.every((entry) => entry.reason === "source-not-configured"));
  assert.deepEqual(document.violations, []);
});

test("unresolved JSON is separate and exit 2 overrides an alias violation", async (t) => {
  const root = await copyFixture(t, "aliases");
  const { result, document } = executeJson(root);
  assert.equal(result.status, 2);
  assert.equal(document.ok, false);
  assert.equal(document.summary.violations, 1);
  assert.equal(document.summary.unresolved, 1);
  assert.equal(document.violations[0].reason, "target-not-allowed");
  assert.deepEqual(document.unresolved, [{
    sourceWorkspace: "@fixture/domain",
    file: "packages/domain/src/service.ts",
    specifier: "@broken/missing",
    importKind: "import",
    reason: "alias-target-not-found",
  }]);
});

for (const [label, fixture, mutate, code, file] of [
  ["malformed config", "invalid", null, "CONFIG_PARSE_ERROR", "monorepo-boundary.config.json"],
  ["missing config", "clean", (root) => rm(path.join(root, "monorepo-boundary.config.json")),
    "CONFIG_NOT_FOUND", "monorepo-boundary.config.json"],
  ["source parser", "clean", (root) => writeFile(path.join(root, "apps/web/src/page.ts"), "const value: = ;"),
    "SOURCE_PARSE_ERROR", "apps/web/src/page.ts"],
  ["tsconfig parser", "clean", (root) => writeFile(path.join(root, "tsconfig.json"), "{"),
    "TSCONFIG_PARSE_ERROR", "tsconfig.json"],
]) {
  test(`${label} emits a JSON operational error on stdout`, async (t) => {
    const root = await copyFixture(t, fixture);
    if (mutate) await mutate(root);
    const { result, document } = executeJson(root);
    assert.equal(result.status, 2);
    assert.equal(document.ok, false);
    assert.equal(document.error.code, code);
    assert.equal(document.error.file, file);
    assert.equal(typeof document.error.message, "string");
    assert.ok(document.error.message.length > 0);
    assert.ok(!document.error.message.includes(root));
    assert.doesNotMatch(result.stdout, /\n\s+at /);
  });
}

for (const args of [["--json", "--unknown"], ["--unknown", "--json"],
  ["--json", "--config"], ["--json", "--json"]]) {
  test(`invalid JSON-mode arguments ${args.join(" ")} return a valid coded error`, async (t) => {
    const root = await copyFixture(t, "clean");
    const { result, document } = executeJson(root, args);
    assert.equal(result.status, 2);
    assert.equal(document.error.code, "CLI_ARGUMENT_ERROR");
    assert.match(document.error.message, /argument|file path/i);
    assert.equal(document.error.file, undefined);
  });
}

test("--config and --json work in either order with a cwd-relative path", async (t) => {
  const root = await copyFixture(t, "clean");
  const alternate = path.join(root, "custom", "rules.json");
  await mkdir(path.dirname(alternate), { recursive: true });
  await writeFile(alternate, await readFile(path.join(root, "monorepo-boundary.config.json")));
  await rm(path.join(root, "monorepo-boundary.config.json"));
  const first = executeJson(root, ["--config", "custom/rules.json", "--json"]);
  const second = executeJson(root, ["--json", "--config", "custom/rules.json"]);
  assert.equal(first.result.status, 0);
  assert.deepEqual(first.document, second.document);
  assert.equal(first.result.stdout, second.result.stdout);
});

test("JSON output is deterministic across repeated built-CLI runs", async (t) => {
  const root = await copyFixture(t, "aliases");
  const outputs = Array.from({ length: 3 }, () => executeCli(root, ["--json"]).stdout);
  assert.equal(new Set(outputs).size, 1);
  outputs.forEach((output) => JSON.parse(output));
});

test("duplicate violations remain represented in source order", async (t) => {
  const root = await copyFixture(t, "violations");
  await writeFile(path.join(root, "packages/domain/src/service.ts"),
    'import "@fixture/database/first"; require("@fixture/database/second"); import "@fixture/database/first";');
  await writeFile(path.join(root, "packages/shared/src/index.ts"), "export {};");
  const { document } = executeJson(root);
  assert.equal(document.summary.violations, 3);
  assert.deepEqual(document.violations.map((entry) => [entry.importKind, entry.specifier]), [
    ["import", "@fixture/database/first"], ["require", "@fixture/database/second"],
    ["import", "@fixture/database/first"],
  ]);
});

test("reporter JSON functions are pure structured serialization", async (t) => {
  const root = await copyFixture(t, "clean");
  const result = await runBoundaryCheck({ rootDirectory: root });
  const before = structuredClone(result);
  assert.deepEqual(JSON.parse(formatJsonReport(result)), createJsonReport(result));
  assert.deepEqual(result, before);
});

test("unexpected JSON errors are safe and use a stable fallback code", () => {
  const error = new Error("unexpected disk failure");
  assert.deepEqual(JSON.parse(formatJsonError(error, process.cwd())), createJsonError(error, process.cwd()));
  assert.deepEqual(createJsonError(error, process.cwd()), {
    ok: false, error: { code: "UNEXPECTED_ERROR", message: "unexpected disk failure" },
  });
});

test("JSON errors remove normalized machine-specific root paths", () => {
  const root = path.resolve("project-root");
  const normalizedFile = `${root.split(path.sep).join("/")}/config.json`;
  assert.equal(createJsonError(new Error(`failure in ${normalizedFile}`), root).error.message,
    "failure in config.json");
});

test("human output remains the existing prose format", async (t) => {
  const root = await copyFixture(t, "clean");
  const result = executeCli(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Monorepo Boundary Checker\n\n/);
  assert.match(result.stdout, /No dependency boundary violations found/);
  assert.throws(() => JSON.parse(result.stdout));
});
