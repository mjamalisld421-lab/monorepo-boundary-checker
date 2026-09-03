import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverWorkspaces,
  WorkspaceDiscoveryError,
} from "../dist/workspaces.js";

async function createFixture(rootManifest, workspaceManifests = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "monorepo-boundary-checker-"));
  const rootContents =
    typeof rootManifest === "string" ? rootManifest : JSON.stringify(rootManifest);
  await writeFile(path.join(root, "package.json"), rootContents);

  for (const [relativeRoot, manifest] of Object.entries(workspaceManifests)) {
    const workspaceRoot = path.join(root, relativeRoot);
    await mkdir(workspaceRoot, { recursive: true });

    if (manifest !== null) {
      const contents = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
      await writeFile(path.join(workspaceRoot, "package.json"), contents);
    }
  }

  return root;
}

async function usingFixture(rootManifest, workspaceManifests, run) {
  const root = await createFixture(rootManifest, workspaceManifests);

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertDiscoveryError(action, expectedCode) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof WorkspaceDiscoveryError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test("discovers a single workspace pattern with package names and absolute paths", async () => {
  await usingFixture(
    { private: true, workspaces: ["packages/*"] },
    {
      "packages/shared": { name: "@example/shared" },
      "packages/core": { name: "@example/core" },
    },
    async (root) => {
      const workspaces = await discoverWorkspaces(root);

      assert.deepEqual(
        workspaces.map(({ name }) => name),
        ["@example/core", "@example/shared"],
      );
      assert.deepEqual(
        workspaces.map(({ root: packageRoot }) => packageRoot),
        [path.join(root, "packages/core"), path.join(root, "packages/shared")],
      );
      assert.equal(
        workspaces[0].packageJsonPath,
        path.join(root, "packages/core/package.json"),
      );
      assert.ok(workspaces.every(({ root: packageRoot }) => path.isAbsolute(packageRoot)));
    },
  );
});

test("discovers multiple workspace patterns", async () => {
  await usingFixture(
    { workspaces: ["apps/*", "packages/*"] },
    {
      "packages/shared": { name: "shared" },
      "apps/web": { name: "web" },
    },
    async (root) => {
      const workspaces = await discoverWorkspaces(root);
      assert.deepEqual(workspaces.map(({ name }) => name), ["web", "shared"]);
    },
  );
});

test("returns deterministic results across repeated discovery", async () => {
  await usingFixture(
    { workspaces: ["packages/*"] },
    {
      "packages/zeta": { name: "zeta" },
      "packages/alpha": { name: "alpha" },
      "packages/middle": { name: "middle" },
    },
    async (root) => {
      const first = await discoverWorkspaces(root);
      const second = await discoverWorkspaces(root);
      assert.deepEqual(first, second);
      assert.deepEqual(first.map(({ name }) => name), ["alpha", "middle", "zeta"]);
    },
  );
});

test("deduplicates workspaces matched by overlapping patterns", async () => {
  await usingFixture(
    { workspaces: ["packages/*", "packages/shared"] },
    { "packages/shared": { name: "shared" } },
    async (root) => {
      const workspaces = await discoverWorkspaces(root);
      assert.equal(workspaces.length, 1);
      assert.equal(workspaces[0].name, "shared");
    },
  );
});

test("supports object-style workspace packages", async () => {
  await usingFixture(
    { workspaces: { packages: ["apps/*", "packages/*"] } },
    {
      "apps/api": { name: "api" },
      "packages/domain": { name: "domain" },
    },
    async (root) => {
      const workspaces = await discoverWorkspaces(root);
      assert.deepEqual(workspaces.map(({ name }) => name), ["api", "domain"]);
    },
  );
});

test("fails when the root package.json is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "monorepo-boundary-checker-"));

  try {
    await assertDiscoveryError(
      () => discoverWorkspaces(root),
      "ROOT_PACKAGE_JSON_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails when the root package.json is malformed", async () => {
  await usingFixture("{not-json", {}, async (root) => {
    await assertDiscoveryError(
      () => discoverWorkspaces(root),
      "INVALID_ROOT_PACKAGE_JSON",
    );
  });
});

test("fails when the root has no workspaces configuration", async () => {
  await usingFixture({ private: true }, {}, async (root) => {
    await assertDiscoveryError(() => discoverWorkspaces(root), "MISSING_WORKSPACES");
  });
});

test("fails when the workspaces configuration has an invalid shape", async () => {
  await usingFixture({ workspaces: ["packages/*", 42] }, {}, async (root) => {
    await assertDiscoveryError(() => discoverWorkspaces(root), "INVALID_WORKSPACES");
  });
});

test("fails when a matched workspace has no package.json", async () => {
  await usingFixture(
    { workspaces: ["packages/*"] },
    { "packages/missing": null },
    async (root) => {
      await assertDiscoveryError(
        () => discoverWorkspaces(root),
        "WORKSPACE_PACKAGE_JSON_NOT_FOUND",
      );
    },
  );
});

test("fails when a workspace package.json is malformed", async () => {
  await usingFixture(
    { workspaces: ["packages/*"] },
    { "packages/broken": "{not-json" },
    async (root) => {
      await assertDiscoveryError(
        () => discoverWorkspaces(root),
        "INVALID_WORKSPACE_PACKAGE_JSON",
      );
    },
  );
});

test("fails when a workspace package name is missing or invalid", async () => {
  for (const manifest of [{}, { name: "Invalid Package Name" }]) {
    await usingFixture(
      { workspaces: ["packages/*"] },
      { "packages/invalid": manifest },
      async (root) => {
        await assertDiscoveryError(
          () => discoverWorkspaces(root),
          "INVALID_WORKSPACE_NAME",
        );
      },
    );
  }
});
