import type { StandardSchemaV1 } from "./standard-schema";
import type {
  ChannelDefinitions,
  StreamDefinitions,
  EventDefinitions,
  PatchDefinitions,
  RngDefinitions,
  StepDefinition,
  StepDefinitions,
  RequestDefinition,
  RequestDefinitions,
  WorkflowDefinitions,
  BranchDefinition,
  BranchDefinitions,
  AnyWorkflowHeader,
  PatchAccessor,
  RngAccessors,
  RetryPolicyOptions,
  RetentionSetter,
  WorkflowInvocationBaseOptions,
  ErrorDefinitions,
  BranchErrorMode,
  ExplicitBranchErrorDefinitions,
} from "./definitions";
import type { JsonInput } from "./json-input";
import type {
  StepCompensationResult,
  CompensationStepResult,
  ChildWorkflowCompensationResult,
  WorkflowResult,
  EventWaitResult,
  EventWaitResultNoTimeout,
  EventCheckResult,
  AttemptAccessor,
  WorkflowExecutionError,
  WorkflowTerminationReason,
  ExplicitError,
  ErrorValue,
} from "./results";

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

// =============================================================================
// ROOT SCOPE BRANDING
// =============================================================================

declare const executionRoot: unique symbol;
declare const compensationRoot: unique symbol;

/**
 * Discriminates whether a deterministic handle was created inside a workflow
 * execution context or a compensation context.
 *
 * Handles carrying `typeof executionRoot` may only be joined from
 * `WorkflowContext` / `WorkflowConcurrencyContext`.
 * Handles carrying `typeof compensationRoot` may only be joined from
 * `CompensationContext` / `CompensationConcurrencyContext`.
 */
export type RootScope = typeof executionRoot | typeof compensationRoot;

/** @internal Used as the `TRoot` type parameter on execution-context handles. */
export type ExecutionRoot = typeof executionRoot;

/** @internal Used as the `TRoot` type parameter on compensation-context handles. */
export type CompensationRoot = typeof compensationRoot;

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

type SchemaInvocationInput<TSchema extends StandardSchemaV1> =
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

export type ErrorFactories<TErrors extends ErrorDefinitions> = {
  [K in keyof TErrors & string]: TErrors[K] extends true
    ? (message: string) => ExplicitError<K, undefined>
    : TErrors[K] extends StandardSchemaV1<unknown, unknown>
      ? (
          message: string,
          details: SchemaInvocationInput<TErrors[K]>,
        ) => ExplicitError<K, StandardSchemaV1.InferOutput<TErrors[K]>>
      : never;
};

export interface BranchContext<
  TSteps extends StepDefinitions = Record<string, never>,
  TRequests extends RequestDefinitions = Record<string, never>,
  TErrors extends BranchErrorMode = Record<string, never>,
> {
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema,
      any
    >
      ? StepAccessor<TArgs, StandardSchemaV1.InferOutput<TResultSchema>>
      : never;
  };
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      infer TPayload,
      infer TResponseSchema
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };
  readonly errors: ErrorFactories<ExplicitBranchErrorDefinitions<TErrors>>;
}

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

declare const durableHandleBrand: unique symbol;
declare const rootScopeBrand: unique symbol;
declare const phantomValueType: unique symbol;

/**
 * Opaque handle to a deterministic workflow primitive.
 *
 * Not directly awaitable — must be resolved via `handle.resolve(ctx)` or `ctx.join(handle)`.
 * This intentionally excludes native Promise values from structural assignment
 * unless they are explicitly wrapped/typed by the engine as deterministic.
 *
 * @typeParam T    - The resolved value type.
 * @typeParam TRoot - Which root context created this handle
 *                   (`ExecutionRoot` or `CompensationRoot`).
 *                   Defaults to the widened `RootScope` for constraint positions.
 */
// =============================================================================
// RESOLVER MARKER INTERFACES
// =============================================================================

declare const executionResolverBrand: unique symbol;
declare const compensationResolverBrand: unique symbol;

/**
 * Marker interface satisfied by all execution-phase contexts
 * (`WorkflowContext`, `WorkflowConcurrencyContext`).
 *
 * Used as the parameter type for `DurableHandle<T, ExecutionRoot>.resolve()`,
 * allowing the handle to check that it is being resolved from the correct context
 * without creating a circular import between this file and itself.
 */
export interface ExecutionResolver {
  /** @internal Brand — do not access at runtime. */
  readonly [executionResolverBrand]: true;
}

/**
 * Marker interface satisfied by all compensation-phase contexts
 * (`CompensationContext`, `CompensationConcurrencyContext`).
 *
 * Used as the parameter type for `DurableHandle<T, CompensationRoot>.resolve()`.
 */
export interface CompensationResolver {
  /** @internal Brand — do not access at runtime. */
  readonly [compensationResolverBrand]: true;
}

export interface DurableHandle<T, TRoot extends RootScope = RootScope> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [durableHandleBrand]: true;
  /** @internal Root context discriminator — do not access at runtime. */
  readonly [rootScopeBrand]: TRoot;
  /**
   * @internal Covariant phantom field — allows TypeScript to infer `T` via
   * `H extends DurableHandle<infer T, ...>` in conditional types.
   * Optional so it never appears in required field checks.
   * Do not access at runtime.
   */
  readonly [phantomValueType]?: T;

  /**
   * Resolve this handle against its originating context.
   *
   * Replaces the former `ctx.execute(handle)` pattern — instead of passing the handle into the
   * context, pass the context into the handle. The result is an `AtomicResult<T>`
   * which can be directly `await`-ed but is not a native `Promise` and cannot
   * be accidentally passed into `Promise.all` or other JS concurrency primitives.
   *
   * The `ctx` parameter is type-checked at compile time: an `ExecutionRoot`
   * handle requires an `ExecutionResolver` (satisfied by `WorkflowContext` and
   * `WorkflowConcurrencyContext`), and a `CompensationRoot` handle requires a
   * `CompensationResolver` (satisfied by `CompensationContext` and
   * `CompensationConcurrencyContext`). Passing the wrong context type is a
   * compile error.
   *
   * @example
   * ```typescript
   * const flight = await ctx.steps.bookFlight(dest, id)
   *   .compensate(async (ctx) => { ... })
   *   .resolve(ctx);
   *
   * const result = await ctx.scope("Name", entries, callback).resolve(ctx);
   * ```
   */
  resolve(
    ctx: TRoot extends ExecutionRoot ? ExecutionResolver : CompensationResolver,
  ): AtomicResult<T>;
}

declare const atomicResultBrand: unique symbol;
declare const blockingResultBrand: unique symbol;

/**
 * Directly awaitable deterministic workflow primitive.
 *
 * Represents atomic (synchronous-at-engine-level) operations such as
 * `ctx.streams.X.write()`, `ctx.events.X.set()`, `ctx.patches.X`,
 * `channels.send()`, and `receiveNowait()`.
 *
 * These operations are directly awaitable with `await` but are NOT valid
 * scope entries (they complete atomically and do not represent ongoing
 * concurrent work).
 *
 * @typeParam T - The resolved value type.
 */
export interface AtomicResult<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [atomicResultBrand]: true;

  then<TResult = T>(
    onfulfilled?:
      | ((value: T) => TResult | PromiseLike<TResult>)
      | null
      | undefined,
  ): AtomicResult<TResult>;

  /**
   * Await-compatibility signature used by TypeScript's `Awaited<T>` extraction.
   * Keep this overload broad and LAST so normal `.then(...)` calls still
   * resolve to the strongly typed generic overload above.
   */
  then(onfulfilled: (value: T, ...args: any[]) => any): any;
}

/**
 * Directly awaitable blocking workflow primitive.
 *
 * Extends `AtomicResult<T>` with a scope-entry brand, making it valid
 * as a `ctx.scope()` / `ctx.all()` entry in addition to being directly
 * awaitable.
 *
 * Used for blocking operations that represent ongoing concurrent work:
 * `ctx.sleep()`, `ctx.sleepUntil()`, and `ctx.channels.X.receive(...)`.
 *
 * @typeParam T - The resolved value type.
 */
export interface BlockingResult<T> extends AtomicResult<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly [blockingResultBrand]: true;
}

// =============================================================================
// CHANNEL HANDLE, STREAM ACCESSOR, EVENT ACCESSOR (WORKFLOW INTERNAL)
// =============================================================================

/**
 * A one-shot receive future returned by `ChannelHandle.receive(...)`.
 *
 * Directly awaitable and can be passed into `ctx.select()` and `ctx.listen()`
 * as a finite, one-shot channel wait — the key is removed from `remaining`
 * once the receive resolves, just like a branch handle.
 *
 * Unlike passing a raw `ChannelHandle` to `listen` (which creates a streaming,
 * never-exhausted branch), a `ChannelReceiveCall` resolves exactly once.
 *
 * @typeParam T - The resolved value type (may include `undefined` or a default
 *               for timeout overloads).
 */
export interface ChannelReceiveCall<T> extends BlockingResult<T> {
  /** @internal Brand discriminator — do not access at runtime. */
  readonly _kind: "channel_receive_call";
}

/**
 * Channel handle on ctx.channels.
 * Can be used directly for receive, passed into listen, or async-iterated.
 * T is the decoded type (z.output<Schema>).
 *
 * @typeParam T - The decoded message type.
 */
