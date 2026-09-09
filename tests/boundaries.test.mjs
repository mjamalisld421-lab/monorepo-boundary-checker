import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { BoundaryConfigError, DEFAULT_CONFIG_FILENAME, loadBoundaryConfig,
  validateBoundaryConfig, validateBoundaryWorkspaces } from "../dist/config.js";
import { evaluateBoundaries } from "../dist/boundaries.js";
import { discoverWorkspaces } from "../dist/workspaces.js";
import { scanSourceTree } from "../dist/scanner.js";
import { resolveScans } from "../dist/resolver.js";

async function temp(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mbc-boundaries-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function errorCode(code, configPath) {
  return (error) => {
    assert.ok(error instanceof BoundaryConfigError);
    assert.equal(error.code, code);
    assert.equal(error.configPath, configPath);
    assert.ok(error.message.length > 0);
    return true;
  };
}

test("valid JSON config loads from an explicit path", async (t) => {
  const root = await temp(t);
  const file = path.join(root, DEFAULT_CONFIG_FILENAME);
  const value = { boundaries: { "@demo/domain": ["@demo/shared"] } };
  await writeFile(file, JSON.stringify(value));
  assert.deepEqual(await loadBoundaryConfig(path.relative(process.cwd(), file)), value);
});

test("missing config has a stable code, absolute path and filesystem cause", async (t) => {
  const file = path.join(await temp(t), DEFAULT_CONFIG_FILENAME);
  await assert.rejects(loadBoundaryConfig(file), (error) => {
    errorCode("CONFIG_NOT_FOUND", file)(error);
    assert.equal(error.cause.code, "ENOENT");
    return true;
  });
});

test("malformed JSON preserves the parser cause", async (t) => {
  const file = path.join(await temp(t), DEFAULT_CONFIG_FILENAME);
  await writeFile(file, "{bad json");
  await assert.rejects(loadBoundaryConfig(file), (error) => {
    errorCode("CONFIG_PARSE_ERROR", file)(error);
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

for (const [label, value] of [
  ["null top level", null], ["array top level", []], ["number top level", 3],
  ["boolean top level", true], ["missing boundaries", {}],
  ["null boundaries", { boundaries: null }], ["array boundaries", { boundaries: [] }],
  ["string boundaries", { boundaries: "domain" }],
  ["empty source", { boundaries: { "": [] } }],
  ["invalid source", { boundaries: { "bad name": [] } }],
  ["null targets", { boundaries: { domain: null } }],
  ["object targets", { boundaries: { domain: {} } }],
  ["string targets", { boundaries: { domain: "shared" } }],
  ...[null, 2, true, {}, [], "", " ", "bad name", "@demo/*"].map((value) =>
    [`invalid target ${JSON.stringify(value)}`, { boundaries: { domain: [value] } }]),
]) {
  test(`rejects ${label} with config path`, async (t) => {
    const file = path.join(await temp(t), DEFAULT_CONFIG_FILENAME);
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(loadBoundaryConfig(file), errorCode("CONFIG_INVALID_STRUCTURE", file));
  });
}

test("duplicate targets identify the source and target", () => {
  assert.throws(() => validateBoundaryConfig({ boundaries: { domain: ["shared", "shared"] } }), (error) => {
    errorCode("CONFIG_DUPLICATE_TARGET", undefined)(error);
    assert.match(error.message, /shared.*domain/);
    return true;
  });
});

async function scenario(t) {
  const root = await temp(t);
  const files = {
    "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    "apps/web/src/page.ts": 'import "@demo/ui"; import "react"; import "node:path"; require("./helper"); import "./missing";',
    "apps/web/src/helper.ts": "export {};",
    "packages/ui/src/index.ts": 'import "@demo/shared";',
    "packages/domain/src/index.ts": 'import "@demo/shared"; require("@demo/database"); require("@demo/database");',
    "packages/database/src/index.ts": "export {};",
    "packages/shared/src/index.ts": 'import "@demo/domain";',
  };
  for (const name of ["web", "ui", "domain", "database", "shared"]) {
    files[`${name === "web" ? "apps" : "packages"}/${name}/package.json`] = JSON.stringify({ name: `@demo/${name}` });
  }
  const configValue = { boundaries: {
    "@demo/web": ["@demo/ui", "@demo/shared"], "@demo/ui": ["@demo/shared"],
    "@demo/domain": ["@demo/shared"], "@demo/database": ["@demo/domain", "@demo/shared"],
    "@demo/shared": [],
  } };
  files[DEFAULT_CONFIG_FILENAME] = JSON.stringify(configValue);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const workspaces = await discoverWorkspaces(root);
  const config = await loadBoundaryConfig(path.join(root, DEFAULT_CONFIG_FILENAME), workspaces);
  const relationships = await resolveScans(await scanSourceTree(root), workspaces);
  return { root, config, workspaces, relationships };
}

test("valid rules match exact discovered workspace names", async (t) => {
  const { config, workspaces } = await scenario(t);
  assert.doesNotThrow(() => validateBoundaryWorkspaces(config, workspaces));
});

for (const [label, boundaries, code] of [
  ["unknown source", { "@demo/missing": [] }, "CONFIG_UNKNOWN_SOURCE"],
  ["unknown target", { "@demo/domain": ["react"] }, "CONFIG_UNKNOWN_TARGET"],
  ["alias instead of actual name", { domain: [] }, "CONFIG_UNKNOWN_SOURCE"],
]) {
  test(`rejects ${label} against discovered workspaces`, async (t) => {
    const { root, workspaces } = await scenario(t);
    const file = path.join(root, DEFAULT_CONFIG_FILENAME);
    await writeFile(file, JSON.stringify({ boundaries }));
    await assert.rejects(loadBoundaryConfig(file, workspaces), errorCode(code, file));
  });
}

test("realistic pipeline yields exact allowed, forbidden and skipped architecture results", async (t) => {
  const { config, relationships } = await scenario(t);
  const results = evaluateBoundaries(relationships, config);
  assert.deepEqual(results.map((r) => [r.relationship.specifier, r.status, r.reason ?? null]), [
    ["@demo/ui", "allowed", null], ["react", "skipped", "external"],
    ["node:path", "skipped", "builtin"], ["./helper", "skipped", "internal"],
    ["./missing", "skipped", "unresolved"], ["@demo/shared", "allowed", null],
    ["@demo/database", "violation", "target-not-allowed"],
    ["@demo/database", "violation", "target-not-allowed"],
    ["@demo/domain", "violation", "target-not-allowed"], ["@demo/shared", "allowed", null],
  ]);
  const violation = results[6];
  assert.equal(violation.relationship, relationships[6]);
  assert.equal(violation.relationship.sourceWorkspace.name, "@demo/domain");
  assert.equal(violation.relationship.targetWorkspace.name, "@demo/database");
  assert.equal(violation.relationship.kind, "require");
  assert.ok(violation.relationship.sourceFile.endsWith(path.join("domain", "src", "index.ts")));
  assert.equal(results[4].relationship.reason, "missing-relative-target");
});

test("missing source rule differs from a configured empty list", async (t) => {
  const { relationships } = await scenario(t);
  const cross = relationships.filter((r) => r.classification === "cross-workspace");
  const missing = evaluateBoundaries(cross, validateBoundaryConfig({ boundaries: {} }));
  assert.ok(missing.every((r) => r.status === "source-not-configured" && r.reason === "source-not-configured"));
  const empty = validateBoundaryConfig({ boundaries: { "@demo/web": [] } });
  assert.equal(evaluateBoundaries([cross[0]], empty)[0].status, "violation");
});

test("evaluation is deterministic, preserves duplicates and does not mutate inputs", async (t) => {
  const { config, relationships } = await scenario(t);
  const before = structuredClone({ config, relationships });
  const first = evaluateBoundaries(relationships, config);
  assert.deepEqual(evaluateBoundaries(relationships, config), first);
  assert.equal(first.length, relationships.length);
  assert.deepEqual(first[6], first[7]);
  assert.deepEqual({ config, relationships }, before);
});

test("prototype properties are not configured rules", async (t) => {
  const { relationships } = await scenario(t);
  const config = { boundaries: Object.create({ "@demo/web": ["@demo/ui"] }) };
  assert.equal(evaluateBoundaries([relationships[0]], config)[0].status, "source-not-configured");
});
