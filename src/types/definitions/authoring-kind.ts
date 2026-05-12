/**
 * Discriminant written by `defineWorkflowHeader`, `defineWorkflowInterface`, and
 * `defineWorkflow` so operator handles can expose `.extend` only when the
 * handle type parameter is still graph-minimal (`"header"`).
 */
export type NataliaWorkflowAuthoringKind = "header" | "interface" | "definition";

/**
 * True when `W` is the return type of `defineWorkflowHeader` — the only authoring
 * shape that keeps `.extend` on header-parameterized handles.
 */
export type IsHeaderAuthoringKind<W> = W extends {
  readonly __nataliaAuthoringKind: infer K;
}
  ? K extends "header"
    ? true
    : false
  : false;