export interface ChannelHandle<T> extends AsyncIterable<T> {
  /**
   * Receive a message from this channel (FIFO order).
   * Blocks until a message arrives.
   *
   * Returns a `ChannelReceiveCall<T>` that can be directly awaited or passed
   * into `ctx.select()` / `ctx.listen()` as a one-shot branch.
   */
  receive(): ChannelReceiveCall<T>;

  /**
   * Receive with timeout (in seconds).
   * Returns `undefined` when the timeout expires before a message arrives.
   *
   * Returns a `ChannelReceiveCall<T | undefined>` that can be directly awaited
   * or passed into `ctx.select()` / `ctx.listen()`.
   */
  receive(timeoutSeconds: number): ChannelReceiveCall<T | undefined>;

  /**
   * Receive with timeout (in seconds) and an explicit timeout default.
   * Returns `defaultValue` when the timeout expires before a message arrives.
   *
   * Returns a `ChannelReceiveCall<T | TDefault>` that can be directly awaited
   * or passed into `ctx.select()` / `ctx.listen()`.
   */
  receive<TDefault>(
    timeoutSeconds: number,
    defaultValue: TDefault,
  ): ChannelReceiveCall<T | TDefault>;

  /**
   * Non-blocking poll — returns immediately.
   * Returns `undefined` if no message is available.
   *
   * Use this instead of `receive(0)` to avoid return-type ambiguity when the
   * timeout value is dynamic. Returns a `AtomicResult<T | undefined>` that
   * cannot be passed as a scope entry (it is atomic/non-blocking).
   */
  receiveNowait(): AtomicResult<T | undefined>;

  /**
   * Non-blocking poll with an explicit default.
   * Returns `defaultValue` if no message is available.
   *
   * Use this when you need to distinguish a timed-out poll from a real `undefined`
   * message value.
   */
  receiveNowait<TDefault>(defaultValue: TDefault): AtomicResult<T | TDefault>;

