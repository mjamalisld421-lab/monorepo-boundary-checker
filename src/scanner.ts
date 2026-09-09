import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse, type ParserPlugin } from "@babel/parser";
import fastGlob from "fast-glob";

export type ImportReference = {
  specifier: string;
  kind: "import" | "require";
};

export type SourceFileScan = {
  filePath: string;
  imports: ImportReference[];
};

export type SourceScanErrorCode =
  | "SOURCE_READ_ERROR"
  | "SOURCE_PARSE_ERROR"
  | "UNSUPPORTED_SOURCE_EXTENSION";

export class SourceScanError extends Error {
  readonly code: SourceScanErrorCode;
  readonly filePath: string;

  constructor(
    code: SourceScanErrorCode,
    filePath: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SourceScanError";
    this.code = code;
    this.filePath = filePath;
  }
}

type AstNode = {
  type: string;
  start?: number | null;
  [key: string]: unknown;
};

type LocatedReference = ImportReference & {
  position: number;
};

const supportedExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function parserPlugins(extension: string): ParserPlugin[] {
  const plugins: ParserPlugin[] = [];

  if (extension === ".ts" || extension === ".tsx") {
    plugins.push("typescript");
  }

  if (extension === ".jsx" || extension === ".tsx") {
    plugins.push("jsx");
  }

  return plugins;
}

function collectReferences(node: AstNode, references: LocatedReference[]): void {
  if (node.type === "ImportDeclaration") {
    const source = node.source;

    if (isAstNode(source) && source.type === "StringLiteral" && typeof source.value === "string") {
      references.push({
        kind: "import",
        position: node.start ?? Number.MAX_SAFE_INTEGER,
        specifier: source.value,
      });
    }
  } else if (node.type === "CallExpression") {
    const callee = node.callee;
    const args = node.arguments;

    if (
      isAstNode(callee) &&
      callee.type === "Identifier" &&
      callee.name === "require" &&
      Array.isArray(args) &&
      args.length === 1
    ) {
      const argument = args[0];

      if (
        isAstNode(argument) &&
        argument.type === "StringLiteral" &&
        typeof argument.value === "string"
      ) {
        references.push({
          kind: "require",
          position: node.start ?? Number.MAX_SAFE_INTEGER,
          specifier: argument.value,
        });
      }
    }
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          collectReferences(item, references);
        }
      }
    } else if (isAstNode(value)) {
      collectReferences(value, references);
    }
  }
}

export async function findSourceFiles(rootDirectory: string): Promise<string[]> {
  const absoluteRoot = path.resolve(rootDirectory);
  const files = await fastGlob("**/*.{js,jsx,ts,tsx}", {
    absolute: true,
    cwd: absoluteRoot,
    dot: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
    onlyFiles: true,
    unique: true,
  });

  return files.sort(comparePaths);
}

export async function scanSourceFile(filePath: string): Promise<SourceFileScan> {
  const absoluteFilePath = path.resolve(filePath);
  const extension = path.extname(absoluteFilePath).toLowerCase();

  if (!supportedExtensions.has(extension)) {
    throw new SourceScanError(
      "UNSUPPORTED_SOURCE_EXTENSION",
      absoluteFilePath,
      `Unsupported source file extension: ${absoluteFilePath}`,
    );
  }

  let source: string;

  try {
    source = await readFile(absoluteFilePath, "utf8");
  } catch (error) {
    throw new SourceScanError(
      "SOURCE_READ_ERROR",
      absoluteFilePath,
      `Unable to read source file: ${absoluteFilePath}`,
      error,
    );
  }

  let ast: AstNode;

  try {
    const parsedAst: unknown = parse(source, {
      plugins: parserPlugins(extension),
      sourceFilename: absoluteFilePath,
      sourceType: "unambiguous",
    });

    if (!isAstNode(parsedAst)) {
      throw new Error("Parser did not return an AST node.");
    }

    ast = parsedAst;
  } catch (error) {
    const parserMessage = error instanceof Error ? ` ${error.message}` : "";
    throw new SourceScanError(
      "SOURCE_PARSE_ERROR",
      absoluteFilePath,
      `Unable to parse source file ${absoluteFilePath}.${parserMessage}`,
      error,
    );
  }

  const references: LocatedReference[] = [];
  collectReferences(ast, references);
  references.sort((left, right) => left.position - right.position);

  return {
    filePath: absoluteFilePath,
    imports: references.map(({ kind, specifier }) => ({ kind, specifier })),
  };
}

export async function scanSourceTree(rootDirectory: string): Promise<SourceFileScan[]> {
  const filePaths = await findSourceFiles(rootDirectory);
  const scans: SourceFileScan[] = [];

  for (const filePath of filePaths) {
    scans.push(await scanSourceFile(filePath));
  }

  return scans;
}
