import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import fastGlob from "fast-glob";
import validatePackageName from "validate-npm-package-name";

export type Workspace = {
  name: string;
  root: string;
  packageJsonPath: string;
};

export type WorkspaceDiscoveryErrorCode =
  | "ROOT_PACKAGE_JSON_NOT_FOUND"
  | "INVALID_ROOT_PACKAGE_JSON"
  | "MISSING_WORKSPACES"
  | "INVALID_WORKSPACES"
  | "WORKSPACE_PATTERN_ERROR"
  | "WORKSPACE_PACKAGE_JSON_NOT_FOUND"
  | "INVALID_WORKSPACE_PACKAGE_JSON"
  | "INVALID_WORKSPACE_NAME";

export class WorkspaceDiscoveryError extends Error {
  readonly code: WorkspaceDiscoveryErrorCode;

  constructor(code: WorkspaceDiscoveryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceDiscoveryError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readManifest(
  packageJsonPath: string,
  kind: "root" | "workspace",
): Promise<JsonObject> {
  let contents: string;

  try {
    contents = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const code =
        kind === "root"
          ? "ROOT_PACKAGE_JSON_NOT_FOUND"
          : "WORKSPACE_PACKAGE_JSON_NOT_FOUND";
      throw new WorkspaceDiscoveryError(
        code,
        `${kind === "root" ? "Root" : "Workspace"} package.json not found: ${packageJsonPath}`,
        error,
      );
    }

    throw error;
  }

  let manifest: unknown;

  try {
    manifest = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    const code =
      kind === "root"
        ? "INVALID_ROOT_PACKAGE_JSON"
        : "INVALID_WORKSPACE_PACKAGE_JSON";
    throw new WorkspaceDiscoveryError(
      code,
      `${kind === "root" ? "Root" : "Workspace"} package.json contains invalid JSON: ${packageJsonPath}`,
      error,
    );
  }

  if (!isJsonObject(manifest)) {
    const code =
      kind === "root"
        ? "INVALID_ROOT_PACKAGE_JSON"
        : "INVALID_WORKSPACE_PACKAGE_JSON";
    throw new WorkspaceDiscoveryError(
      code,
      `${kind === "root" ? "Root" : "Workspace"} package.json must contain a JSON object: ${packageJsonPath}`,
    );
  }

  return manifest;
}

function getWorkspacePatterns(rootManifest: JsonObject): string[] {
  if (!("workspaces" in rootManifest)) {
    throw new WorkspaceDiscoveryError(
      "MISSING_WORKSPACES",
      "Root package.json does not define a workspaces field.",
    );
  }

  const { workspaces } = rootManifest;
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : isJsonObject(workspaces) && Array.isArray(workspaces.packages)
      ? workspaces.packages
      : undefined;

  if (
    patterns === undefined ||
    patterns.some(
      (pattern): boolean => typeof pattern !== "string" || pattern.trim().length === 0,
    )
  ) {
    throw new WorkspaceDiscoveryError(
      "INVALID_WORKSPACES",
      "Root package.json workspaces must be an array of non-empty strings or an object with a packages array of non-empty strings.",
    );
  }

  return patterns;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalKey(packageRoot: string): string {
  return process.platform === "win32" ? packageRoot.toLowerCase() : packageRoot;
}

export async function discoverWorkspaces(rootDirectory: string): Promise<Workspace[]> {
  const absoluteRoot = path.resolve(rootDirectory);
  const rootPackageJsonPath = path.join(absoluteRoot, "package.json");
  const rootManifest = await readManifest(rootPackageJsonPath, "root");
  const patterns = getWorkspacePatterns(rootManifest);

  let matchedDirectories: string[];

  try {
    matchedDirectories = await fastGlob(patterns, {
      absolute: true,
      cwd: absoluteRoot,
      dot: true,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**"],
      onlyDirectories: true,
      unique: true,
    });
  } catch (error) {
    throw new WorkspaceDiscoveryError(
      "WORKSPACE_PATTERN_ERROR",
      `Unable to resolve workspace patterns from: ${rootPackageJsonPath}`,
      error,
    );
  }

  const packageRootsByIdentity = new Map<string, string>();

  for (const matchedDirectory of matchedDirectories) {
    const packageRoot = await realpath(matchedDirectory);
    packageRootsByIdentity.set(canonicalKey(packageRoot), packageRoot);
  }

  const packageRoots = [...packageRootsByIdentity.values()].sort(comparePaths);
  const workspaces: Workspace[] = [];

  for (const packageRoot of packageRoots) {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const manifest = await readManifest(packageJsonPath, "workspace");
    const name = manifest.name;

    if (typeof name !== "string" || !validatePackageName(name).validForOldPackages) {
      throw new WorkspaceDiscoveryError(
        "INVALID_WORKSPACE_NAME",
        `Workspace package.json must contain a valid npm package name: ${packageJsonPath}`,
      );
    }

    workspaces.push({ name, root: packageRoot, packageJsonPath });
  }

  return workspaces;
}
