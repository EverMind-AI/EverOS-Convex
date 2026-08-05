import { defineComponent } from "convex/server";

// The EverOS memory component.
//
// Note on configuration: the spec sketched a typed `env` block on
// `defineComponent`. In practice — and following Convex's own reference
// component (get-convex/twilio) — secrets like the EverOS API key are NOT read
// from `process.env` *inside* the component (env is not reliably available
// there). Instead the app-side client (`src/client/index.ts`) reads
// `EVEROS_API_KEY` / `EVEROS_BASE_URL` app-side and threads them into every
// action as arguments. This keeps the component pure and portable.
export default defineComponent("everos");
