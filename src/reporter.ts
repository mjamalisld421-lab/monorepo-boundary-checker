import path from "node:path";
import type { BoundaryCheckResult } from "./check.js";
import { BoundaryConfigError } from "./config.js";
import { SourceScanError } from "./scanner.js";
import { WorkspaceDiscoveryError } from "./workspaces.js";
import { TypeScriptConfigError } from "./tsconfig.js";

function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}

function shortenMessage(rootDirectory: string, message: string): string {
  const root = path.resolve(rootDirectory);
  const normalizedRoot = root.split(path.sep).join("/");
  return message.split(root + path.sep).join("").split(root + "/").join("")
    .split(normalizedRoot + "/").join("");
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

type JsonRelationship = {
  sourceWorkspace: string;
  targetWorkspace: string;
  file: string;
  specifier: string;
  importKind: "import" | "require";
  reason: "target-not-allowed" | "source-not-configured";
};

export type JsonCheckReport = {
  ok: boolean;
  summary: {
    workspaces: number;
    crossWorkspaceImports: number;
    violations: number;
    missingSourceRules: number;
    unresolved: number;
  };
  violations: JsonRelationship[];
  missingSourceRules: JsonRelationship[];
  unresolved: Array<{
    sourceWorkspace: string | null;
    file: string;
    specifier: string;
    importKind: "import" | "require";
    reason: string;
  }>;
};

/** Serialize an existing check result only; discovery and evaluation stay in the
 * orchestration layer. Input order and duplicate occurrences are preserved. */
export function createJsonReport(result: BoundaryCheckResult): JsonCheckReport {
  const violations: JsonRelationship[] = [];
  const missingSourceRules: JsonRelationship[] = [];
  const unresolved: JsonCheckReport["unresolved"] = [];
  let crossWorkspaceImports = 0;
  for (const evaluation of result.evaluations) {
    const relationship = evaluation.relationship;
    if (relationship.classification === "cross-workspace") crossWorkspaceImports++;
    if (evaluation.status === "violation" || evaluation.status === "source-not-configured") {
      if (relationship.classification !== "cross-workspace") continue;
      const entry: JsonRelationship = {
        sourceWorkspace: relationship.sourceWorkspace.name,
        targetWorkspace: relationship.targetWorkspace.name,
        file: relativeFile(result.rootDirectory, relationship.sourceFile),
        specifier: relationship.specifier,
        importKind: relationship.kind,
        reason: evaluation.reason,
      };
      (evaluation.status === "violation" ? violations : missingSourceRules).push(entry);
    } else if (relationship.classification === "unresolved") {
      unresolved.push({
        sourceWorkspace: relationship.sourceWorkspace?.name ?? null,
        file: relativeFile(result.rootDirectory, relationship.sourceFile),
        specifier: relationship.specifier,
        importKind: relationship.kind,
        reason: relationship.reason,
      });
    }
  }
  return {
    ok: result.exitCode === 0,
    summary: {
      workspaces: result.workspaceCount,
      crossWorkspaceImports,
      violations: violations.length,
      missingSourceRules: missingSourceRules.length,
      unresolved: unresolved.length,
    },
    violations,
    missingSourceRules,
    unresolved,
  };
}

export function formatJsonReport(result: BoundaryCheckResult): string {
  return JSON.stringify(createJsonReport(result), null, 2) + "\n";
}

export type JsonErrorReport = {
  ok: false;
  error: { code: string; message: string; file?: string };
};

export function createJsonError(error: unknown, rootDirectory: string): JsonErrorReport {
  const root = path.resolve(rootDirectory);
  let code = "UNEXPECTED_ERROR";
  let message = error instanceof Error ? error.message : String(error);
  let file: string | undefined;
  if (error instanceof SourceScanError) {
    code = error.code;
    file = relativeFile(root, error.filePath);
    message = error.cause instanceof Error ? error.cause.message : error.message;
  } else if (error instanceof BoundaryConfigError) {
    code = error.code;
    if (error.configPath !== undefined) file = relativeFile(root, error.configPath);
  } else if (error instanceof TypeScriptConfigError) {
    code = error.code;
    file = relativeFile(root, error.configPath);
  } else if (error instanceof WorkspaceDiscoveryError) {
    code = error.code;
  } else if (error instanceof Error && "code" in error && typeof error.code === "string") {
    code = error.code;
  }
  return { ok: false, error: {
    code,
    message: shortenMessage(root, message),
    ...(file === undefined ? {} : { file }),
  } };
}

export function formatJsonError(error: unknown, rootDirectory: string): string {
  return JSON.stringify(createJsonError(error, rootDirectory), null, 2) + "\n";
}

export function formatCheckError(error: unknown, rootDirectory: string): string {
  const root = path.resolve(rootDirectory);
  const shorten = (message: string): string => shortenMessage(root, message);
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
