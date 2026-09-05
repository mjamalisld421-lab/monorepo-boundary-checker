import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverWorkspaces } from "../dist/workspaces.js";
import { scanSourceTree } from "../dist/scanner.js";
import { findOwningWorkspace, resolveImportReference, resolveScans } from "../dist/resolver.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mbc-resolver-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    "apps/web/package.json": JSON.stringify({ name: "@demo/web" }),
    "packages/ui/package.json": JSON.stringify({ name: "@demo/ui" }),
    "packages/shared/package.json": JSON.stringify({ name: "shared" }),
    "apps/web/src/page.ts": 'import "@demo/ui/button"; import "react"; import "node:path"; require("./helper"); import "./missing"; import "@demo/ui/button";',
    "apps/web/src/helper.ts": "export {};",
    "apps/web/src/utils/index.ts": "export {};",
    "packages/ui/src/button.ts": 'import "shared";',
    "packages/shared/src/index.ts": "export {};",
    "outside.ts": "export {};",
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const workspaces = await discoverWorkspaces(root);
  const source = path.join(root, "apps/web/src/page.ts");
  const resolve = (specifier) => resolveImportReference(source, { specifier, kind: "import" }, workspaces);
  return { root, workspaces, source, resolve };
}

test("source ownership uses normalized paths and returns its workspace", async (t) => {
  const { source, workspaces } = await fixture(t);
  assert.equal(findOwningWorkspace(path.join(path.dirname(source), "unused/../page.ts"), workspaces)?.name, "@demo/web");
});

test("nested ownership chooses deepest root regardless of input order", async (t) => {
  const { workspaces, source } = await fixture(t);
  const nested = { name: "nested", root: path.dirname(source), packageJsonPath: path.join(path.dirname(source), "package.json") };
  for (const list of [[nested, ...workspaces], [...workspaces, nested]]) {
    assert.equal(findOwningWorkspace(source, list), nested);
  }
});

test("path prefixes do not imply containment", async (t) => {
  const { root, workspaces } = await fixture(t);
  assert.equal(findOwningWorkspace(path.join(root, "apps/webapp/page.ts"), workspaces), null);
});

test("unowned sources produce an explicit unresolved result", async (t) => {
  const { root, workspaces } = await fixture(t);
  const result = await resolveImportReference(path.join(root, "outside.ts"), { specifier: "shared", kind: "require" }, workspaces);
  assert.equal(result.classification, "unresolved");
  assert.equal(result.reason, "no-source-workspace");
  assert.equal(result.sourceWorkspace, null);
});

for (const [specifier, classification, target] of [
  ["./helper.ts", "internal", "@demo/web"],
  ["./helper", "internal", "@demo/web"],
  ["./utils", "internal", "@demo/web"],
  ["../../../packages/ui/src/button", "cross-workspace", "@demo/ui"],
  ["@demo/ui", "cross-workspace", "@demo/ui"],
  ["@demo/ui/button", "cross-workspace", "@demo/ui"],
  ["shared", "cross-workspace", "shared"],
  ["shared/utils", "cross-workspace", "shared"],
  ["@demo/web/page", "internal", "@demo/web"],
  ["react", "external", null],
  ["@babel/parser", "external", null],
  ["@workspace/missing-package", "external", null],
  ["@demo/ui-extra", "external", null],
  ["node:fs", "builtin", null],
  ["fs", "builtin", null],
  ["node:path", "builtin", null],
]) {
  test(`resolves ${specifier} as ${classification}`, async (t) => {
    const { resolve, source } = await fixture(t);
    const result = await resolve(specifier);
    assert.equal(result.classification, classification);
    assert.equal(result.targetWorkspace?.name ?? null, target);
    assert.equal(result.sourceWorkspace.name, "@demo/web");
    assert.equal(result.sourceFile, source);
    assert.equal(result.specifier, specifier);
  });
}

for (const [specifier, reason] of [
  ["./missing", "missing-relative-target"],
  ["../../../outside.ts", "unowned-relative-target"],
  ["@demo/ui/../shared", "unsupported-specifier"],
  ["@demo/ui/", "unsupported-specifier"],
  ["https://example.com/module.js", "unsupported-specifier"],
  ["#alias", "unsupported-specifier"],
  ["node:not-a-real-builtin", "unsupported-specifier"],
]) {
  test(`returns ${reason} for ${specifier}`, async (t) => {
    const { resolve } = await fixture(t);
    const result = await resolve(specifier);
    assert.equal(result.classification, "unresolved");
    assert.equal(result.targetWorkspace, null);
    assert.equal(result.reason, reason);
  });
}

test("relative probes support each source extension", async (t) => {
  const { source, resolve } = await fixture(t);
  for (const extension of ["js", "jsx", "ts", "tsx"]) {
    await writeFile(path.join(path.dirname(source), `target-${extension}.${extension}`), "");
    assert.equal((await resolve(`./target-${extension}`)).classification, "internal");
  }
});

test("ambiguous workspace names do not select an arbitrary target", async (t) => {
  const { source, workspaces } = await fixture(t);
  const result = await resolveImportReference(source, { specifier: "shared", kind: "import" },
    [...workspaces, { ...workspaces[0], name: "shared" }]);
  assert.equal(result.reason, "ambiguous-workspace-name");
});

test("discovery, scanning and resolution preserve order, duplicates and classifications", async (t) => {
  const { root, workspaces } = await fixture(t);
  const scans = await scanSourceTree(root);
  const first = await resolveScans(scans, workspaces);
  assert.deepEqual(await resolveScans(scans, workspaces), first);
  assert.deepEqual(first.map((r) => [r.sourceWorkspace.name, r.targetWorkspace?.name ?? null, r.classification, r.kind]), [
    ["@demo/web", "@demo/ui", "cross-workspace", "import"],
    ["@demo/web", null, "external", "import"],
    ["@demo/web", null, "builtin", "import"],
    ["@demo/web", "@demo/web", "internal", "require"],
    ["@demo/web", null, "unresolved", "import"],
    ["@demo/web", "@demo/ui", "cross-workspace", "import"],
    ["@demo/ui", "shared", "cross-workspace", "import"],
  ]);
});