  /**
   * Async iteration over channel messages.
   *
   * Example:
   * `for await (const msg of ctx.channels.approval) { ... }`
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

/**
 * Stream accessor on ctx.streams (for writing from within the workflow).
 * T is the encoded type (z.input<Schema>).
 *
 * @typeParam T - The encoded record type.
 */
export interface StreamAccessor<T> {
  /**
   * Write a record to the stream.
   * @param data - Record data (z.input type — encoded).
   * @returns The offset at which the record was saved.
   */
  write(data: T): AtomicResult<number>;
}

/**
 * Event accessor on ctx.events (for setting from within the workflow).
 */
export interface EventAccessor {
  /**
   * Set the event (idempotent — second call is no-op).
   */
  set(): AtomicResult<void>;
}

// =============================================================================
// SCOPE PATH — SYMBOLS AND TYPES
// =============================================================================

declare const scopeDivider: unique symbol;
declare const branchDivider: unique symbol;

/**
 * Divider inserted into a scope path between a scope's parent path and its name.
 * Distinguishes scope name transitions from branch key transitions.
 */
export type ScopeDivider = typeof scopeDivider;

/**
 * Divider inserted into a scope path between a scope name and a branch key.
 * Distinguishes branch key transitions from scope name transitions.
 */
export type BranchDivider = typeof branchDivider;

/** Runtime-accessible scope divider value for path inspection. */
export { scopeDivider, branchDivider };

/**
 * Ordered scope lineage from root to current scope.
 * Elements are strings (scope names / branch keys) interleaved with
 * `ScopeDivider` and `BranchDivider` symbols to maintain structural
 * unambiguity at both type level and runtime.
 */
export type ScopePath = readonly (string | ScopeDivider | BranchDivider)[];

type IsPrefix<
  TPrefix extends ScopePath,
  TValue extends ScopePath,
> = TPrefix extends []
  ? true
  : TValue extends readonly [infer VH, ...infer VT extends ScopePath]
    ? TPrefix extends readonly [infer PH, ...infer PT extends ScopePath]
      ? [PH] extends [VH]
        ? [VH] extends [PH]
          ? IsPrefix<PT, VT>
          : false
        : false
      : false
    : false;

/**
 * Append a named scope to the current lineage, inserting a `scopeDivider` before the name.
 */
export type AppendScopeName<
  TScopePath extends ScopePath,
  TName extends string,
> = [...TScopePath, ScopeDivider, TName];

/**
 * Append a branch key to the current lineage, inserting a `branchDivider` before the key.
 */
export type AppendBranchKey<
  TScopePath extends ScopePath,
  TKey extends string,
> = [...TScopePath, BranchDivider, TKey];

/**
 * Scope name guard:
 * - Literal names cannot reuse any ancestor scope name (string elements only).
 * - Widened `string` is allowed but loses compile-time collision guarantees.
 *
 * **Limitation**: once a dynamic (non-literal) string is used as a scope entry
 * key, the ancestor scope path contains a wide `string` type. At that point the
 * collision check is bypassed for all nested scopes and branch closures created
 * from that entry — TypeScript cannot distinguish individual runtime keys from
 * each other at the type level. If you use dynamic keys, you are responsible for
 * ensuring scope name uniqueness manually.
 */
export type ScopeNameArg<
  TScopePath extends ScopePath,
  TName extends string,
> = string extends TName
  ? TName
  : string extends Extract<TScopePath[number], string>
    ? TName
    : TName extends Extract<TScopePath[number], string>
      ? never
      : TName;

/**
 * Rest-parameter constraint for `ctx.join()` scope-path enforcement.
 *
 * - For a plain `DurableHandle` (no scope path), resolves to `[]` — no path check needed.
 * - For a `BranchHandle<T, THandlePath>`, resolves to `[]` when `THandlePath` is a prefix
 *   of the current scope path `TCurrentPath`, or to an error tuple otherwise.
 */
export type IsJoinableByPath<H, TCurrentPath extends ScopePath> =
  H extends BranchEntry<any, infer THandlePath, any>
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? []
      : [
          "Handle scope path is not accessible from the current scope — the handle was created in a scope that has already closed or is not an ancestor of the current scope",
        ]
    : [];

// =============================================================================
// SCOPE TYPES — ENTRY, BRANCH HANDLES
// =============================================================================

export type EntryResult<E> = E extends AwaitableEntry<infer T> ? T : never;

/**
 * A scope entry is an unstarted typed workflow entry. Inline branch closures are
 * intentionally not accepted; isolated branches are declared up front and
 * instantiated through `ctx.branches`.
 */
export type ScopeEntry<T = unknown> =
  | StepEntry<T>
  | RequestEntry<T>
  | WorkflowEntry<T>
  | BranchEntry<T, any, any>;

export type ScopeEntryPropertyStructure =
  | ScopeEntry
  | readonly ScopeEntry[]
  | ReadonlyMap<PropertyKey, ScopeEntry>;

export type ScopeEntryStructure = {
  readonly [key: string]: ScopeEntryPropertyStructure;
};

type InvalidScopeEntryStructure = [
  "Scope input must be a top-level object whose properties are typed entries, arrays/tuples of entries, or maps of entries",
];

type ScopeEntryPropertyValidation<E> =
  E extends AwaitableEntry<any>
    ? []
    : E extends readonly (infer V)[]
      ? V extends AwaitableEntry<any>
        ? []
        : InvalidScopeEntryStructure
      : E extends ReadonlyMap<any, infer V>
        ? V extends AwaitableEntry<any>
          ? []
          : InvalidScopeEntryStructure
        : InvalidScopeEntryStructure;

type ScopeEntryValidation<E> = E extends (...args: any[]) => any
  ? InvalidScopeEntryStructure
  : E extends AwaitableEntry<any> | readonly unknown[] | ReadonlyMap<any, any>
    ? InvalidScopeEntryStructure
    : E extends object
      ? {
          [K in keyof E]: ScopeEntryPropertyValidation<E[K]>;
        }[keyof E] extends []
        ? []
        : InvalidScopeEntryStructure
      : InvalidScopeEntryStructure;

type TupleIndexKeys<T extends readonly unknown[]> = Exclude<
  keyof T,
  keyof (readonly unknown[])
>;

type TupleIndex<K> = K extends `${infer N extends number}` ? N : never;

type TupleIndexes<T extends readonly unknown[]> = TupleIndex<TupleIndexKeys<T>>;

/**
 * A handle to a running scope branch.
 * Resolves to T when the branch completes successfully.
 *
 * `BranchHandle<T>` values are produced by `ctx.scope()` and can be:
 * - Resolved via `handle.resolve(ctx)` on all contexts, or `ctx.join(handle)` on concurrency contexts
 * - Passed into `ctx.select()` and `ctx.match()`
 *
 * @typeParam T          - The resolved value type.
 * @typeParam TScopePath - Scope lineage of the parent scope that spawned this branch.
 *                        `ctx.join()` enforces `IsPrefix<TScopePath, TCurrentPath>`.
 * @typeParam TRoot      - Root context that created this branch handle.
 */
declare const scopePathBrand: unique symbol;

export interface BranchEntry<
  T,
  TScopePath extends ScopePath = ScopePath,
  TRoot extends RootScope = RootScope,
> extends AwaitableEntry<T> {
  /** @internal Type-level scope ownership brand. */
  readonly [scopePathBrand]: TScopePath;
  /** @internal Root context discriminator — do not access at runtime. */
  readonly [rootScopeBrand]: TRoot;
}

export interface BranchHandle<
  T,
  TScopePath extends ScopePath = ScopePath,
  TRoot extends RootScope = RootScope,
> extends BranchEntry<T, TScopePath, TRoot> {}

export type BranchInstanceStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "halted"
  | "skipped";

export type DefinedBranchResult<T, TErrors extends BranchErrorMode> =
  | { ok: true; result: T }
  | { ok: false; status: "failed"; error: unknown };

type EntrySuccessFromValue<T> = [
  Extract<T, { ok: true; result: any }>,
] extends [never]
  ? T
  : Extract<T, { ok: true; result: any }> extends { ok: true; result: infer R }
    ? R
    : never;

export type ScopeSuccessResults<E> =
  E extends AwaitableEntry<infer T>
    ? EntrySuccessFromValue<T>
    : E extends readonly unknown[]
      ? { [K in keyof E]: ScopeSuccessResults<E[K]> }
      : E extends ReadonlyMap<infer K, infer V>
        ? ReadonlyMap<K, ScopeSuccessResults<V>>
        : E extends object
          ? { [K in keyof E]: ScopeSuccessResults<E[K]> }
          : never;

type EntryFailureFromValue<T> = Extract<T, { ok: false }>;

type TupleSuccessUnion<E extends readonly unknown[]> = {
  [K in TupleIndexKeys<E>]: ScopeSuccessResults<E[K]>;
}[TupleIndexKeys<E>];

type TupleKeyedSuccess<
  TKey extends PropertyKey,
  E extends readonly unknown[],
> = {
  [K in TupleIndexKeys<E>]: {
    key: TKey;
    index: TupleIndex<K>;
    value: ScopeSuccessResults<E[K]>;
  };
}[TupleIndexKeys<E>];

type TupleKeyedFailure<
  TKey extends PropertyKey,
  E extends readonly unknown[],
> = {
  [K in TupleIndexKeys<E>]: E[K] extends AwaitableEntry<infer T>
    ? EntryFailureFromValue<T> extends never
      ? never
      : { key: TKey; index: TupleIndex<K>; error: EntryFailureFromValue<T> }
    : never;
}[TupleIndexKeys<E>];

type KeyedSuccessForProperty<TKey extends PropertyKey, TValue> =
  TValue extends AwaitableEntry<any>
    ? { key: TKey; value: ScopeSuccessResults<TValue> }
    : TValue extends readonly unknown[]
      ? number extends TValue["length"]
        ? {
            key: TKey;
            index: number;
            value: TValue extends readonly (infer V)[]
              ? ScopeSuccessResults<V>
              : never;
          }
        : TupleKeyedSuccess<TKey, TValue>
      : TValue extends ReadonlyMap<infer K extends PropertyKey, infer V>
        ? { key: TKey; mapKey: K; value: ScopeSuccessResults<V> }
        : never;

type KeyedFailureForProperty<TKey extends PropertyKey, TValue> =
  TValue extends AwaitableEntry<infer T>
    ? EntryFailureFromValue<T> extends never
      ? never
      : { key: TKey; error: EntryFailureFromValue<T> }
    : TValue extends readonly unknown[]
      ? TupleKeyedFailure<TKey, TValue> extends never
        ? never
        : number extends TValue["length"]
          ? {
              key: TKey;
              index: number;
              error: TValue extends readonly (infer V)[]
                ? V extends AwaitableEntry<infer T>
                  ? EntryFailureFromValue<T>
                  : never
                : never;
            }
          : TupleKeyedFailure<TKey, TValue>
      : TValue extends ReadonlyMap<infer K extends PropertyKey, infer V>
        ? V extends AwaitableEntry<infer T>
          ? EntryFailureFromValue<T> extends never
            ? never
            : { key: TKey; mapKey: K; error: EntryFailureFromValue<T> }
          : never
        : never;

export type KeyedSuccess<E> = E extends object
  ? {
      [K in keyof E & PropertyKey]: KeyedSuccessForProperty<K, E[K]>;
    }[keyof E & PropertyKey]
  : never;

export type KeyedFailure<E> = E extends object
  ? {
      [K in keyof E & PropertyKey]: KeyedFailureForProperty<K, E[K]>;
    }[keyof E & PropertyKey]
  : never;

export interface SomeBranchesFailed<E> {
  readonly code: "SomeBranchesFailed";
  readonly message: string;
  readonly details: {
    readonly failures: KeyedFailure<E>[];
    readonly completed: KeyedSuccess<E>[];
  };
}

export interface NoBranchCompleted<E> {
  readonly code: "NoBranchCompleted";
  readonly message: string;
  readonly details: {
    readonly failures: KeyedFailure<E>[];
  };
}

export interface QuorumNotMet<E> {
  readonly code: "QuorumNotMet";
  readonly message: string;
  readonly details: {
    readonly required: number;
    readonly got: number;
    readonly failures: KeyedFailure<E>[];
    readonly completed: KeyedSuccess<E>[];
  };
}

type InferBranchArgsInput<B> =
  B extends BranchDefinition<infer TArgs, any, any, any, any>
    ? SchemaInvocationInput<TArgs>
    : never;

type InferBranchResult<B> =
  B extends BranchDefinition<any, infer TResult, any, any, any>
    ? StandardSchemaV1.InferOutput<TResult>
    : never;

type InferBranchErrors<B> =
  B extends BranchDefinition<any, any, any, any, infer TErrors>
    ? TErrors
    : Record<string, never>;

export interface BranchAccessor<
  B extends BranchDefinition<any, any, any, any, any>,
  TScopePath extends ScopePath,
  TRoot extends RootScope,
> {
  (
    args: InferBranchArgsInput<B>,
  ): BranchEntry<
    DefinedBranchResult<InferBranchResult<B>, InferBranchErrors<B>>,
    TScopePath,
    TRoot
  >;
}

/**
 * Maps closure entries to their corresponding branch handle types.
 *
 * @typeParam E          - Record of branch closures `(ctx: any) => Promise<unknown>`.
 * @typeParam TScopePath - The scope path where these handles are created.
 * @typeParam TRoot      - The root context.
 */
export type ScopeHandles<
  E,
  TScopePath extends ScopePath,
  TRoot extends RootScope,
> =
  E extends AwaitableEntry<infer T>
    ? BranchEntry<T, TScopePath, TRoot>
    : E extends readonly unknown[]
      ? { readonly [K in keyof E]: ScopeHandles<E[K], TScopePath, TRoot> }
      : E extends ReadonlyMap<infer K, infer V>
        ? ReadonlyMap<K, ScopeHandles<V, TScopePath, TRoot>>
        : E extends object
          ? { readonly [K in keyof E]: ScopeHandles<E[K], TScopePath, TRoot> }
          : never;

/**
 * Result type for `ctx.first()` — a discriminated union of `{ key, result }` pairs
 * for the first branch to complete.
 *
 * @typeParam E - Generalized entry structure.
 */
export type MatchEvent<TKey extends PropertyKey, TResult> = {
  key: TKey;
  result: TResult;
};

type TupleResultUnion<E extends readonly unknown[]> = {
  [K in TupleIndexKeys<E>]: ScopeSuccessResults<E[K]>;
}[TupleIndexKeys<E>];

type MatchEventForProperty<TKey extends PropertyKey, TValue> =
  TValue extends AwaitableEntry<infer T>
    ? MatchEvent<TKey, EntrySuccessFromValue<T>>
    : TValue extends readonly unknown[]
      ? number extends TValue["length"]
        ? MatchEvent<
            TKey,
            TValue extends readonly (infer V)[] ? ScopeSuccessResults<V> : never
          > & { index: number }
        : MatchEvent<TKey, TupleResultUnion<TValue>> & {
            index: TupleIndexes<TValue>;
          }
      : TValue extends ReadonlyMap<infer K extends PropertyKey, infer V>
        ? MatchEvent<TKey, ScopeSuccessResults<V>> & { mapKey: K }
        : never;

export type MatchEvents<E> = E extends object
  ? {
      [K in keyof E & PropertyKey]: MatchEventForProperty<K, E[K]>;
    }[keyof E & PropertyKey]
  : never;

export type FirstResult<E> = KeyedSuccess<E>;

// =============================================================================
// SELECT / LISTEN — HANDLE TYPES
// =============================================================================

/**
 * Handle types that can be passed into `ctx.select()` (concurrency contexts only).
 *
 * - `BranchHandle<T>` — scope branches (finite, can fail).
 * - `ChannelHandle<T>` — stream-like; the branch is **never exhausted** and
 *   delivers a new message each time it is selected. Use when you want to keep
 *   reading from a channel indefinitely (e.g. long-running consumer loops).
 *   Note: `sel.remaining` will never drop the channel key.
 * - `ChannelReceiveCall<T>` — one-shot; produced by `ctx.channels.<n>.receive(...)`.
 *   The key is removed from `remaining` once the receive resolves.
 */
export type ScopeSelectableHandle =
  | BranchEntry<any>
  | ChannelHandle<any>
  | ChannelReceiveCall<any>;

/**
 * Handle types that can be passed into `ctx.listen()` (all contexts).
 *
 * Listen is channel-only — branch handles are not allowed.
 * Use `ctx.select()` on concurrency contexts for branch handle coordination.
 */
export type ListenableHandle = ChannelHandle<any> | ChannelReceiveCall<any>;

export type ScopeSelectableRecordForPath<
  M extends Record<string, ScopeSelectableHandle>,
  TCurrentPath extends ScopePath,
> = {
  [K in keyof M & string]: RestrictSelectableHandleToPath<M[K], TCurrentPath>;
};

type RestrictSelectableHandleToPath<H, TCurrentPath extends ScopePath> =
  H extends BranchEntry<infer T, infer THandlePath>
    ? IsPrefix<THandlePath, TCurrentPath> extends true
      ? BranchEntry<T, THandlePath>
      : never
    : H extends ChannelHandle<any> | ChannelReceiveCall<any>
      ? H
      : never;

// =============================================================================
// SELECT — EVENT TYPES (WorkflowContext)
// =============================================================================

/**
 * Map a handle type to its select event result type.
 *
 * - BranchHandle: `{ key, status: "complete", data: T } | { key, status: "failed", failure }`
 * - ChannelHandle: `{ key, data: T }` (fires repeatedly — never exhausted)
 * - ChannelReceiveCall: `{ key, data: T }` (fires once — key removed from remaining)
 */
export type HandleSelectEvent<K extends string, H> =
  H extends BranchEntry<infer T>
    ? { key: K; status: "complete"; data: T } | { key: K; status: "failed" }
    : H extends ChannelHandle<infer T>
      ? { key: K; data: T }
      : H extends ChannelReceiveCall<infer T>
        ? { key: K; data: T }
        : never;

/**
 * What a match handler receives for a specific key.
 *
 * - BranchHandle<T>: `T` directly
 * - ChannelHandle<T>: `T` directly (fires repeatedly)
 * - ChannelReceiveCall<T>: `T` directly (fires once)
 */
export type HandleMatchData<H> =
  H extends BranchEntry<infer T>
    ? T
    : H extends ChannelHandle<infer T>
      ? T
      : H extends ChannelReceiveCall<infer T>
        ? T
        : never;

/**
 * Union of all possible events from a select record.
 */
export type SelectEvent<M extends Record<string, ScopeSelectableHandle>> = {
  [K in keyof M & string]: HandleSelectEvent<K, M[K]>;
}[keyof M & string];

/**
 * Extract the successful data type from any selectable handle.
 */
type SelectHandleData<H> =
  H extends BranchEntry<infer T>
    ? T
    : H extends ChannelHandle<infer T>
      ? T
      : H extends ChannelReceiveCall<infer T>
        ? T
        : never;

/**
 * Keyed union type yielded by `ctx.match(sel)` (no-handler form).
 * Each element is `{ key: K; result: SelectHandleData<M[K]> }`.
 */
export type SelectDataKeyedUnion<
  M extends Record<string, ScopeSelectableHandle>,
> = {
  [K in keyof M & string]: { key: K; result: SelectHandleData<M[K]> };
}[keyof M & string];

// =============================================================================
// MATCH HELPERS
// =============================================================================

/**
 * Extract the return type from a match handler entry.
 *
 * - Plain function: returns the function's return type.
 * - `{ complete, failure }`: returns the union of both return types.
 * - `{ complete }` only: returns the complete return type (failure terminates).
 * - `{ failure }` only: returns TData (identity for complete) | failure return type.
 * - `undefined` or omitted: returns TData (identity — data passed through unchanged).
 *
 * TData is the raw data type for the handle — used as the identity return
 * when `complete` is not explicitly provided.
 */
type ExtractHandlerReturn<H, TData = never> = H extends undefined
  ? TData
  : H extends (...args: any[]) => infer R
    ? Awaited<R>
    : H extends {
          complete: (...args: any[]) => infer R;
          failure: (...args: any[]) => infer R2;
        }
      ? Awaited<R> | Awaited<R2>
      : H extends { failure: (...args: any[]) => infer R2 }
        ? TData | Awaited<R2>
        : H extends { complete: (...args: any[]) => infer R }
          ? Awaited<R>
          : TData;

/**
 * True when a handler entry has an explicit `failure` callback.
 * Used to determine whether the default failure handler applies.
 */
type HasExplicitFailure<H> = H extends { failure: (...args: any[]) => any }
  ? true
  : false;

// =============================================================================
// MATCH HANDLER ENTRY TYPES
// =============================================================================

/**
 * A match handler entry for a specific key.
 *
 * For BranchHandle keys, four forms are accepted:
 * - Plain function: handles complete only; failure auto-terminates (or uses `onFailure`).
 * - `{ complete, failure }`: both paths handled explicitly.
 * - `{ complete }` only: failure auto-terminates (or uses `onFailure`).
 * - `{ failure }` only: complete yields data unchanged (identity); failure handled explicitly.
 *
 * For channel handles and one-shot receive calls, only a plain function is allowed
 * (channels never fail).
 */
export type MatchHandlerEntry<H extends ScopeSelectableHandle> =
  H extends BranchEntry<any>
    ?
        | ((data: HandleMatchData<H>) => any)
        | {
            complete: (data: HandleMatchData<H>) => any;
            failure: (
              info: ScopeFailureInfo<StepDefinitions, WorkflowDefinitions>,
            ) => any;
          }
        | { complete: (data: HandleMatchData<H>) => any }
        | {
            failure: (
              info: ScopeFailureInfo<StepDefinitions, WorkflowDefinitions>,
            ) => any;
          }
    : (data: HandleMatchData<H>) => any;

/**
 * Handler map for `ctx.match()`.
 */
export type MatchHandlers<M extends Record<string, ScopeSelectableHandle>> = {
  [K in keyof M & string]?: MatchHandlerEntry<M[K]>;
};

/**
 * Yield type of `ctx.match()` iteration.
 *
 * Iterates over ALL keys in M (not just those in H):
 * - Keys in H with an explicit `failure` handler: sealed — `DF` does not apply.
 * - Keys in H without an explicit `failure` handler: `ExtractHandlerReturn<H[K], TData> | DF`.
 * - Keys NOT in H: identity (`HandleMatchData<M[K]>`) + `DF` for failures.
 *
 * When `DF = never` (no `onFailure` argument), branch failures on unhandled paths
 * auto-terminate the workflow and contribute nothing to the yield type.
 */
export type MatchReturn<
  M extends Record<string, ScopeSelectableHandle>,
  H extends MatchHandlers<M>,
  DF = never,
> = {
  [K in keyof M & string]: K extends keyof H & string
    ? HasExplicitFailure<H[K]> extends true
      ? ExtractHandlerReturn<H[K], HandleMatchData<M[K]>>
      : ExtractHandlerReturn<H[K], HandleMatchData<M[K]>> | DF
    : HandleMatchData<M[K]> | DF;
}[keyof M & string];

// =============================================================================
// SELECTION (WorkflowConcurrencyContext)
// =============================================================================

/**
 * A selection — multiplexes multiple handles and yields events as they arrive.
 * Events are ordered by global_sequence for deterministic replay.
 *
 * Iterate over events using `ctx.match(sel, ...)` on the concurrency context.
 * `sel.remaining` tracks which handles are still active.
 *
 * @typeParam M - The handle record type.
 */
export interface Selection<M extends Record<string, ScopeSelectableHandle>> {
  /**
   * Live set of unresolved handle keys.
   */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// SELECTION (CompensationConcurrencyContext)
// =============================================================================

/**
 * A selection in CompensationConcurrencyContext.
 *
 * Iterate over events using `ctx.match(sel, ...)` on the compensation concurrency context.
 * `sel.remaining` tracks which handles are still active.
 */
export interface CompensationSelection<
  M extends Record<string, ScopeSelectableHandle>,
> {
  /**
   * Live set of unresolved handle keys.
   */
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// LISTENER — for ctx.listen() (all contexts)
// =============================================================================

/**
 * Event type yielded by a `Listener<M>` on each iteration.
 * Each event is `{ key: K; message: T }` where T is the channel's message type.
 */
export type ListenerEvent<M extends Record<string, ListenableHandle>> = {
  [K in keyof M & string]: {
    key: K;
    message: M[K] extends ChannelHandle<infer T>
      ? T
      : M[K] extends ChannelReceiveCall<infer T>
        ? T
        : never;
  };
}[keyof M & string];

/**
 * A listener — channel-only multiplexed iteration handle returned by `ctx.listen()`.
 *
 * Directly iterable via `for await (const { key, message } of listener) { ... }`.
 * `listener.remaining` tracks which one-shot receives are still pending
 * (raw `ChannelHandle` keys are never removed).
 *
 * @typeParam M - Record of `ListenableHandle` values.
 */
export interface Listener<
  M extends Record<string, ListenableHandle>,
> extends AsyncIterable<ListenerEvent<M>> {
  readonly remaining: ReadonlySet<keyof M & string>;
}

// =============================================================================
// SCHEDULE
// =============================================================================

/**
 * Options for cron-like schedule creation.
 */
export interface ScheduleOptions {
  /** IANA timezone identifier (default: UTC). */
  timezone?: string;
  /**
   * Explicit schedule anchor time.
   *
   * The first emitted tick is the first schedule point STRICTLY after this
   * instant (never equal), preventing duplicate boundary ticks during handoff.
   */
  resumeAt?: Date | number;
}

/**
 * One deterministic schedule tick produced by `ScheduleHandle`.
 */
export interface ScheduleTick {
  /** Intended execution time for this tick (pure cron math). */
  readonly scheduledAt: Date;
  /** Intended execution time for the next tick. */
  readonly nextScheduledAt: Date;
  /** Convenience value: seconds between `scheduledAt` and `nextScheduledAt`. */
  readonly secondsUntilNext: number;
  /** 0-based monotonically increasing tick counter. */
  readonly index: number;
}

/**
 * Handle returned by `ctx.schedule()` for cron-like recurring execution.
 */
export interface ScheduleHandle extends AsyncIterable<ScheduleTick> {
  /**
   * Suspend until the next scheduled tick.
   * Returns immediately if the next scheduled time is already in the past.
   */
  sleep(): BlockingResult<ScheduleTick>;
  /**
   * Cancel a pending sleep and stop future iteration.
   */
  cancel(): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<ScheduleTick>;
}

// =============================================================================
// LOGGER
// =============================================================================

/**
 * Workflow logger — replay-aware.
 *
 * This logger is replay-aware and only emits logs when the workflow is executing
 * NEW code (past the replay boundary). During replay, all log calls are suppressed
 * to avoid polluting logs with duplicate messages.
 *
 * Steps should NOT use this logger. Use your own application logger (console.log,
 * Winston, Pino, etc.) inside step implementations.
 */
export interface WorkflowLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// =============================================================================
// STEP CALL — THENABLE BUILDER (WorkflowContext)
// =============================================================================

/**
 * Thenable returned by calling a step in WorkflowContext.
 *
 * Chain builder methods before awaiting:
 * - `.compensate()` — register compensation callback (switches HasCompensation to true)
 * - `.retry()` — override retry policy
 * - `.failure()` — handle failure explicitly instead of auto-terminating; return TFail
 * - `.complete()` — transform success result
 *
 * Await the call via `stepCall.resolve(ctx)` to resolve to `T | TFail`.
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for this workflow.
 */
export interface StepCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DurableHandle<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback for this step.
   * Runs during LIFO unwinding when the workflow fails.
   */
  compensate(
    cb: (ctx: Tctx, result: StepCompensationResult<T>) => Promise<void>,
  ): StepCall<T, TFail, true, Tctx>;

  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): StepCall<T, TFail, HasCompensation, Tctx>;

