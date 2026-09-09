import path from "node:path";
import { discoverWorkspaces } from "./workspaces.js";
import { findSourceFiles, scanSourceFile } from "./scanner.js";
import { resolveScans } from "./resolver.js";
import { DEFAULT_CONFIG_FILENAME, loadBoundaryConfig } from "./config.js";
import { evaluateBoundaries, type BoundaryEvaluation } from "./boundaries.js";

export type BoundaryCheckResult = {
  rootDirectory: string;
  workspaceCount: number;
  evaluations: BoundaryEvaluation[];
  exitCode: 0 | 1 | 2;
};

export async function runBoundaryCheck(options: {
  rootDirectory: string; configPath?: string;
}): Promise<BoundaryCheckResult> {
  const rootDirectory = path.resolve(options.rootDirectory);
  const workspaces = await discoverWorkspaces(rootDirectory);
  const config = await loadBoundaryConfig(
    path.resolve(rootDirectory, options.configPath ?? DEFAULT_CONFIG_FILENAME), workspaces,
  );
  // Nested workspace scans can overlap; scan each source file once, retaining
  // all syntactic occurrences within it.
  const files = new Set<string>();
  for (const workspace of workspaces) {
    for (const file of await findSourceFiles(workspace.root)) files.add(file);
  }
  const scans = [];
  for (const file of [...files].sort()) scans.push(await scanSourceFile(file));
  const evaluations = evaluateBoundaries(await resolveScans(scans, workspaces, { rootDirectory }), config);
  const uncertain = evaluations.some((r) => r.relationship.classification === "unresolved");
  const failed = evaluations.some((r) => r.status === "violation" || r.status === "source-not-configured");
  return { rootDirectory, workspaceCount: workspaces.length, evaluations,
    exitCode: uncertain ? 2 : failed ? 1 : 0 };
}
