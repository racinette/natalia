// =============================================================================
// SEARCH QUERY — SHARED TYPE SYSTEM
//
// `REFACTOR.MD` Part 9 generalises the legacy two-namespace
// `WorkflowSearchQuery<TMeta>` into a reusable
// `SearchQuery<TNamespaces>` over an arbitrary record of namespaces.
//
// Two namespace shapes participate:
//
//   - `RowNamespaceRecord` — flat record of scalar columns drawn from
//     `string | number | boolean | bigint | Date | null | undefined`. No
//     nesting. Used by the `row` namespace on every queryable entity (the
//     flat columns of an SQL row).
//   - `SearchMetadataRecord` — nested record whose leaves are
//     `string | number | boolean | null | undefined`, plus arrays of those,
//     plus nested records. No `bigint`/`Date` (those don't survive JSONB
//     serialisation without a convention). Used for JSONB columns: `args`,
//     `result`, `metadata`, `info`, `payload`, `error`.
//
// Both shapes go through the same path-derivation machinery; range
// comparisons and sorting are restricted to homogeneous comparable paths.
// Row namespaces additionally admit `bigint` and `Date` paths because they
// carry total ordering.
// =============================================================================

// =============================================================================
// LEGACY ENGINE FIELDS (kept until step 12 sweeps the workflow query surface)
// =============================================================================

/**
 * Engine-managed terminal status values exposed in search predicates.
 */
export type WorkflowTerminalStatus = "complete" | "failure" | "terminated";

/**
 * Engine-managed searchable fields.
 *
 * These are semantic engine fields, not storage-engine specific columns.
 * Step 12 supersedes this with the unified `WorkflowRow` published by step 10.
 */
export interface WorkflowSearchEngineFields {
  createdAt: Date;
  updatedAt: Date | null;
  executionStartedAt: Date | null;
  executionFinishedAt: Date | null;
  compensationStartedAt: Date | null;
  compensationFinishedAt: Date | null;
  deadlineAt: Date | null;
  executorId: bigint | null;
  executionTerminalStatus: WorkflowTerminalStatus | null;
  compensationTerminalStatus: WorkflowTerminalStatus | null;
  isChild: boolean;
  isDetached: boolean | null;
}

// =============================================================================
// NAMESPACE-SHAPE PRIMITIVES
// =============================================================================

/**
 * Scalar values admitted in a row namespace (a flat record of SQL row
 * columns). Includes `bigint` and `Date` because row columns carry total
 * ordering and survive across storage backends.
 */
export type RowNamespaceScalar =
  | string
  | number
  | boolean
  | bigint
  | Date
  | null
  | undefined;

/**
 * Marker for a row namespace — a flat record whose values are
 * `RowNamespaceScalar`. The constraint is **structural**: any object type
 * whose every property value type is assignable to `RowNamespaceScalar`
 * satisfies it. We do not require an `[key: string]` index signature so that
 * explicit column-typed shapes (e.g. `WorkflowRow`) can be used as
 * namespaces without redeclaration.
 */
export type RowNamespaceRecord = {
  readonly [key: string]: RowNamespaceScalar;
};

/**
 * Test whether `T` structurally fits the row-namespace shape: every
 * property is a `RowNamespaceScalar`, AND at least one column carries
 * `bigint` or `Date` (the row-only types — `RowNamespaceRecord` admits
 * them, `SearchMetadataRecord` does not). The `bigint`/`Date` discriminator
 * is necessary because a flat record of `string | number | boolean | null`
 * values structurally satisfies both shapes; without the discriminator the
 * dispatch would be ambiguous.
 *
 * Practical implication: a row namespace declaration is expected to include
 * timestamp / count / id columns of type `Date` / `bigint`. The published
 * `WorkflowRow` and `RequestCompensationRow` (step 10) both do.
 *
 * Used internally; user code does not call this.
 */
