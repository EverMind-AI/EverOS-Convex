import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";
import everos from "@everos/convex/convex.config";

const app = defineApp();
app.use(agent);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(everos as any); // see "Local development" in the root README: linking
// the component with `file:..` resolves two copies of `convex`, so the two
// `ComponentDefinition` types are structurally identical but nominally
// distinct. Apps that install @everos/convex from npm have one copy and do
// not need this cast.

export default app;
