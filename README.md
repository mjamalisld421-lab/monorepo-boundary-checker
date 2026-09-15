# monorepo-boundary-checker

`monorepo-boundary-checker` is a Node.js CLI that enforces explicit dependency boundaries between packages in npm, Yarn classic, and pnpm workspaces. It discovers workspace packages, scans JavaScript and TypeScript source syntax, resolves local relationships, and reports imports that violate the configured architecture.

The current release is [monorepo-boundary-checker@1.1.0](https://www.npmjs.com/package/monorepo-boundary-checker/v/1.1.0). Install it as a development dependency:

```sh
npm install --save-dev monorepo-boundary-checker
```

## Usage

Run the checker from the monorepo root:

```sh
npx monorepo-boundary-checker
```

The current working directory is the project root. By default, the checker reads `monorepo-boundary.config.json` from that directory.

```text
monorepo-boundary-checker
monorepo-boundary-checker --config <path>
monorepo-boundary-checker --json
monorepo-boundary-checker --config <path> --json
```

- `--config <path>` uses an alternate boundary configuration file. Relative paths are resolved from the current working directory.
- `--json` emits one machine-readable JSON document instead of the human report. The two options may appear in either order.

## Configuration

Create `monorepo-boundary.config.json` in the monorepo root:

```json
{
  "boundaries": {
    "@demo/web": [
      "@demo/ui",
      "@demo/shared"
    ],
    "@demo/domain": [
      "@demo/shared"
    ],
    "@demo/ui": [
      "@demo/shared"
    ],
    "@demo/shared": []
  }
}
```

Each key must be the exact package name of a discovered workspace. Its value lists the workspace packages it may import. An empty list forbids all cross-workspace dependencies from that package. Omitting a source rule does not implicitly allow it: each of its cross-workspace references is reported as `source-not-configured`.

For example, the configuration above allows `@demo/domain` to import `@demo/shared`, but an import from `@demo/domain` to `@demo/database` is a `target-not-allowed` violation. Internal imports, external packages, and Node built-ins are not boundary violations.

### Supported workspace definitions

npm and Yarn classic projects may use either `package.json` workspace form:

```json
{ "workspaces": ["apps/*", "packages/*"] }
```

```json
{ "workspaces": { "packages": ["apps/*", "packages/*"] } }
```

pnpm projects may define workspaces in `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "!packages/internal-test"
```

Negative patterns exclude matching directories. If `pnpm-workspace.yaml` exists at the project root, its `packages` field is authoritative and the checker does not combine it with `package.json` workspaces.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The check completed with no violations, missing source rules, or unresolved local references. |
| `1` | At least one boundary violation or `source-not-configured` relationship was found. |
| `2` | Configuration, scanning, resolution, or another operational failure occurred, including an unresolved local reference. |

Exit code 2 takes precedence when operational uncertainty and architecture violations occur together.

## JSON output

JSON mode preserves deterministic source order and duplicate import occurrences. Source files are project-relative and use `/` separators. A completed check has this shape:

```json
{
  "ok": false,
  "summary": {
    "workspaces": 5,
    "crossWorkspaceImports": 8,
    "violations": 1,
    "missingSourceRules": 0,
    "unresolved": 0
  },
  "violations": [
    {
      "sourceWorkspace": "@demo/domain",
      "targetWorkspace": "@demo/database",
      "file": "packages/domain/src/service.ts",
      "specifier": "@db/client",
      "importKind": "import",
      "reason": "target-not-allowed"
    }
  ],
  "missingSourceRules": [],
  "unresolved": []
}
```

`violations`, `missingSourceRules`, and `unresolved` are separate collections with stable reason codes. A clean result has `ok: true` and empty collections. A known operational failure emits one JSON document such as:

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_PARSE_ERROR",
    "message": "Invalid JSON in boundary configuration: monorepo-boundary.config.json",
    "file": "monorepo-boundary.config.json"
  }
}
```

## Supported source and resolution behavior

The checker scans `.js`, `.jsx`, `.ts`, and `.tsx` files and recognizes:

- static ES imports, including type-only, multiline, and side-effect imports;
- CommonJS `require()` calls with one literal string argument;
- relative imports and directory `index` files;
- exact workspace package names and workspace subpaths;
- TypeScript `compilerOptions.baseUrl` and exact or wildcard `paths` mappings;
- workspace `tsconfig.json`, root fallback, and ordinary `extends` inheritance;
- exact source files before `.js` to `.ts`/`.tsx` and `.jsx` to `.tsx` substitution.

Workspace, source-file, import-occurrence, and report ordering is deterministic. Workspace and alias targets use canonical real paths where applicable.

## Intentional limitations

- Dynamic `import()` and non-literal `require()` expressions are not analyzed.
- Static re-export declarations are not scanned as import references.
- Full Node package `exports` and conditional resolution are not implemented.
- Bundler-specific aliases and arbitrary custom resolvers are not supported.
- Yarn PnP and pnpm virtual-store dependency resolution are not included. pnpm workspace metadata discovery is supported.
- Nx, Turborepo, and ESLint plugins are not included.
- Circular dependency detection and vulnerability scanning are outside this tool's scope.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
