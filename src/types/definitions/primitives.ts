import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonInput } from "../json-input";
import type { AtomicResult } from "../context/deterministic-handles";

// =============================================================================
// SCHEMA DEFINITIONS
// =============================================================================

/**
 * Channel definitions map - keys are channel names, values are standard schemas.
 * Channels are for async message passing between workflows.
 */
export type ChannelDefinitions = Record<
  string,
  StandardSchemaV1<JsonInput, unknown>
>;

/**
 * Stream definitions map - keys are stream names, values are standard schemas.
 * Streams are append-only logs for external consumption.
 */
export type StreamDefinitions = Record<
  string,
  StandardSchemaV1<JsonInput, unknown>
>;

/**
 * Event definitions - keys are event names, values are `true`.
 * Events are value-less write-once flags for coordination.
 */
export type EventDefinitions = Record<string, true>;

/**
 * Patch definitions — keys are patch names, values indicate active status.
 *
 * - `true`: The patch is active — new workflows will execute the patched code path.
 * - `false`: The patch is deprecated — new workflows will NOT execute the patched code path,
 *   but old (replaying) workflows that already entered it will still run it.
 *
 * Patches enable safe, incremental evolution of workflow code without breaking
 * in-flight workflows.
 */
export type PatchDefinitions = Record<string, boolean>;

/**
 * Accessor for a single patch on ctx.patches.
 *
 * Directly await to get a `boolean` — `true` when the patch is active,
 * `false` when deprecated (but the replaying workflow already entered it).
 *
 * ```typescript
 * if (await ctx.patches.antifraud) {
 *   const result = await ctx.join(ctx.steps.fraudCheck(flightId));
 * } else {
 *   // legacy path
 * }
 * ```
 */
export interface PatchAccessor extends AtomicResult<boolean> {}
