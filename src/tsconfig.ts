import { stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export class TypeScriptConfigError extends Error {
  constructor(
    readonly code: "TSCONFIG_READ_ERROR" | "TSCONFIG_PARSE_ERROR",
    readonly configPath: string,
    detail: string,
    cause?: unknown,
  ) {
    super(`TypeScript configuration ${configPath}: ${detail}`, { cause });
    this.name = "TypeScriptConfigError";
  }
}

type ResolutionConfig = {
  baseUrl: string | undefined;
  pathsRoot: string;
  paths: Record<string, string[]>;
};

function parseConfig(configPath: string): ResolutionConfig {
  const diagnostics: ts.Diagnostic[] = [];
  // TS expects normalized slash paths when attaching JSON syntax diagnostics.
  const compilerPath = configPath.split(path.sep).join("/");
  const read = ts.readConfigFile(compilerPath, ts.sys.readFile);
  if (read.error) diagnostics.push(read.error);
  const parsed = read.error ? undefined : ts.parseJsonConfigFileContent(read.config, {
    ...ts.sys,
    // We need configuration, not TS's compilation file set. Source discovery
    // remains Stage 2's responsibility; avoid a second recursive traversal.
    readDirectory: () => [],
  }, path.dirname(configPath), undefined, compilerPath);
  diagnostics.push(...(parsed?.errors ?? []));
  // Empty input lists are irrelevant to this resolver (including JS projects).
  const errors = diagnostics.filter((d) => d.code !== 18002 && d.code !== 18003);
  if (errors.length || !parsed) {
    throw new TypeScriptConfigError(read.error?.code === 5083 ? "TSCONFIG_READ_ERROR" : "TSCONFIG_PARSE_ERROR", configPath,
      errors.map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`).join("\n"), errors);
  }
  const { baseUrl, paths = {} } = parsed.options;
  // TS preserves the declaring config's directory here, including through
  // extends. CompilerOptions exposes this metadata through its index signature.
  const pathsBasePath = parsed.options.pathsBasePath;
  const pathsRoot = baseUrl ?? (typeof pathsBasePath === "string" ? pathsBasePath : path.dirname(configPath));
  // These path-specific checks otherwise happen during program creation, which
  // would unnecessarily load/type-check the user's entire project.
  for (const [pattern, targets] of Object.entries(paths)) {
    if (pattern.split("*").length > 2 || !Array.isArray(targets) || targets.length === 0 ||
        targets.some((target) => typeof target !== "string" || target.split("*").length > 2)) {
      throw new TypeScriptConfigError("TSCONFIG_PARSE_ERROR", configPath,
        `Invalid paths mapping: ${pattern}. Expected non-empty string targets and at most one wildcard per pattern/target.`);
    }
  }
  return { baseUrl, pathsRoot, paths };
}

async function exists(configPath: string): Promise<boolean> {
  try {
    if (!(await stat(configPath)).isFile()) throw new Error("Expected a configuration file.");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new TypeScriptConfigError("TSCONFIG_READ_ERROR", configPath, "Unable to inspect configuration.", error);
  }
}

/** Cache belongs to one resolution run, never shared across independent checks.
 * Only workspace/tsconfig.json and the explicitly supplied root are searched. */
export function createConfigLoader(rootDirectory?: string) {
  const selected = new Map<string, Promise<ResolutionConfig | null>>();
  const parsed = new Map<string, ResolutionConfig>();
  return (workspaceRoot: string): Promise<ResolutionConfig | null> => {
    const key = path.resolve(workspaceRoot);
    let pending = selected.get(key);
    if (!pending) {
      pending = (async () => {
        const local = path.join(key, "tsconfig.json");
        const fallback = rootDirectory === undefined ? undefined : path.resolve(rootDirectory, "tsconfig.json");
        const configPath = await exists(local) ? local :
          fallback !== undefined && fallback !== local && await exists(fallback) ? fallback : null;
        if (configPath === null) return null;
        let config = parsed.get(configPath);
        if (!config) {
          config = parseConfig(configPath);
          parsed.set(configPath, config);
        }
        return config;
      })();
      selected.set(key, pending);
    }
    return pending;
  };
}

/** Exact keys win, then the longest matching prefix before '*'; equal-prefix
 * ties retain declaration order, as in TypeScript. Target order is preserved. */
export function aliasCandidates(specifier: string, config: ResolutionConfig): string[] | null {
  let targets = Object.hasOwn(config.paths, specifier) ? config.paths[specifier] : undefined;
  let capture: string | undefined;
  if (!targets) {
    let longest = -1;
    for (const [pattern, candidates] of Object.entries(config.paths)) {
      const star = pattern.indexOf("*");
      if (star < 0 || star <= longest) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.length >= prefix.length + suffix.length &&
          specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        longest = star;
        targets = candidates;
        capture = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
  }
  return targets ? targets.map((target) => path.resolve(config.pathsRoot,
    capture === undefined ? target : target.replace("*", () => capture))) : null;
}
