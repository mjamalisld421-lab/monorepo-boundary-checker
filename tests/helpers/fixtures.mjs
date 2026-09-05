import assert from "node:assert/strict";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
export const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export async function copyFixture(t, name) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), `mbc-${name}-`)));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo");
  await cp(path.join(fixtures, name), root, { recursive: true });
  return root;
}

export function executeCli(root, args = []) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root, encoding: "utf8", timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
