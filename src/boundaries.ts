import type { BoundaryConfig } from "./config.js";
import type { ResolvedReference } from "./resolver.js";

export type BoundaryEvaluation = { relationship: ResolvedReference } & (
  | { status: "allowed" }
  | { status: "violation"; reason: "target-not-allowed" }
  | { status: "source-not-configured"; reason: "source-not-configured" }
  | { status: "skipped"; reason: "internal" | "external" | "builtin" | "unresolved" }
);

/** Pure evaluation of validated configuration. Keep every occurrence in input order,
 * including skipped unresolved references for later orchestration. */
export function evaluateBoundaries(
  relationships: readonly ResolvedReference[], config: BoundaryConfig,
): BoundaryEvaluation[] {
  return relationships.map((relationship): BoundaryEvaluation => {
    if (relationship.classification !== "cross-workspace") {
      return { relationship, status: "skipped", reason: relationship.classification };
    }
    const source = relationship.sourceWorkspace.name;
    if (!Object.hasOwn(config.boundaries, source)) {
      return { relationship, status: "source-not-configured", reason: "source-not-configured" };
    }
    const allowed = config.boundaries[source];
    if (allowed?.includes(relationship.targetWorkspace.name)) {
      return { relationship, status: "allowed" };
    }
    return { relationship, status: "violation", reason: "target-not-allowed" };
  });
}
