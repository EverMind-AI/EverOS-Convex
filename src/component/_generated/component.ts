/**
 * The `ComponentApi` entry point that Convex's app-side codegen imports.
 *
 * An app that installs this component gets a generated `_generated/api.d.ts`
 * containing:
 *
 * ```ts
 * everos: import("@everos-ai/convex/_generated/component.js").ComponentApi<"everos">;
 * ```
 *
 * so this path has to resolve or `components.everos` silently degrades to
 * `any` (Convex's template sets `skipLibCheck: true`, which hides the broken
 * import instead of reporting it).
 *
 * The type itself is hand-maintained in `src/client/component.ts` and merely
 * re-exported here, so there is one definition rather than a generated copy
 * that can drift from it.
 */
export type { ComponentApi } from "../../client/component.js";