  /**
   * Handle step failure explicitly — the workflow does NOT auto-terminate.
   * The callback return value becomes TFail in the resolved union.
   */
  failure<R>(
    cb: (failure: StepFailureInfo) => R,
  ): StepCall<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the success result.
   * The callback return value replaces T in the resolved type.
   */
  complete<R>(
    cb: (data: T) => R,
  ): StepCall<Awaited<R>, TFail, HasCompensation, Tctx>;
}

// =============================================================================
// COMPENSATION STEP CALL — THENABLE (CompensationContext)
// =============================================================================

/**
 * Thenable returned by calling a step in CompensationContext.
 *
 * Always resolves to `CompensationStepResult<T>` — compensation code MUST
 * handle both ok and !ok cases gracefully.
 *
 * Only `.retry()` is available — no `.compensate()` (can't nest compensations),
 * no `.failure()` (failures are in the result union).
 *
 * @typeParam T - Decoded step result type (z.output<Schema>).
 */
export interface CompensationStepCall<T> extends DurableHandle<
  CompensationStepResult<T>,
  CompensationRoot
> {
  /**
   * Override the step's retry policy.
   */
  retry(policy: RetryPolicyOptions): CompensationStepCall<T>;
}

// =============================================================================
// FOREIGN WORKFLOW HANDLE
// =============================================================================

/**
 * A limited handle to an existing (non-child) workflow instance.
 * Only channels.send() is available — prevents tight coupling.
 * Send is fire-and-forget: returns void, no delivery confirmation.
 */
export interface ForeignWorkflowHandle<
  TChannels extends ChannelDefinitions = Record<string, never>,
> {
  readonly idempotencyKey: string;

  /**
   * Channels for sending messages to this workflow.
   * Fire-and-forget: returns void.
   */
  readonly channels: {
    [K in keyof TChannels]: {
      send(data: StandardSchemaV1.InferInput<TChannels[K]>): AtomicResult<void>;
    };
  };
}

// =============================================================================
// WORKFLOW CALL — THENABLE BUILDER (WorkflowContext)
// =============================================================================

/**
 * Thenable returned after applying at least one result-mode builder
 * (`.compensate()`, `.failure()`, `.complete()`) on a `WorkflowCall`.
 *
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of the `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowCallResult<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DurableHandle<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback for this child workflow invocation.
   * Runs during LIFO unwinding when the parent workflow fails.
   */
  compensate(
    cb: (
      ctx: Tctx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, Tctx>;

  /**
   * Handle child workflow failure explicitly — the parent does NOT auto-terminate.
   */
  failure<R>(
    cb: (failure: ChildWorkflowFailureInfo) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the child workflow's success result.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, Tctx>;
}

/**
 * Thenable returned by calling a child workflow accessor in WorkflowContext.
 *
 * Structured result mode for child workflow calls.
 *
 * Call the accessor with `{ detached: true }` to use detached messaging mode instead,
 * which returns a `ForeignWorkflowHandle` directly from the accessor call.
 *
 * @typeParam T - Decoded child workflow result type.
 * @typeParam TFail - Return type of `.failure()` callback (never if not used).
 * @typeParam HasCompensation - Whether `.compensate()` has been called.
 * @typeParam Tctx - The CompensationContext type for the parent workflow.
 */
export interface WorkflowCall<
  T,
  TFail = never,
  HasCompensation extends boolean = false,
  Tctx = unknown,
> extends DurableHandle<T | TFail, ExecutionRoot> {
  /**
   * Register a compensation callback.
   */
  compensate(
    cb: (
      ctx: Tctx,
      result: ChildWorkflowCompensationResult<T>,
    ) => Promise<void>,
  ): WorkflowCallResult<T, TFail, true, Tctx>;

  /**
   * Handle child workflow failure explicitly.
   */
  failure<R>(
    cb: (failure: ChildWorkflowFailureInfo) => R,
  ): WorkflowCallResult<T, Awaited<R>, HasCompensation, Tctx>;

  /**
   * Transform the child workflow's success result — enters result mode.
   */
  complete<R>(
    cb: (data: T) => R,
  ): WorkflowCallResult<Awaited<R>, TFail, HasCompensation, Tctx>;
}

export interface ScopeCall<
  T,
  TFail = never,
  TSteps extends StepDefinitions = StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = WorkflowDefinitions,
  TRoot extends RootScope = RootScope,
> extends DurableHandle<T | TFail, TRoot> {
  /**
   * Handle scope/all failure after the scope has fully unwound.
   */
  failure<R>(
    cb: (failure: ScopeFailureInfo<TSteps, TChildWorkflows>) => R,
  ): ScopeCall<T, Awaited<R>, TSteps, TChildWorkflows, TRoot>;
}

export interface FirstCall<
  T,
  E extends Record<string, ScopeEntry<any>>,
  TFail = never,
  TSteps extends StepDefinitions = StepDefinitions,
  TChildWorkflows extends WorkflowDefinitions = WorkflowDefinitions,
  TRoot extends RootScope = RootScope,
> extends DurableHandle<T | TFail, TRoot> {
  /**
   * Handle the "all branches failed" case for first().
   */
  failure<R>(
    cb: (failures: AllBranchesFailedInfo<E, TSteps, TChildWorkflows>) => R,
  ): FirstCall<T, E, Awaited<R>, TSteps, TChildWorkflows, TRoot>;
}

// =============================================================================
// COMPENSATION WORKFLOW CALL — THENABLE (CompensationContext)
// =============================================================================

/**
 * Thenable returned by calling a child workflow accessor in CompensationContext.
 * Always resolves to `WorkflowResult<T>` — compensation code MUST handle all outcomes.
 *
 * @typeParam T - Decoded child workflow result type.
 */
export interface CompensationWorkflowCall<T> extends DurableHandle<
  WorkflowResult<T>,
  CompensationRoot
> {}

// =============================================================================
// WORKFLOW ACCESSORS (CONTEXT-SPECIFIC)
// =============================================================================

/**
 * Base start options for a child workflow call.
 */
export type ChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  WorkflowInvocationBaseOptions<
    InferWorkflowArgsInput<W>,
    InferWorkflowMetadataInput<W>
  >;

export interface ChildWorkflowCallOptions {
  readonly retry?: RetryPolicyOptions;
}

export interface ChildWorkflowTimeoutCallOptions extends ChildWorkflowCallOptions {
  readonly timeout: StepBoundary;
}

/**
 * Child workflow start options in attached mode.
 * Retention is inherited from the parent workflow.
 */
export type AttachedChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W>;

/**
 * Child workflow start options in detached mode.
 * Detached children may override retention independently from the parent.
 * The `detached: true` flag is implied by calling `.startDetached()`.
 */
export type DetachedStartOptions<W extends AnyWorkflowHeader> =
  ChildWorkflowStartOptions<W> & {
    retention?: number | RetentionSetter<"complete" | "failed" | "terminated">;
  };

/**
 * Start options for child workflow calls in compensation context.
 */
export type CompensationChildWorkflowStartOptions<W extends AnyWorkflowHeader> =
  WorkflowInvocationBaseOptions<
    InferWorkflowArgsInput<W>,
    InferWorkflowMetadataInput<W>
  >;

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in WorkflowContext.
 *
 * @typeParam W - The child workflow definition.
 * @typeParam Tctx - The parent workflow's CompensationContext type.
 */
export interface ChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
  Tctx = unknown,
> {
  (
    options: AttachedChildWorkflowStartOptions<W>,
  ): WorkflowEntry<
    AttachedChildWorkflowResult<
      InferWorkflowResult<W>,
      ErrorValue<InferWorkflowErrors<W>>
    >
  >;

  (
    options: AttachedChildWorkflowStartOptions<W>,
    opts: ChildWorkflowTimeoutCallOptions,
  ): WorkflowEntry<
    | AttachedChildWorkflowResult<
        InferWorkflowResult<W>,
        ErrorValue<InferWorkflowErrors<W>>
      >
    | { ok: false; status: "timeout" }
  >;

  (
    options: AttachedChildWorkflowStartOptions<W>,
    opts: ChildWorkflowCallOptions,
  ): WorkflowEntry<
    AttachedChildWorkflowResult<
      InferWorkflowResult<W>,
      ErrorValue<InferWorkflowErrors<W>>
    >
  >;

  /**
   * Start this child workflow in detached mode.
   *
   * The child runs independently — the parent does not wait for its result and
   * lifecycle is not managed. Returns a `ForeignWorkflowHandle` for fire-and-forget
   * channel messaging.
   *
   * This is a buffered, synchronous-at-engine-level operation. It does not
   * create an awaitable scope entry and does not yield.
   */
  startDetached(
    options: DetachedStartOptions<W>,
  ): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

export type AttachedChildWorkflowResult<T, TError = unknown> =
  | { ok: true; result: T }
  | { ok: false; status: "failed"; error: TError };

export interface RequestCallOptions {
  readonly priority?: number;
}

export interface RequestTimeoutCallOptions extends RequestCallOptions {
  readonly timeout: StepBoundary;
}

export interface RequestAccessor<
  TPayloadSchema extends StandardSchemaV1,
  TResponse,
> {
  (payload: SchemaInvocationInput<TPayloadSchema>): RequestEntry<TResponse>;
  (
    payload: SchemaInvocationInput<TPayloadSchema>,
    opts: RequestTimeoutCallOptions,
  ): RequestEntry<TimeoutResult<TResponse>>;
  (
    payload: SchemaInvocationInput<TPayloadSchema>,
    opts: RequestCallOptions,
  ): RequestEntry<TResponse>;
}

/**
 * Foreign workflow accessor on `ctx.foreignWorkflows` in WorkflowContext.
 *
 * Use `.get(idempotencyKey)` to obtain a `ForeignWorkflowHandle` for an existing
 * (non-child) workflow instance. Only `channels.send()` is available — no
 * events, streams, or lifecycle (prevents tight coupling).
 *
 * @typeParam W - The workflow definition (for channel type inference).
 */
export interface ForeignWorkflowAccessor<W extends AnyWorkflowHeader> {
  /**
   * Get a limited handle to an existing workflow instance.
   * Only channels.send() is available (fire-and-forget).
   *
   * @param idempotencyKey - The workflow idempotency key.
   */
  get(idempotencyKey: string): ForeignWorkflowHandle<InferWorkflowChannels<W>>;
}

/**
 * Callable child workflow accessor on `ctx.childWorkflows` in CompensationContext.
 * Returns full `WorkflowResult<T>` — compensation code must handle all outcomes.
 *
 * @typeParam W - The child workflow definition.
 */
export interface CompensationChildWorkflowAccessor<
  W extends AnyWorkflowHeader,
> {
  (
    options: CompensationChildWorkflowStartOptions<W>,
  ): WorkflowEntry<WorkflowResult<InferWorkflowResult<W>>>;
}

// =============================================================================
// LIFECYCLE EVENTS
// =============================================================================

/**
 * Engine-managed phase lifecycle event names.
 * Automatically managed by the engine — cannot be set by user code.
 *
 * Shared across execution and compensation phases:
 *
 * - started:    set when the phase begins
 * - complete:   set when the phase completes successfully
 * - failed:     set when the phase fails
 * - terminated: set when the phase is terminated
 *
 * After a phase reaches a terminal state, all unset events are marked "never" —
 * they will never fire.
 */
export type PhaseLifecycleEventName =
  | "started"
  | "complete"
  | "failed"
  | "terminated";

/**
 * Lifecycle event accessor — supports wait/get with "never" semantics.
 */
export interface LifecycleEventAccessor {
  /**
   * Wait for the lifecycle event to be set.
   * Returns "never" if the workflow reached a terminal state without this event firing.
   */
  wait(): BlockingResult<EventWaitResultNoTimeout>;

  /**
   * Wait for the lifecycle event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): BlockingResult<EventWaitResult>;

  /**
   * Check if the lifecycle event is set (non-blocking).
   */
  get(): AtomicResult<EventCheckResult>;
}

/**
 * User-defined event accessor for reading (on child/external handles).
 * Supports "never" semantics.
 */
export interface EventAccessorReadonly {
  /**
   * Wait for the event to be set.
   * Returns "never" if the workflow reached a terminal state without setting this event.
   */
  wait(): BlockingResult<EventWaitResultNoTimeout>;

  /**
   * Wait for the event to be set, with a timeout (in seconds).
   */
  wait(timeoutSeconds: number): BlockingResult<EventWaitResult>;

  /**
   * Check if the event is set (non-blocking).
   */
  get(): AtomicResult<EventCheckResult>;
}

/**
 * Lifecycle events available for a single workflow phase.
 */
export interface PhaseLifecycleEvents {
  readonly started: LifecycleEventAccessor;
  readonly complete: LifecycleEventAccessor;
  readonly failed: LifecycleEventAccessor;
  readonly terminated: LifecycleEventAccessor;
}

// =============================================================================
// BASE CONTEXT (shared between WorkflowContext and CompensationContext)
// =============================================================================

/**
 * Base context shared between WorkflowContext and CompensationContext.
 * Contains all primitives that are identical between the two contexts.
 */
export interface BaseContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> {
  /** Unique internal workflow instance identifier (not the idempotency key). */
  readonly workflowId: string;

  /** Replay-aware logger */
  readonly logger: WorkflowLogger;

  /**
   * Channels for receiving messages.
   * Receive returns z.output<Schema> (decoded).
   */
  readonly channels: {
    [K in keyof TChannels]: ChannelHandle<
      StandardSchemaV1.InferOutput<TChannels[K]>
    >;
  };

  /**
   * Streams for outputting data.
   * Write accepts z.input<Schema> (encoded).
   */
  readonly streams: {
    [K in keyof TStreams]: StreamAccessor<
      StandardSchemaV1.InferInput<TStreams[K]>
    >;
  };

  /**
   * Events for signaling.
   */
  readonly events: {
    [K in keyof TEvents]: EventAccessor;
  };

  /**
   * Patches for safe, incremental workflow evolution.
   */
  readonly patches: {
    [K in keyof TPatches]: PatchAccessor;
  };

  /**
   * Durable sleep.
   * @param seconds - Duration in seconds.
   */
  sleep(seconds: number): BlockingResult<void>;

  /**
   * Durable sleep until a target instant.
   * @param target - Target time as Date or epoch milliseconds.
   */
  sleepUntil(target: Date | number): BlockingResult<void>;

  /**
   * Deterministic random utilities.
   */
  readonly rng: RngAccessors<TRng>;

  /** Deterministic timestamp (milliseconds since epoch) */
  readonly timestamp: number;
  /** Deterministic Date object */
  readonly date: Date;
}

// =============================================================================
// COMPENSATION CONTEXT
// =============================================================================

/**
 * Context available inside compensation callbacks and hooks (beforeCompensate,
 * afterCompensate, and beforeSettle when status is failed/terminated).
 *
 * Key differences from WorkflowContext:
 * - Steps return `CompensationStepResult<T>` via `CompensationStepCall<T>` —
 *   compensation code MUST handle failures gracefully.
 * - Has `scope(name, ...)`, `all(...)`, `first(...)`, and `listen()`.
 * - Full structured-concurrency primitives (`select` with branch handles, `match`)
 *   are available only inside `scope(name, ...)` via `CompensationConcurrencyContext`.
 * - `childWorkflows` return `CompensationWorkflowCall<T>` → `WorkflowResult<T>`.
 * - No `addCompensation()` (prevents nested compensation chains).
 * - No `foreignWorkflows` accessor (fire-and-forget not needed in compensation).
 *
 * The engine transparently interleaves compensation callbacks from the same
 * scope via a virtual event loop. Each callback looks like normal sequential
 * code — the engine handles concurrency at durable operation yield points.
 *
 * @typeParam TScopePath - The scope path of this context instance. Defaults to `[]`
 *   for the root compensation context; branch closures receive a path-specialized
 *   instance with `AppendBranchKey<AppendScopeName<...>, K>`.
 */
export interface CompensationContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
>
  extends
    BaseContext<TState, TChannels, TStreams, TEvents, TPatches, TRng>,
    CompensationResolver {
  /**
   * Steps for durable operations.
   * Calling a step returns `CompensationStepCall<T>` — awaits to `CompensationStepResult<T>`.
   * Must handle failures gracefully — compensation cannot crash.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema,
      any
    >
      ? StepAccessor<
          TArgs,
          CompensationStepResult<StandardSchemaV1.InferOutput<TResultSchema>>
        >
      : never;
  };

  /**
   * Requests for external request-response work.
   */
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      infer TPayload,
      infer TResponseSchema
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };

  /**
   * Child workflows.
   * Calling an accessor returns `CompensationWorkflowCall<T>` — awaits to `WorkflowResult<T>`.
   * Must handle all outcomes (complete, failed, terminated).
   */
  readonly childWorkflows: {
    [K in keyof TChildWorkflows]: CompensationChildWorkflowAccessor<
      TChildWorkflows[K]
    >;
  };

  /**
   * Foreign workflow accessors — message-only handles to existing workflow instances.
   * Use `.get(idempotencyKey)` to get a `ForeignWorkflowHandle` with `channels.send()` only.
   * No lifecycle, events, streams, or compensation (prevents tight coupling).
   */
  readonly foreignWorkflows: {
    [K in keyof TForeignWorkflows]: ForeignWorkflowAccessor<
      TForeignWorkflows[K]
    >;
  };

  // ---------------------------------------------------------------------------
  // execute — resolve a deterministic handle
  // ---------------------------------------------------------------------------

  /**
   * Resolve a branch handle created in an ancestor scope from within a branch
   * closure of a nested compensation scope.
   *
   * Branch closures receive a path-specialized `CompensationContext` whose
   * `TScopePath` extends the parent scope's path. `join` enforces at compile
   * time that the handle's scope path is a prefix of the current scope path —
   * guaranteeing the handle was created in a scope that is still live (i.e. an
   * ancestor of the current branch).
   *
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles such as steps,
   * child workflows, and `scope()`/`all()`/`first()` results.
   */
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency in compensation (closure-based)
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency in compensation.
   *
   * Each entry is an async closure `(ctx: CompensationContext<..., BranchPath>) => Promise<T>`.
   * The `ctx` argument is a path-specialized `CompensationContext` with the branch's
   * exact scope path, enabling compile-time lifetime tracking.
   *
   * On scope exit, all running branches are awaited to completion.
   * No per-branch compensation — compensation cannot nest.
   *
   * Resolve the scope result: `await ctx.scope("Name", entries, callback).resolve(ctx)`.
   *
   * Use `.failure(cb)` to handle scope failures after unwinding.
   */
  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        CompensationRoot
      >,
    ) => Promise<R>,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  // ---------------------------------------------------------------------------
  // listen — channel-only multiplexed waiting (all contexts)
  // ---------------------------------------------------------------------------

  /**
   * Create a listener for concurrent channel waiting.
   *
   * Accepts only channel handles (`ChannelHandle` and `ChannelReceiveCall`).
   * Directly iterable: `for await (const { key, message } of listener) { ... }`.
   *
   * - `ChannelHandle` — streaming; never removed from `remaining`.
   * - `ChannelReceiveCall` — one-shot; removed from `remaining` after resolving.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;
}

/**
 * Layer 3 compensation callback type (for addCompensation).
 * Receives CompensationContext — no step result, used for general-purpose cleanup.
 */
export type CompensationCallback<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
> = (
  ctx: CompensationContext<
    TState,
    TChannels,
    TStreams,
    TEvents,
    TSteps,
    TRequests,
    TChildWorkflows,
    TForeignWorkflows,
    TPatches,
    TRng
  >,
) => Promise<void>;

// =============================================================================
// WORKFLOW CONTEXT
// =============================================================================

/**
 * Workflow context provided to the execute function.
 *
 * Implements the happy-path model: calling a step or child workflow returns a
 * thenable (`StepCall<T>` or `WorkflowCall<T>`) that resolves to T directly.
 * Failure auto-terminates the workflow and triggers LIFO compensation.
 *
 * Builder pattern for explicit control:
 * - `.compensate(cb)` — register compensation callback
 * - `.retry(policy)` — override retry policy
 * - `.failure(cb)` — handle failure without auto-termination
 * - `.complete(cb)` — transform success result
 *
 * Structured concurrency via `ctx.scope(name, entries, callback)`:
 * every concurrent branch runs as a closure `(ctx) => Promise<T>`.
 * Branches with compensated steps are compensated on scope exit.
 *
 * Resolve handles with `handle.resolve(ctx)`. Inside scope callbacks, use
 * `ctx.join(handle)` on the `WorkflowConcurrencyContext` for branch handle coordination.
 *
 * Base `ctx.listen()` is channel-only.
 * Full concurrency primitives (`select` with branch handles and `match`) are
 * available only inside `ctx.scope(name, ...)` via `WorkflowConcurrencyContext`.
 *
 * @typeParam TScopePath - The scope path of this context instance. Defaults to `[]`
 *   for the root execution context; branch closures receive a path-specialized
 *   instance with `AppendBranchKey<AppendScopeName<...>, K>`.
 */
export interface WorkflowContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TErrors extends ErrorDefinitions = Record<string, never>,
  TBranches extends BranchDefinitions = Record<string, never>,
>
  extends
    BaseContext<TState, TChannels, TStreams, TEvents, TPatches, TRng>,
    ExecutionResolver {
  /**
   * Steps for durable operations.
   * Calling a step returns a `StepCall<T>` thenable — chain builders before executing.
   * Without `.failure()`, failure auto-terminates the workflow.
   */
  readonly steps: {
    [K in keyof TSteps]: TSteps[K] extends StepDefinition<
      infer TArgs,
      infer TResultSchema,
      any
    >
      ? StepAccessor<TArgs, StandardSchemaV1.InferOutput<TResultSchema>>
      : never;
  };

  /**
   * Requests for external request-response work.
   */
  readonly requests: {
    [K in keyof TRequests]: TRequests[K] extends RequestDefinition<
      infer TPayload,
      infer TResponseSchema
    >
      ? RequestAccessor<TPayload, StandardSchemaV1.InferOutput<TResponseSchema>>
      : never;
  };

  /**
   * Child workflow accessors — structured invocation (lifecycle managed by parent).
   * Calling an accessor returns a `WorkflowCall<T>` (result mode with builders).
   * Use `.startDetached(opts)` to start without lifecycle management.
   */
  readonly childWorkflows: {
    [K in keyof TChildWorkflows]: ChildWorkflowAccessor<
      TChildWorkflows[K],
      CompensationContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng
      >
    >;
  };

  /**
   * Foreign workflow accessors — message-only handles to existing workflow instances.
   * Use `.get(idempotencyKey)` to get a `ForeignWorkflowHandle` with `channels.send()` only.
   * No lifecycle, events, streams, or compensation (prevents tight coupling).
   */
  readonly foreignWorkflows: {
    [K in keyof TForeignWorkflows]: ForeignWorkflowAccessor<
      TForeignWorkflows[K]
    >;
  };

  /** Workflow-local business error factories. */
  readonly errors: ErrorFactories<TErrors>;

  /** Predefined workflow branch accessors. */
  readonly branches: {
    [K in keyof TBranches]: BranchAccessor<
      TBranches[K],
      TScopePath,
      ExecutionRoot
    >;
  };

  // ---------------------------------------------------------------------------
  // execute — resolve a deterministic handle
  // ---------------------------------------------------------------------------

  /**
   * Resolve a branch handle created in an ancestor scope from within a branch
   * closure of a nested scope.
   *
   * Branch closures receive a path-specialized `WorkflowContext` whose
   * `TScopePath` extends the parent scope's path. `join` enforces at compile
   * time that the handle's scope path is a prefix of the current scope path —
   * guaranteeing the handle was created in a scope that is still live (i.e. an
   * ancestor of the current branch).
   *
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles such as steps,
   * child workflows, and `scope()`/`all()`/`first()` results.
   */
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  /**
   * Create a cron-like schedule handle for recurring execution.
   *
   * The first tick is computed from `ctx.timestamp` (workflow creation time),
   * unless `options.resumeAt` is provided. With `options.resumeAt`, the first
   * tick is the first schedule point strictly after the anchor instant (never
   * equal), then subsequent ticks advance from previous schedule points via
   * pure schedule math. No wall-clock access is required in workflow code.
   */
  schedule(expression: string, options?: ScheduleOptions): ScheduleHandle;

  // ---------------------------------------------------------------------------
  // scope — structured concurrency (closure-based)
  // ---------------------------------------------------------------------------

  /**
   * Create a scope for structured concurrency.
   *
   * Each entry is an async closure `(ctx: WorkflowContext<..., BranchPath>) => Promise<T>`.
   * The `ctx` argument is a path-specialized `WorkflowContext` with the branch's
   * exact scope path, enabling compile-time lifetime tracking.
   *
   * Scope exit behavior:
   * - Branches with compensated steps that weren't consumed → compensation runs
   * - Branches without compensation that weren't consumed → awaited, result ignored
   * - On error (callback throws): all unresolved compensated branches are compensated
   *
   * Resolve the scope result: `await ctx.scope("Name", entries, callback).resolve(ctx)`.
   *
   * Use `.failure(cb)` to handle scope failures after unwinding.
   */
  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        ExecutionRoot
      >,
    ) => Promise<R>,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  // ---------------------------------------------------------------------------
  // listen — channel-only multiplexed waiting (all contexts)
  // ---------------------------------------------------------------------------

  /**
   * Create a listener for concurrent channel waiting.
   *
   * Accepts only channel handles (`ChannelHandle` and `ChannelReceiveCall`).
   * Directly iterable: `for await (const { key, message } of listener) { ... }`.
   *
   * - `ChannelHandle` — streaming; never removed from `remaining`.
   * - `ChannelReceiveCall` — one-shot; removed from `remaining` after resolving.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;

  // ---------------------------------------------------------------------------
  // addCompensation — general purpose LIFO registration
  // ---------------------------------------------------------------------------

  /**
   * Register a general-purpose compensation callback on the LIFO stack.
   *
   * Compensations run in reverse registration order when the workflow fails.
   * The callback receives a CompensationContext (no step result — use for
   * non-step cleanup like sending channel messages, writing to streams, etc.).
   *
   * Not available on CompensationContext (no nesting).
   */
  addCompensation(
    callback: CompensationCallback<
      TState,
      TChannels,
      TStreams,
      TEvents,
      TSteps,
      TRequests,
      TChildWorkflows,
      TForeignWorkflows,
      TPatches,
      TRng
    >,
  ): void;
}

// =============================================================================
// WORKFLOW CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in workflow execution.
 *
 * Exposes full branch-aware concurrency primitives (`select`, `match`) and is
 * provided only as the first argument to `WorkflowContext.scope(...)`.
 * Use `handle.resolve(ctx)` for lazy handles (steps, child workflows, scope/all/first)
 * and `ctx.join()` for already-running `BranchHandle`s.
 */
export interface WorkflowConcurrencyContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
  TErrors extends ErrorDefinitions = Record<string, never>,
  TBranches extends BranchDefinitions = Record<string, never>,
>
  extends
    Omit<
      WorkflowContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        TScopePath,
        TErrors,
        TBranches
      >,
      "scope" | "listen" | "join"
    >,
    ExecutionResolver {
  /**
   * Resolve a branch handle created in this scope or an ancestor scope.
   *
   * For `BranchHandle`s, enforces at compile time that the handle's scope path
   * is a prefix of the current scope path — preventing handles from escaping
   * their intended lifetime.
   *
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles like steps and child workflows.
   */
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, ExecutionRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: WorkflowConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        ExecutionRoot
      >,
    ) => Promise<R>,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: WorkflowContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  /**
   * Create a listener for concurrent channel waiting.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;

  /**
   * Create a selection for concurrent waiting over scope branch handles and
   * channels.
   */
  select<M extends Record<string, ScopeSelectableHandle>>(
    handles: ScopeSelectableRecordForPath<M, TScopePath>,
  ): Selection<ScopeSelectableRecordForPath<M, TScopePath>>;

  /**
   * Iterate over a selection, yielding `{ key, result }` for each event.
   * Branch failures auto-terminate the workflow.
   */
  match<E>(
    handles: E,
    ..._check: ScopeEntryValidation<E>
  ): AsyncIterable<MatchEvents<E>>;
}

// =============================================================================
// COMPENSATION CONCURRENCY CONTEXT
// =============================================================================

/**
 * Scope-local context for structured concurrency in compensation execution.
 *
 * Exposes full branch-aware concurrency primitives (`select`, `match`) and is
 * provided only as the first argument to `CompensationContext.scope(...)`.
 * Use `handle.resolve(ctx)` for lazy handles (steps, child workflows, scope/all/first)
 * and `ctx.join()` for already-running `BranchHandle`s.
 */
export interface CompensationConcurrencyContext<
  TState,
  TChannels extends ChannelDefinitions,
  TStreams extends StreamDefinitions,
  TEvents extends EventDefinitions,
  TSteps extends StepDefinitions,
  TRequests extends RequestDefinitions = Record<string, never>,
  TChildWorkflows extends WorkflowDefinitions = Record<string, never>,
  TForeignWorkflows extends WorkflowDefinitions = Record<string, never>,
  TPatches extends PatchDefinitions = Record<string, never>,
  TRng extends RngDefinitions = Record<string, never>,
  TScopePath extends ScopePath = [],
>
  extends
    Omit<
      CompensationContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        TScopePath
      >,
      "scope" | "listen" | "join"
    >,
    CompensationResolver {
  /**
   * Resolve a branch handle created in this scope or an ancestor scope.
   *
   * For `BranchHandle`s, enforces at compile time that the handle's scope path
   * is a prefix of the current scope path.
   *
   * Use `handle.resolve(ctx)` for lazy (not-yet-running) handles.
   */
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H>>;
  join<H extends BranchEntry<any, any, CompensationRoot>>(
    handle: H,
    opts: JoinOptions,
    ..._check: IsJoinableByPath<H, TScopePath>
  ): Promise<JoinResult<H> | JoinTimeoutResult>;

  scope<Name extends string, E, R>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    callback: (
      ctx: CompensationConcurrencyContext<
        TState,
        TChannels,
        TStreams,
        TEvents,
        TSteps,
        TRequests,
        TChildWorkflows,
        TForeignWorkflows,
        TPatches,
        TRng,
        AppendScopeName<TScopePath, Name>
      >,
      handles: ScopeHandles<
        E,
        AppendScopeName<TScopePath, Name>,
        CompensationRoot
      >,
    ) => Promise<R>,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<R>;

  /**
   * Run all entries concurrently and return all resolved values.
   *
   * Each entry is `(ctx: CompensationContext<...>) => Promise<T>`.
   * Resolve: `await ctx.all("Name", entries).resolve(ctx)`.
   */
  all<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: ScopeSuccessResults<E> }
    | { ok: false; error: SomeBranchesFailed<E> }
  >;