type IsRowNamespace<T> = T extends object
  ? T extends readonly unknown[]
    ? false
    : keyof T extends string
      ? {
          [K in keyof T]: T[K] extends RowNamespaceScalar ? true : false;
        }[keyof T] extends true
        ? // All values are row-scalar shaped. Now discriminate vs metadata
          // by requiring at least one bigint or Date column.
          true extends {
            [K in keyof T]: T[K] extends bigint | Date | null | undefined
              ? T[K] extends null | undefined
                ? false
                : true
              : false;
          }[keyof T]
          ? true
          : false
        : false
      : false
  : false;

/**
 * Scalar leaves admitted in a JSONB metadata namespace.
 */
export type SearchMetadataScalar = string | number | boolean | null;

/** Array form admitted as a JSONB leaf. */
export type SearchMetadataPrimitiveArray = readonly SearchMetadataScalar[];

/** Nested value admitted inside a JSONB metadata namespace. */
export type SearchMetadataValue =
  | SearchMetadataScalar
  | SearchMetadataPrimitiveArray
  | undefined
  | SearchMetadataRecord;

/** Nested record of JSONB-friendly values. */
export interface SearchMetadataRecord {
  readonly [key: string]: SearchMetadataValue;
}

/**
 * Umbrella namespace constraint — every key in `TNamespaces` of a
 * `SearchQuery<TNamespaces>` must be either a row namespace (flat
 * `RowNamespaceScalar` values) or a metadata namespace (nested JSONB
 * record). Rather than enforcing assignability to either of the two record
 * types directly (which would require user-supplied namespaces to carry an
 * `[key: string]` index signature), we accept any non-array object and let
 * the dispatch in `NamespacePredicateNode` / `NamespaceBuilder` test the
 * shape.
 */
export type SearchNamespaceRecord = object;

type SearchMetadataValueFromInput<T> = T extends unknown
  ? T extends readonly (infer E)[]
    ? E extends SearchMetadataScalar
      ? readonly E[]
      : never
    : T extends SearchMetadataScalar | undefined
      ? T
      : T extends object
        ? SearchMetadataFromInput<T>
        : never
  : never;

/**
 * Normalise schema-input metadata into the constrained searchable metadata
 * model: nested objects + arrays of primitives.
 */
export type SearchMetadataFromInput<T> = T extends object
  ? {
      [K in Extract<keyof T, string>]: SearchMetadataValueFromInput<T[K]>;
    }
  : Record<string, never>;

// =============================================================================
// PATH MACHINERY — shared between row and metadata namespaces.
//
// Row namespaces are flat records, so their "paths" are just keys (no `.`
// joins). Metadata namespaces support nested paths via `JoinPath`.
// =============================================================================

type JoinPath<L extends string, R extends string> = `${L}.${R}`;

type MetadataObjectKeys<T> = T extends unknown
  ? T extends readonly unknown[]
    ? never
    : T extends object
      ? Extract<keyof T, string>
      : never
  : never;

type MetadataDescend<T, K extends string> = T extends unknown
  ? T extends readonly unknown[]
    ? undefined
    : T extends object
      ? K extends keyof T
        ? T[K]
        : undefined
      : undefined
  : never;

type MetaAnyPath<T> = {
  [K in MetadataObjectKeys<T>]:
    | K
    | (MetaAnyPath<MetadataDescend<T, K>> extends infer R
        ? R extends string
          ? JoinPath<K, R>
          : never
        : never);
}[MetadataObjectKeys<T>];

type MetaPathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? MetaPathValue<MetadataDescend<T, K>, Rest>
  : MetadataDescend<T, P>;

// -----------------------------------------------------------------------------
// METADATA NAMESPACE — scalar / comparable / array path predicates.
// -----------------------------------------------------------------------------

// Path machinery without `T extends SearchMetadataRecord` constraint —
// works on any object shape. Used by the predicate / builder dispatch when
// we've already ruled out a row-namespace shape.

type MetaScalarBranchAtPathOf<T, P extends string> = Extract<
  MetaPathValue<T, P>,
  SearchMetadataScalar | undefined
>;

