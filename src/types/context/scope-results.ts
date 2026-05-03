import type { AwaitableEntry, RequestEntry, StepEntry, WorkflowEntry } from "./entries";

// =============================================================================
// SCOPE TYPES — ENTRY, HANDLES
// =============================================================================

export type EntryResult<E> = E extends AwaitableEntry<infer T> ? T : never;

/**
 * A scope entry is an unstarted typed workflow entry.
 *
 * The new model orchestrates steps, requests, and child workflows under
 * scopes — there is no "branch entry" kind.
 */
export type ScopeEntry<T = unknown> =
  | StepEntry<T>
  | RequestEntry<T>
  | WorkflowEntry<T>;

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

export interface SomeEntriesFailed<E> {
  readonly code: "SomeEntriesFailed";
  readonly message: string;
  readonly details: {
    readonly failures: KeyedFailure<E>[];
    readonly completed: KeyedSuccess<E>[];
  };
}

export interface NoEntryCompleted<E> {
  readonly code: "NoEntryCompleted";
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

/**
 * Maps an entry structure to its corresponding handle structure inside a scope
 * body. Each entry is replaced by its `AwaitableEntry<T>` form; the structural
 * shape (objects, arrays, maps) is preserved.
 */
export type ScopeHandles<E> =
  E extends AwaitableEntry<infer T>
    ? AwaitableEntry<T>
    : E extends readonly unknown[]
      ? { readonly [K in keyof E]: ScopeHandles<E[K]> }
      : E extends ReadonlyMap<infer K, infer V>
        ? ReadonlyMap<K, ScopeHandles<V>>
        : E extends object
          ? { readonly [K in keyof E]: ScopeHandles<E[K]> }
          : never;

/**
 * Result type for `ctx.first()` — the first successful entry as a keyed value.
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