  /**
   * Run all entries concurrently and return the first to complete.
   *
   * Resolve: `await ctx.first("Name", entries).resolve(ctx)`.
   * Returns `{ key, result }` discriminated union.
   *
   * If all branches fail, the scope fails unless `.failure(cb)` is provided.
   */
  first<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: FirstResult<E> }
    | { ok: false; error: NoBranchCompleted<E> }
  >;

  atLeast<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<
    | { ok: true; result: KeyedSuccess<E>[] }
    | { ok: false; error: QuorumNotMet<E> }
  >;

  atMost<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    count: number,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  some<Name extends string, E>(
    name: ScopeNameArg<TScopePath, Name>,
    entries: E,
    ..._check: ScopeEntryValidation<E>
  ): AwaitableEntry<KeyedSuccess<E>[]>;

  /**
   * Create a listener for concurrent channel waiting.
   */
  listen<M extends Record<string, ListenableHandle>>(handles: M): Listener<M>;

  /**
   * Create a selection for concurrent waiting over scope branch handles and
   * channels.
   */
  select<M extends Record<string, ScopeSelectableHandle>>(
    handles: ScopeSelectableRecordForPath<M, TScopePath>,
  ): CompensationSelection<ScopeSelectableRecordForPath<M, TScopePath>>;

  /**
   * Iterate over a compensation selection, yielding `{ key, result }` for each event.
   * Branch failures auto-terminate the compensation scope.
   */
  match<E>(
    handles: E,
    ..._check: ScopeEntryValidation<E>
  ): AsyncIterable<MatchEvents<E>>;
}