/**
 * Comparable branch at a path — only admits the path if the non-null/undefined
 * value resolves to purely `string` or purely `number`. Range comparisons
 * (`gt`/`gte`/`lt`/`lte`) require unambiguous ordering.
 */
type MetaComparableBranchAtPathOf<T, P extends string> = Extract<
  MetaPathValue<T, P>,
  string | number
> extends infer C
  ? [C] extends [never]
    ? never
    : [C] extends [string]
      ? string
      : [C] extends [number]
        ? number
        : never
  : never;

type MetaArrayElementBranchAtPathOf<T, P extends string> = MetaPathValue<
  T,
  P
> extends infer V
  ? V extends readonly (infer E)[]
    ? E
    : never
  : never;

type MetaScalarPathOf<T> = MetaAnyPath<T> extends infer P
  ? P extends string
    ? [MetaScalarBranchAtPathOf<T, P>] extends [never]
      ? never
      : P
    : never
  : never;

type MetaComparablePathOf<T> = MetaAnyPath<T> extends infer P
  ? P extends string
    ? [MetaComparableBranchAtPathOf<T, P>] extends [never]
      ? never
      : P
    : never
  : never;

type MetaArrayPathOf<T> = MetaAnyPath<T> extends infer P
  ? P extends string
    ? [MetaArrayElementBranchAtPathOf<T, P>] extends [never]
      ? never
      : P
    : never
  : never;

// Backward-compat aliases for code that still wants the constrained form.
type MetaScalarBranchAtPath<
  T extends SearchMetadataRecord,
  P extends MetaAnyPath<T>,
> = MetaScalarBranchAtPathOf<T, P & string>;
type MetaComparableBranchAtPath<
  T extends SearchMetadataRecord,
  P extends MetaAnyPath<T>,
> = MetaComparableBranchAtPathOf<T, P & string>;
type MetaArrayElementBranchAtPath<
  T extends SearchMetadataRecord,
  P extends MetaAnyPath<T>,
> = MetaArrayElementBranchAtPathOf<T, P & string>;
type MetaScalarPath<T extends SearchMetadataRecord> = MetaScalarPathOf<T>;
type MetaComparablePath<T extends SearchMetadataRecord> = MetaComparablePathOf<T>;
type MetaArrayPath<T extends SearchMetadataRecord> = MetaArrayPathOf<T>;

// -----------------------------------------------------------------------------
// ROW NAMESPACE — flat keys, comparable paths admit Date / bigint.
// -----------------------------------------------------------------------------

type RowKey<T> = Extract<keyof T, string>;

/**
 * Comparable row column — admits `string | number | bigint | Date`, but only
 * when the column resolves to a single one of those (not a heterogeneous
 * union).
 */
type RowComparableValueAt<T, K extends RowKey<T>> = Extract<
  T[K],
  string | number | bigint | Date
> extends infer C
  ? [C] extends [never]
    ? never
    : [C] extends [string]
      ? string
      : [C] extends [number]
        ? number
        : [C] extends [bigint]
          ? bigint
          : [C] extends [Date]
            ? Date
            : never
  : never;

type RowComparableKey<T> = {
  [K in RowKey<T>]: [RowComparableValueAt<T, K>] extends [never] ? never : K;
}[RowKey<T>];

// =============================================================================
// PER-NAMESPACE NODE EMISSION
//
// For each namespace key in TNamespaces, emit the predicate AST nodes that
// apply to that namespace's shape. Row namespaces produce flat-key nodes
// with bigint/Date support; metadata namespaces produce nested-path nodes
// with array-containment support.
// =============================================================================

