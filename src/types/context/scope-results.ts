import type { StandardSchemaV1 } from "../standard-schema";
import type { BranchDefinition } from "../definitions/branches";
import type { BranchErrorMode } from "../definitions/errors";
import type { AwaitableEntry, RequestEntry, SchemaInvocationInput, StepBoundary, StepEntry, WorkflowEntry } from "./entries";
import type { RootScope, rootScopeBrand } from "./deterministic-handles";
import type { ScopePath } from "./scope-path";

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

export type ScopeEntryValidation<E> = E extends (...args: any[]) => any
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

export type BranchJoinResult<T> =
  | { ok: true; result: T }
  | { ok: false; status: "failed"; error: unknown };

export type DefinedBranchResult<T, TErrors extends BranchErrorMode> =
  BranchJoinResult<T>;

export interface BranchCallOptions {}

export interface BranchTimeoutCallOptions extends BranchCallOptions {
  readonly timeout: StepBoundary;
}

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

  (
    args: InferBranchArgsInput<B>,
    opts: BranchTimeoutCallOptions,
  ): BranchEntry<
    | DefinedBranchResult<InferBranchResult<B>, InferBranchErrors<B>>
    | { ok: false; status: "timeout" },
    TScopePath,
    TRoot
  >;

  (
    args: InferBranchArgsInput<B>,
    opts: BranchCallOptions,
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
