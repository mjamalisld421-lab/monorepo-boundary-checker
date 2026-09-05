import { realpath, stat } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import validatePackageName from "validate-npm-package-name";

import type { ImportReference, SourceFileScan } from "./scanner.js";
import type { Workspace } from "./workspaces.js";

export type UnresolvedReason =
  | "no-source-workspace"
  | "missing-relative-target"
  | "unowned-relative-target"
  | "unsupported-specifier"
  | "ambiguous-workspace-name";

export type ResolvedReference = {
  sourceFile: string;
  specifier: string;
  kind: ImportReference["kind"];
} & (
  | { classification: "internal" | "cross-workspace"; sourceWorkspace: Workspace; targetWorkspace: Workspace }
  | { classification: "external" | "builtin"; sourceWorkspace: Workspace; targetWorkspace: null }
  | { classification: "unresolved"; sourceWorkspace: Workspace | null; targetWorkspace: null; reason: UnresolvedReason }
);

function contains(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Ownership is lexical containment of normalized absolute paths. Pass canonical
 * paths when working with symlinks, as workspace discovery already does. */
export function findOwningWorkspace(filePath: string, workspaces: readonly Workspace[]): Workspace | null {
  let owner: Workspace | null = null;
  for (const workspace of workspaces) {
    if (contains(workspace.root, filePath) &&
        (owner === null || path.resolve(workspace.root).length > path.resolve(owner.root).length)) {
      owner = workspace;
    }
  }
  return owner;
}

const extensions = [".js", ".jsx", ".ts", ".tsx"];

/** Deliberate source-file probing, not Node/TypeScript module resolution:
 * exact file, appended extensions, then directory indexes. No main/exports,
 * extension substitution, aliases, URLs, or node_modules traversal. */
async function relativeTarget(sourceFile: string, specifier: string): Promise<string | null> {
  const base = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = [base, ...extensions.map((ext) => base + ext),
    ...extensions.map((ext) => path.join(base, `index${ext}`))];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) {
      if (error instanceof Error && "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
      // Preserve unexpected I/O failures rather than disguise them as missing files.
      throw new Error(`Unable to inspect relative import target: ${candidate}`, { cause: error });
    }
  }
  return null;
}

function packageIdentity(specifier: string): string | null {
  if (specifier.includes("\\") || specifier.includes(":") ||
      specifier.includes("?") || specifier.includes("#")) return null;
  const parts = specifier.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return name && validatePackageName(name).validForOldPackages ? name : null;
}

export async function resolveImportReference(
  filePath: string,
  reference: ImportReference,
  workspaces: readonly Workspace[],
): Promise<ResolvedReference> {
  const sourceFile = path.resolve(filePath);
  const sourceWorkspace = findOwningWorkspace(sourceFile, workspaces);
  const base = { sourceFile, specifier: reference.specifier, kind: reference.kind };
  const unresolved = (reason: UnresolvedReason): ResolvedReference => ({
    ...base, sourceWorkspace, targetWorkspace: null, classification: "unresolved", reason,
  });
  if (sourceWorkspace === null) return unresolved("no-source-workspace");
  const { specifier } = reference;
  if (isBuiltin(specifier)) {
    return { ...base, sourceWorkspace, targetWorkspace: null, classification: "builtin" };
  }

  let targetWorkspace: Workspace;
  if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
    if (specifier.includes("?") || specifier.includes("#") || specifier.includes("\\")) {
      return unresolved("unsupported-specifier");
    }
    const target = await relativeTarget(sourceFile, specifier);
    if (target === null) return unresolved("missing-relative-target");
    const owner = findOwningWorkspace(target, workspaces);
    if (owner === null) return unresolved("unowned-relative-target");
    targetWorkspace = owner;
  } else {
    const name = packageIdentity(specifier);
    if (name === null) return unresolved("unsupported-specifier");
    const matches = workspaces.filter((workspace) => workspace.name === name);
    if (matches.length > 1) return unresolved("ambiguous-workspace-name");
    const match = matches[0];
    if (!match) return { ...base, sourceWorkspace, targetWorkspace: null, classification: "external" };
    targetWorkspace = match;
  }
  return {
    ...base, sourceWorkspace, targetWorkspace,
    classification: path.relative(sourceWorkspace.root, targetWorkspace.root) === "" ? "internal" : "cross-workspace",
  };
}

/** Preserve the caller's file order and every Stage 2 occurrence, including duplicates. */
export async function resolveScans(
  scans: readonly SourceFileScan[], workspaces: readonly Workspace[],
): Promise<ResolvedReference[]> {
  const results: ResolvedReference[] = [];
  for (const scan of scans) {
    for (const reference of scan.imports) {
      results.push(await resolveImportReference(scan.filePath, reference, workspaces));
    }
  }
  return results;
}
