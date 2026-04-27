import type { StandardSchemaV1 } from "../standard-schema";
import type { JsonInput } from "../json-input";
import type { RetryPolicyOptions } from "../definitions/policies";

export const MAIN_BRANCH: unique symbol = Symbol("MAIN_BRANCH") as any;

export interface BranchPathItem {
  readonly scope: string;
  readonly branch: string | typeof MAIN_BRANCH;
}

declare const nataliaEntryBrand: unique symbol;
declare const nataliaEntryValue: unique symbol;
declare const stepEntryBrand: unique symbol;
declare const workflowEntryBrand: unique symbol;
declare const requestEntryBrand: unique symbol;

export interface AwaitableEntry<T> extends PromiseLike<T> {
  readonly [nataliaEntryBrand]: true;
  readonly [nataliaEntryValue]?: T;
}

export interface StepEntry<T> extends AwaitableEntry<T> {
  readonly [stepEntryBrand]: true;
}

export interface WorkflowEntry<T> extends AwaitableEntry<T> {
  readonly [workflowEntryBrand]: true;
}

export interface RequestEntry<T> extends AwaitableEntry<T> {
  readonly [requestEntryBrand]: true;
}

export interface StepCallOptions {
  readonly retry?: RetryPolicyOptions;
}

export interface StepTimeoutCallOptions extends StepCallOptions {
  readonly timeout: StepBoundary;
}

export type StepBoundary =
  | number
  | Date
  | { maxAttempts: number; seconds?: number }
  | { seconds: number; maxAttempts?: number }
  | { deadline: Date; maxAttempts?: number };

type JsonScalarInput = Extract<JsonInput, string | number | boolean | null>;

type SerializedInputFromOutput<T> = T extends Date
  ? string | number
  : T extends readonly (infer U)[]
    ? readonly SerializedInputFromOutput<U>[]
    : T extends object
      ? { [K in keyof T]: SerializedInputFromOutput<T[K]> }
      : Extract<T, JsonInput>;

export type SchemaInvocationInput<TSchema extends StandardSchemaV1> =
  unknown extends StandardSchemaV1.InferInput<TSchema>
    ? SerializedInputFromOutput<StandardSchemaV1.InferOutput<TSchema>>
    : StandardSchemaV1.InferInput<TSchema> extends infer TInput
      ? TInput extends object
        ? {
            [K in keyof TInput]: unknown extends TInput[K]
              ? StandardSchemaV1.InferOutput<TSchema> extends infer TOutputMap
                ? K extends keyof TOutputMap
                  ? SerializedInputFromOutput<TOutputMap[K]>
                  : JsonScalarInput
                : never
              : TInput[K];
          }
        : TInput
      : never;

export interface StepAccessor<TArgsSchema extends StandardSchemaV1, TResult> {
  (args: SchemaInvocationInput<TArgsSchema>): StepEntry<TResult>;
  (
    args: SchemaInvocationInput<TArgsSchema>,
    opts: StepTimeoutCallOptions,
  ): StepEntry<TimeoutResult<TResult>>;
  (
    args: SchemaInvocationInput<TArgsSchema>,
    opts: StepCallOptions,
  ): StepEntry<TResult>;
}

export type TimeoutResult<T> =
  | { ok: true; result: T }
  | { ok: false; status: "timeout" };

export interface JoinOptions {
  readonly timeout: StepBoundary;
}

export type JoinTimeoutResult = { ok: false; status: "join_timeout" };

export type JoinResult<H> = H extends AwaitableEntry<infer T> ? T : never;
