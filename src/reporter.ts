import path from "node:path";
import type { BoundaryCheckResult } from "./check.js";
import { BoundaryConfigError } from "./config.js";
import { SourceScanError } from "./scanner.js";
import { WorkspaceDiscoveryError } from "./workspaces.js";
import { TypeScriptConfigError } from "./tsconfig.js";

function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}

export function formatHumanReport(result: BoundaryCheckResult): string {
  const lines = ["Monorepo Boundary Checker", ""];
  let violations = 0;
  let missing = 0;
  let unresolved = 0;
  for (const evaluation of result.evaluations) {
    const r = evaluation.relationship;
    if (evaluation.status === "violation" || evaluation.status === "source-not-configured") {
      lines.push(`${r.sourceWorkspace?.name} -> ${r.targetWorkspace?.name}`,
        `  ${relativeFile(result.rootDirectory, r.sourceFile)}`,
        `  ${r.kind}: ${r.specifier}`);
      if (evaluation.status === "violation") {
        violations++;
        lines.push(`  reason: target is not allowed by ${r.sourceWorkspace?.name} (target-not-allowed)`);
      } else {
        missing++;
        lines.push(`  reason: source workspace ${r.sourceWorkspace?.name} has no boundary rule configured (source-not-configured)`);
      }
      lines.push("");
    }
  }
  const warnings = result.evaluations.filter((r) => r.relationship.classification === "unresolved");
  if (warnings.length > 0) {
    lines.push("Resolution warnings (check incomplete):");
    for (const { relationship: r } of warnings) {
      if (r.classification !== "unresolved") continue;
      unresolved++;
      lines.push(`  ${relativeFile(result.rootDirectory, r.sourceFile)}`,
        `    could not resolve: ${r.specifier} (${r.reason})`);
    }
    lines.push("");
  }
  if (result.exitCode === 0) lines.push("No dependency boundary violations found.");
  else lines.push(`Boundary violations: ${violations}`, `Missing source rules: ${missing}`, `Unresolved references: ${unresolved}`);
  lines.push(`Workspaces checked: ${result.workspaceCount}`,
    `Cross-workspace imports checked: ${result.evaluations.filter((r) => r.relationship.classification === "cross-workspace").length}`);
  return lines.join("\n") + "\n";
}

export function formatCheckError(error: unknown, rootDirectory: string): string {
  const root = path.resolve(rootDirectory);
  const shorten = (message: string): string => message.split(root + path.sep).join("")
    .split(root + "/").join("");
  if (error instanceof SourceScanError) {
    const detail = error.cause instanceof Error ? error.cause.message : error.message;
    return `Source scan failed [${error.code}]: ${relativeFile(root, error.filePath)}\n  ${shorten(detail)}\n`;
  }
  if (error instanceof BoundaryConfigError || error instanceof WorkspaceDiscoveryError ||
      error instanceof TypeScriptConfigError) {
    return `Check failed [${error.code}]: ${shorten(error.message)}\n`;
  }
  return `Check failed: ${shorten(error instanceof Error ? error.message : String(error))}\n`;
}
