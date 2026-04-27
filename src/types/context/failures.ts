import type { StandardSchemaV1 } from "../standard-schema";
import type { StepDefinition, StepDefinitions } from "../definitions/steps";
import type { WorkflowDefinitions } from "../definitions/workflow-headers";
import type {
  AttemptAccessor,
  WorkflowExecutionError,
  WorkflowTerminationReason,
} from "../results";
import type { ScopeEntry } from "./scope-results";

// =============================================================================
// FAILURE INFO TYPES
// =============================================================================

/**
 * Failure information for a step, passed to `.failure()` builder callbacks
 * and concurrency primitive failure handlers.
 */
export interface StepFailureInfo {
  readonly reason: "attempts_exhausted" | "timeout";
  readonly attempts: AttemptAccessor;
}

/**
 * Failure information for a child workflow, passed to `.failure()` builder callbacks.
 * Discriminated union — the child may have failed (threw an error) or been
 * terminated for a non-failure reason (signal, parent termination, deadline).
 */
export type ChildWorkflowFailureInfo =
  | { readonly status: "failed"; readonly error: WorkflowExecutionError }
  | {
      readonly status: "terminated";
      readonly reason: WorkflowTerminationReason;
    };

// Per-step failures keyed on the step name for typed args narrowing.
export type ScopeStepFailures<TSteps extends StepDefinitions> = {
  [K in keyof TSteps & string]: {
    readonly kind: "step";
    readonly name: K;
    readonly args: TSteps[K] extends StepDefinition<infer A, any>
      ? StandardSchemaV1.InferOutput<A>
      : never;
    readonly info: StepFailureInfo;
  };
}[keyof TSteps & string];

// Per-child-workflow failures keyed on the workflow name.
export type ScopeChildWorkflowFailures<
  TChildWorkflows extends WorkflowDefinitions,
> = {
  [K in keyof TChildWorkflows & string]: {
    readonly kind: "childWorkflow";
    readonly name: K;
    readonly info: ChildWorkflowFailureInfo;
  };
}[keyof TChildWorkflows & string];

// Failure payload for scope/all builder failure callbacks.
export type ScopeFailureInfo<
  TSteps extends StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions,
> =
  | ScopeStepFailures<TSteps>
  | ScopeChildWorkflowFailures<TChildWorkflows>
  | { readonly kind: "exception"; readonly error: unknown };

// first() failure payload: one failure value per branch key.
export type AllBranchesFailedInfo<
  E extends Record<string, ScopeEntry<any>>,
  TSteps extends StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions,
> = {
  [K in keyof E & string]: ScopeFailureInfo<TSteps, TChildWorkflows>;
};
