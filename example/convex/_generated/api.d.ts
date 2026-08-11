/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _tmpTranslateTest from "../_tmpTranslateTest.js";
import type * as chat from "../chat.js";
import type * as demo from "../demo.js";
import type * as memoryTest from "../memoryTest.js";
import type * as translate from "../translate.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  _tmpTranslateTest: typeof _tmpTranslateTest;
  chat: typeof chat;
  demo: typeof demo;
  memoryTest: typeof memoryTest;
  translate: typeof translate;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  everos: import("@everos-ai/convex/_generated/component.js").ComponentApi<"everos">;
};