type RowNamespacePredicateNode<TNamespaceKey extends string, T> =
  | {
      kind: "exists";
      namespace: TNamespaceKey;
      path: RowKey<T>;
      value: boolean;
    }
  | {
      [K in RowKey<T>]: {
        kind: "eq" | "ne";
        namespace: TNamespaceKey;
        path: K;
        value: T[K];
      };
    }[RowKey<T>]
  | {
      [K in RowKey<T>]: {
        kind: "in" | "notIn";
        namespace: TNamespaceKey;
        path: K;
        value: readonly T[K][];
      };
    }[RowKey<T>]
  | {
      [K in RowComparableKey<T>]: {
        kind: "gt" | "gte" | "lt" | "lte";
        namespace: TNamespaceKey;
        path: K;
        value: RowComparableValueAt<T, K>;
      };
    }[RowComparableKey<T>];

type MetadataNamespacePredicateNode<TNamespaceKey extends string, T> =
  | {
      kind: "exists";
      namespace: TNamespaceKey;
      path: MetaAnyPath<T>;
      value: boolean;
    }
  | {
      [P in MetaScalarPathOf<T>]: {
        kind: "eq" | "ne";
        namespace: TNamespaceKey;
        path: P;
        value: Extract<MetaPathValue<T, P>, SearchMetadataScalar | undefined>;
      };
    }[MetaScalarPathOf<T>]
  | {
      [P in MetaScalarPathOf<T>]: {
        kind: "in" | "notIn";
        namespace: TNamespaceKey;
        path: P;
        value: readonly Extract<
          MetaPathValue<T, P>,
          SearchMetadataScalar | undefined
        >[];
      };
    }[MetaScalarPathOf<T>]
  | {
      [P in MetaComparablePathOf<T>]: {
        kind: "gt" | "gte" | "lt" | "lte";
        namespace: TNamespaceKey;
        path: P;
        value: Extract<MetaPathValue<T, P>, string | number>;
      };
    }[MetaComparablePathOf<T>]
  | {
      [P in MetaArrayPathOf<T>]: {
        kind: "contains";
        namespace: TNamespaceKey;
        path: P;
        value: MetaArrayElementBranchAtPathOf<T, P>;
      };
    }[MetaArrayPathOf<T>]
  | {
      [P in MetaArrayPathOf<T>]: {
        kind: "containsAny" | "containsAll";
        namespace: TNamespaceKey;
        path: P;
        value: readonly MetaArrayElementBranchAtPathOf<T, P>[];
      };
    }[MetaArrayPathOf<T>];

/**
 * Emit predicate nodes for one namespace, dispatching on whether it's a row
 * namespace (flat record of `RowNamespaceScalar`) or a metadata namespace
 * (nested record of JSONB-friendly values).
 */
type NamespacePredicateNode<
  TNamespaceKey extends string,
  T,
> = IsRowNamespace<T> extends true
  ? RowNamespacePredicateNode<TNamespaceKey, T>
  : MetadataNamespacePredicateNode<TNamespaceKey, T>;

// =============================================================================
// SEARCH QUERY NODE — generic AST over multiple namespaces.
// =============================================================================

export type SearchQueryNode<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> =
  | { kind: "and"; nodes: readonly SearchQueryNode<TNamespaces>[] }
  | { kind: "or"; nodes: readonly SearchQueryNode<TNamespaces>[] }
  | { kind: "not"; node: SearchQueryNode<TNamespaces> }
  | {
      [K in Extract<keyof TNamespaces, string>]: NamespacePredicateNode<
        K,
        TNamespaces[K]
      >;
    }[Extract<keyof TNamespaces, string>];

// =============================================================================
// SORT — SearchSort<TNamespaces>
//
// Only paths whose value resolves to purely `string`, `number`, `bigint`, or
// `Date` are sortable. Row namespaces additionally admit `bigint`/`Date`;
// metadata namespaces are limited to `string`/`number`.
// =============================================================================

export type SearchSortDirection = "asc" | "desc";

type RowSortableKey<T> = RowComparableKey<T>;

type NamespaceSortTerm<TNamespaceKey extends string, T> =
  IsRowNamespace<T> extends true
    ? {
        namespace: TNamespaceKey;
        path: RowSortableKey<T>;
        direction: SearchSortDirection;
      }
    : {
        namespace: TNamespaceKey;
        path: MetaComparablePathOf<T>;
        direction: SearchSortDirection;
      };

