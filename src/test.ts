/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

// Glob the component's modules, excluding test files so they are never pulled
// into a consumer's convex-test registration.
const allModules = import.meta.glob("./component/**/*.ts");
export const modules = Object.fromEntries(
  Object.entries(allModules).filter(([path]) => !path.includes(".test.")),
);

/**
 * Register the EverOS component with a `convexTest` instance so consuming apps
 * can test against it.
 *
 * ```ts
 * import { convexTest } from "convex-test";
 * import schema from "./schema.js";
 * import everos from "@everos-ai/convex/test";
 * const t = convexTest(schema, import.meta.glob("./**\/*.ts"));
 * everos.register(t);
 * ```
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "everos",
) {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