// =============================================================================
// TYPE HELPERS (workflow inference — used by context accessors above)
// =============================================================================

/**
 * Extract result type from a workflow definition or header (decoded — z.output).
 */
type InferWorkflowResult<W> = W extends {
  result?: infer TResultSchema;
}
  ? TResultSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferOutput<TResultSchema>
    : void
  : void;

/**
 * Extract channels from a workflow definition or header.
 */
type InferWorkflowChannels<W> = W extends {
  channels?: infer TChannels;
}
  ? TChannels extends ChannelDefinitions
    ? TChannels
    : Record<string, never>
  : Record<string, never>;

/**
 * Extract arg input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.args.
 */
type InferWorkflowArgsInput<W> = W extends { args?: infer TArgSchema }
  ? TArgSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TArgSchema>
    : void
  : void;

/**
 * Extract metadata input type from a workflow definition or header (encoded — z.input).
 * Used for StartWorkflowOptions.metadata.
 */
type InferWorkflowMetadataInput<W> = W extends {
  metadata?: infer TMetadataSchema;
}
  ? TMetadataSchema extends StandardSchemaV1<unknown, unknown>
    ? StandardSchemaV1.InferInput<TMetadataSchema>
    : void
  : void;

type InferWorkflowErrors<W> = W extends { errors?: infer TErrors }
  ? TErrors extends ErrorDefinitions
    ? TErrors
    : Record<string, never>
  : Record<string, never>;