export type SearchSort<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> = {
  [K in Extract<keyof TNamespaces, string>]: NamespaceSortTerm<K, TNamespaces[K]>;
}[Extract<keyof TNamespaces, string>];

// =============================================================================
// QUERY ENVELOPE
// =============================================================================

export interface SearchQuery<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> {
  where?: SearchQueryNode<TNamespaces>;
  sort?: readonly SearchSort<TNamespaces>[];
  limit?: number;
}

// =============================================================================
// BUILDER TYPES — generic over TNamespaces.
//
// The builder exposes one sub-builder per namespace key. Sub-builders dispatch
// on namespace shape: row namespaces produce flat-key accessors with eq/ne/in/
// notIn/exists plus range on comparable columns; metadata namespaces produce
// nested-path accessors with the same scalar capabilities plus array
// contains/containsAny/containsAll on array paths.
// =============================================================================

type EqInBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TValue,
> = {
  eq(value: TValue): SearchQueryNode<TNamespaces>;
  ne(value: TValue): SearchQueryNode<TNamespaces>;
  in(values: readonly TValue[]): SearchQueryNode<TNamespaces>;
  notIn(values: readonly TValue[]): SearchQueryNode<TNamespaces>;
};

type RangeBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TValue,
> = [TValue] extends [string | number | bigint | Date]
  ? {
      gt(value: TValue): SearchQueryNode<TNamespaces>;
      gte(value: TValue): SearchQueryNode<TNamespaces>;
      lt(value: TValue): SearchQueryNode<TNamespaces>;
      lte(value: TValue): SearchQueryNode<TNamespaces>;
    }
  : {};

type ExistsBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> = {
  exists(value: boolean): SearchQueryNode<TNamespaces>;
};

// -----------------------------------------------------------------------------
// METADATA SUB-BUILDER — recurses through nested object structure.
// -----------------------------------------------------------------------------

type MetaScalarCapabilityValue<TValue> = Extract<
  TValue,
  SearchMetadataScalar | undefined
>;

type MetaComparableCapabilityValue<TValue> = Extract<
  TValue,
  string | number
> extends infer C
  ? [C] extends [never]
    ? never
    : [C] extends [string]
      ? string
      : [C] extends [number]
        ? number
        : never
  : never;

type MetaArrayCapabilityElement<TValue> = TValue extends unknown
  ? TValue extends readonly (infer E)[]
    ? E extends SearchMetadataScalar
      ? E
      : never
    : never
  : never;

type ScalarCapabilityBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TValue,
> = [MetaScalarCapabilityValue<TValue>] extends [never]
  ? {}
  : EqInBuilder<TNamespaces, MetaScalarCapabilityValue<TValue>> &
      RangeBuilder<TNamespaces, MetaComparableCapabilityValue<TValue>>;

type ArrayCapabilityBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TValue,
> = [MetaArrayCapabilityElement<TValue>] extends [never]
  ? {}
  : {
      contains(
        value: MetaArrayCapabilityElement<TValue>,
      ): SearchQueryNode<TNamespaces>;
      containsAny(
        values: readonly MetaArrayCapabilityElement<TValue>[],
      ): SearchQueryNode<TNamespaces>;
      containsAll(
        values: readonly MetaArrayCapabilityElement<TValue>[],
      ): SearchQueryNode<TNamespaces>;
    };

type ObjectCapabilityBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TValue,
> = [MetadataObjectKeys<TValue>] extends [never]
  ? {}
  : {
      [K in MetadataObjectKeys<TValue>]-?: MetadataBuilderNode<
        TNamespaces,
        MetadataDescend<TValue, K>
      >;
    };

type MetadataBuilderNode<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TValue,
> = ExistsBuilder<TNamespaces> &
  ObjectCapabilityBuilder<TNamespaces, TValue> &
  ArrayCapabilityBuilder<TNamespaces, TValue> &
  ScalarCapabilityBuilder<TNamespaces, TValue>;

