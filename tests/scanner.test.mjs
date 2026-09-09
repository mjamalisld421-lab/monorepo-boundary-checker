import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findSourceFiles,
  scanSourceFile,
  scanSourceTree,
  SourceScanError,
} from "../dist/scanner.js";

async function usingSourceTree(files, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "monorepo-scanner-"));

  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents);
    }

    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("discovers JavaScript and TypeScript source files in deterministic order", async () => {
  await usingSourceTree(
    {
      "src/zeta.tsx": "export const Zeta = () => <div />;",
      "src/alpha.js": "export const alpha = true;",
      "src/beta.jsx": "export const Beta = () => <div />;",
      "src/middle.ts": "export const middle: boolean = true;",
      "src/ignored.json": "{}",
      "node_modules/dependency/index.js": "require('ignored');",
      ".git/hooks/example.js": "require('ignored');",
    },
    async (root) => {
      const first = await findSourceFiles(root);
      const second = await findSourceFiles(root);
      const relativePaths = first.map((filePath) => path.relative(root, filePath));

      assert.deepEqual(first, second);
      assert.deepEqual(relativePaths, [
        path.join("src", "alpha.js"),
        path.join("src", "beta.jsx"),
        path.join("src", "middle.ts"),
        path.join("src", "zeta.tsx"),
      ]);
      assert.ok(first.every(path.isAbsolute));
    },
  );
});

test("extracts ES imports including multiline, type-only, and side-effect imports", async () => {
  await usingSourceTree(
    {
      "source.ts": `
        import React, { useMemo } from "react";
        import {
          helper
        } from "@demo/shared";
        import type { User } from "@demo/domain";
        import "@demo/setup";
      `,
    },
    async (root) => {
      const scan = await scanSourceFile(path.join(root, "source.ts"));
      assert.deepEqual(scan.imports, [
        { specifier: "react", kind: "import" },
        { specifier: "@demo/shared", kind: "import" },
        { specifier: "@demo/domain", kind: "import" },
        { specifier: "@demo/setup", kind: "import" },
      ]);
    },
  );
});

test("extracts static package and relative require calls", async () => {
  await usingSourceTree(
    {
      "source.js": `
        const fs = require("node:fs");
        const shared = require("@demo/shared");
        require("./setup");
      `,
    },
    async (root) => {
      const scan = await scanSourceFile(path.join(root, "source.js"));
      assert.deepEqual(scan.imports, [
        { specifier: "node:fs", kind: "require" },
        { specifier: "@demo/shared", kind: "require" },
        { specifier: "./setup", kind: "require" },
      ]);
    },
  );
});

test("ignores import-like text in comments and strings", async () => {
  await usingSourceTree(
    {
      "source.js": `
        // require("fake-comment-package");
        /* import fake from "fake-block-package"; */
        const example = 'require("fake-string-package")';
        const example2 = 'import fake from "another-fake-package"';
        import real from "real-package";
      `,
    },
    async (root) => {
      const scan = await scanSourceFile(path.join(root, "source.js"));
      assert.deepEqual(scan.imports, [{ specifier: "real-package", kind: "import" }]);
    },
  );
});

test("ignores dynamic require expressions", async () => {
  await usingSourceTree(
    {
      "source.js": `
        require(variable);
        require("./" + fileName);
        require(` + "`./${fileName}`" + `);
        require("static-package");
      `,
    },
    async (root) => {
      const scan = await scanSourceFile(path.join(root, "source.js"));
      assert.deepEqual(scan.imports, [
        { specifier: "static-package", kind: "require" },
      ]);
    },
  );
});

test("preserves source order and duplicate specifier occurrences", async () => {
  await usingSourceTree(
    {
      "source.ts": `
        import type { User } from "@demo/shared";
        const setup = require("./setup");
        import { helper } from "@demo/shared";
      `,
    },
    async (root) => {
      const scan = await scanSourceFile(path.join(root, "source.ts"));
      assert.deepEqual(scan.imports, [
        { specifier: "@demo/shared", kind: "import" },
        { specifier: "./setup", kind: "require" },
        { specifier: "@demo/shared", kind: "import" },
      ]);
    },
  );
});

test("scans a source tree in file order", async () => {
  await usingSourceTree(
    {
      "src/z.ts": 'import "z-package";',
      "src/a.ts": 'require("a-package");',
    },
    async (root) => {
      const scans = await scanSourceTree(root);
      assert.deepEqual(
        scans.map(({ filePath }) => path.relative(root, filePath)),
        [path.join("src", "a.ts"), path.join("src", "z.ts")],
      );
      assert.deepEqual(scans.map(({ imports }) => imports), [
        [{ specifier: "a-package", kind: "require" }],
        [{ specifier: "z-package", kind: "import" }],
      ]);
    },
  );
});

test("reports malformed source with a clear file-specific parser error", async () => {
  await usingSourceTree(
    { "src/broken.ts": "const value: = ;" },
    async (root) => {
      const filePath = path.join(root, "src/broken.ts");

      await assert.rejects(() => scanSourceFile(filePath), (error) => {
        assert.ok(error instanceof SourceScanError);
        assert.equal(error.code, "SOURCE_PARSE_ERROR");
        assert.equal(error.filePath, filePath);
        assert.match(error.message, /Unable to parse source file/);
        assert.match(error.message, /broken\.ts/);
        assert.ok(error.cause instanceof Error);
        return true;
      });
    },
  );
});
