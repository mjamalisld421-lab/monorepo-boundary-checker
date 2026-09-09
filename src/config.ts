import { readFile } from "node:fs/promises";
import path from "node:path";
import validatePackageName from "validate-npm-package-name";
import type { Workspace } from "./workspaces.js";

export const DEFAULT_CONFIG_FILENAME = "monorepo-boundary.config.json";

export type BoundaryConfig = {
  boundaries: Readonly<Record<string, readonly string[]>>;
};

export type BoundaryConfigErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_READ_ERROR"
  | "CONFIG_PARSE_ERROR"
  | "CONFIG_INVALID_STRUCTURE"
  | "CONFIG_DUPLICATE_TARGET"
  | "CONFIG_UNKNOWN_SOURCE"
  | "CONFIG_UNKNOWN_TARGET";

export class BoundaryConfigError extends Error {
  readonly configPath: string | undefined;

  constructor(
    readonly code: BoundaryConfigErrorCode,
    message: string,
    configPath?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BoundaryConfigError";
    this.configPath = configPath === undefined ? undefined : path.resolve(configPath);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackageName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("*") &&
    validatePackageName(value).validForOldPackages;
}

/** Validate JSON structure and copy target lists; never coerce names or values. */
export function validateBoundaryConfig(value: unknown, configPath?: string): BoundaryConfig {
  const invalid = (message: string): never => {
    throw new BoundaryConfigError("CONFIG_INVALID_STRUCTURE", message, configPath);
  };
  if (!isObject(value) || !Object.hasOwn(value, "boundaries") || !isObject(value.boundaries)) {
    return invalid("Configuration must be an object with a boundaries object.");
  }
  const entries: [string, string[]][] = [];
  for (const [source, targets] of Object.entries(value.boundaries)) {
    if (!isPackageName(source)) return invalid(`Invalid source package name: ${JSON.stringify(source)}`);
    if (!Array.isArray(targets)) return invalid(`Targets for ${source} must be an array.`);
    const allowed: string[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      if (!isPackageName(target)) return invalid(`Invalid target package name in rule for ${source}: ${JSON.stringify(target)}`);
      if (seen.has(target)) {
        throw new BoundaryConfigError("CONFIG_DUPLICATE_TARGET", `Duplicate target ${target} in rule for ${source}.`, configPath);
      }
      seen.add(target);
      allowed.push(target);
    }
    entries.push([source, allowed]);
  }
  return { boundaries: Object.fromEntries(entries) };
}

/** Validate exact discovered names. Missing source rules are evaluated separately. */
export function validateBoundaryWorkspaces(
  config: BoundaryConfig, workspaces: readonly Workspace[], configPath?: string,
): void {
  const names = new Set(workspaces.map((workspace) => workspace.name));
  for (const [source, targets] of Object.entries(config.boundaries)) {
    if (!names.has(source)) {
      throw new BoundaryConfigError("CONFIG_UNKNOWN_SOURCE", `Unknown source workspace: ${source}`, configPath);
    }
    for (const target of targets) {
      if (!names.has(target)) {
        throw new BoundaryConfigError("CONFIG_UNKNOWN_TARGET", `Unknown target workspace ${target} in rule for ${source}.`, configPath);
      }
    }
  }
}

/** Load only the supplied JSON file. Optional workspace validation uses exact names. */
export async function loadBoundaryConfig(
  configPath: string, workspaces?: readonly Workspace[],
): Promise<BoundaryConfig> {
  const absolutePath = path.resolve(configPath);
  let contents: string;
  try {
    contents = await readFile(absolutePath, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new BoundaryConfigError(missing ? "CONFIG_NOT_FOUND" : "CONFIG_READ_ERROR",
      `Unable to read boundary configuration: ${absolutePath}`, absolutePath, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new BoundaryConfigError("CONFIG_PARSE_ERROR", `Invalid JSON in boundary configuration: ${absolutePath}`, absolutePath, error);
  }
  const config = validateBoundaryConfig(parsed, absolutePath);
  if (workspaces !== undefined) validateBoundaryWorkspaces(config, workspaces, absolutePath);
  return config;
}