// Make the `_` reference reachable so unused-aliases don't confuse TS.
type _UnusedBackcompatAliases =
  | MetaScalarBranchAtPath<SearchMetadataRecord, never>
  | MetaComparableBranchAtPath<SearchMetadataRecord, never>
  | MetaArrayElementBranchAtPath<SearchMetadataRecord, never>
  | MetaScalarPath<SearchMetadataRecord>
  | MetaComparablePath<SearchMetadataRecord>
  | MetaArrayPath<SearchMetadataRecord>;

// -----------------------------------------------------------------------------
// ROW SUB-BUILDER — flat-key accessors over a row namespace.
// -----------------------------------------------------------------------------

type RowBuilderColumn<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  TValue,
> = EqInBuilder<TNamespaces, TValue> &
  RangeBuilder<
    TNamespaces,
    Extract<TValue, string | number | bigint | Date>
  > &
  ExistsBuilder<TNamespaces>;

type RowBuilderNamespace<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  T,
> = {
  [K in RowKey<T>]-?: RowBuilderColumn<TNamespaces, T[K]>;
};

// -----------------------------------------------------------------------------
// NAMESPACE SUB-BUILDER — dispatch on shape.
// -----------------------------------------------------------------------------

type NamespaceBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
  T,
> = IsRowNamespace<T> extends true
  ? RowBuilderNamespace<TNamespaces, T>
  : MetadataBuilderNode<TNamespaces, T>;

export type SearchQueryBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> = {
  readonly [K in Extract<keyof TNamespaces, string>]: NamespaceBuilder<
    TNamespaces,
    TNamespaces[K]
  >;
} & {
  and(
    ...nodes: readonly SearchQueryNode<TNamespaces>[]
  ): SearchQueryNode<TNamespaces>;
  or(
    ...nodes: readonly SearchQueryNode<TNamespaces>[]
  ): SearchQueryNode<TNamespaces>;
  not(node: SearchQueryNode<TNamespaces>): SearchQueryNode<TNamespaces>;
};

// =============================================================================
// LEGACY WORKFLOW SEARCH ALIASES
//
// Kept until step 12 sweeps the workflow query surface. The workflow-specific
// types are thin aliases over `SearchQuery<{ engine; meta }>`. Step 12 will
// replace these with the unified workflow query namespaces from REFACTOR.MD
// Part 5 (`row` / `args` / `result` / `metadata` / `error`).
// =============================================================================

type WorkflowSearchNamespaces<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> = {
  engine: WorkflowSearchEngineFields;
  meta: TMetadata;
};

export type WorkflowSearchNamespace = "engine" | "meta";

export type WorkflowSearchQueryNode<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> = SearchQueryNode<WorkflowSearchNamespaces<TMetadata>>;

export type WorkflowSearchSortDirection = SearchSortDirection;

export type WorkflowSearchSort<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> = SearchSort<WorkflowSearchNamespaces<TMetadata>>;

export interface WorkflowSearchQuery<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> extends SearchQuery<WorkflowSearchNamespaces<TMetadata>> {}

export type WorkflowSearchQueryBuilder<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> = SearchQueryBuilder<WorkflowSearchNamespaces<TMetadata>>;

// =============================================================================
// LEGACY PAGINATION (kept until step 12 replaces with FindManyResult)
// =============================================================================

/**
 * Minimal placeholder search item for API-shaping phase.
 */
export interface WorkflowSearchItem<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> {
  readonly idempotencyKey: string;
  readonly metadata: TMetadata;
}

/**
 * Minimal placeholder search page for API-shaping phase.
 */
export interface WorkflowSearchResultPage<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> {
  readonly items: readonly WorkflowSearchItem<TMetadata>[];
  readonly nextCursor?: WorkflowSearchCursor<TMetadata>;
}

/**
 * Opaque pagination cursor branded by workflow search metadata type.
 */
declare const workflowSearchCursorBrand: unique symbol;
export type WorkflowSearchCursor<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> = string & { readonly [workflowSearchCursorBrand]: TMetadata };
