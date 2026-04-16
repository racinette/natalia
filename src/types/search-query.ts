// =============================================================================
// SEARCH QUERY — SHARED TYPE SYSTEM
// =============================================================================

/**
 * Engine-managed terminal status values exposed in search predicates.
 */
export type WorkflowTerminalStatus = "complete" | "failure" | "terminated";

/**
 * Engine-managed searchable fields.
 *
 * These are semantic engine fields, not storage-engine specific columns.
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
// SEARCH QUERY — METADATA DOMAIN MODEL
// =============================================================================

export type SearchMetadataScalar = string | number | boolean | null;
export type SearchMetadataPrimitiveArray = readonly SearchMetadataScalar[];

export type SearchMetadataValue =
  | SearchMetadataScalar
  | SearchMetadataPrimitiveArray
  | undefined
  | SearchMetadataRecord;

export interface SearchMetadataRecord {
  readonly [key: string]: SearchMetadataValue;
}

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
 * Normalize schema input metadata into the constrained searchable metadata model:
 * nested objects + arrays of primitives.
 */
export type SearchMetadataFromInput<T> = T extends object
  ? {
      [K in Extract<keyof T, string>]: SearchMetadataValueFromInput<T[K]>;
    }
  : Record<string, never>;

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

type MetaScalarBranchAtPath<
  T extends SearchMetadataRecord,
  P extends MetaAnyPath<T>,
> = Extract<MetaPathValue<T, P>, SearchMetadataScalar | undefined>;

/**
 * Comparable branch at a path — only admits the path if the non-null/undefined
 * value resolves to purely `string` or purely `number`, not a union of both.
 * This ensures range comparisons (gt/gte/lt/lte) are only available when
 * ordering is unambiguous and client-side filterable.
 */
type MetaComparableBranchAtPath<
  T extends SearchMetadataRecord,
  P extends MetaAnyPath<T>,
> = Extract<MetaPathValue<T, P>, string | number> extends infer C
  ? [C] extends [never]
    ? never
    : [C] extends [string]
      ? string
      : [C] extends [number]
        ? number
        : never // string | number union → no range comparisons
  : never;

type MetaArrayElementBranchAtPath<
  T extends SearchMetadataRecord,
  P extends MetaAnyPath<T>,
> = MetaPathValue<T, P> extends infer V
  ? V extends readonly (infer E)[]
    ? E
    : never
  : never;

type MetaScalarPath<T extends SearchMetadataRecord> = {
  [P in MetaAnyPath<T>]: [MetaScalarBranchAtPath<T, P>] extends [never]
    ? never
    : P;
}[MetaAnyPath<T>];

type MetaComparablePath<T extends SearchMetadataRecord> = {
  [P in MetaAnyPath<T>]: [MetaComparableBranchAtPath<T, P>] extends [never]
    ? never
    : P;
}[MetaAnyPath<T>];

type MetaArrayPath<T extends SearchMetadataRecord> = {
  [P in MetaAnyPath<T>]: [MetaArrayElementBranchAtPath<T, P>] extends [never]
    ? never
    : P;
}[MetaAnyPath<T>];

/**
 * Sortable paths — only paths where the comparable value is purely `string` or
 * purely `number`. Sorting requires unambiguous ordering, same as range comparisons.
 */
type MetaSortablePath<T extends SearchMetadataRecord> = MetaComparablePath<T>;

type MetaObjectValueAtKey<
  TValue,
  K extends MetadataObjectKeys<TValue>,
> = MetadataDescend<TValue, K>;

type MetaScalarCapabilityValue<TValue> = Extract<
  TValue,
  SearchMetadataScalar | undefined
>;

/**
 * Comparable capability value — only resolves to `string` or `number` when the
 * extractable comparable branch is purely one type. Rejects `string | number`
 * unions to prevent ambiguous range comparisons.
 */
type MetaComparableCapabilityValue<TValue> = Extract<TValue, string | number> extends infer C
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

type EngineComparablePath = {
  [K in keyof WorkflowSearchEngineFields]: WorkflowSearchEngineFields[K] extends
    | Date
    | number
    | bigint
    ? K
    : never;
}[keyof WorkflowSearchEngineFields];

// =============================================================================
// SEARCH QUERY — DISCRIMINATED UNION AST
// =============================================================================

export type WorkflowSearchNamespace = "engine" | "meta";

export type WorkflowSearchQueryNode<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> =
  | {
      kind: "and";
      nodes: readonly WorkflowSearchQueryNode<TMetadata>[];
    }
  | {
      kind: "or";
      nodes: readonly WorkflowSearchQueryNode<TMetadata>[];
    }
  | {
      kind: "not";
      node: WorkflowSearchQueryNode<TMetadata>;
    }
  | WorkflowSearchEnginePredicateNode
  | WorkflowSearchMetaPredicateNode<TMetadata>;

export type WorkflowSearchEnginePredicateNode =
  | {
      kind: "exists";
      namespace: "engine";
      path: keyof WorkflowSearchEngineFields;
      value: boolean;
    }
  | {
      [P in keyof WorkflowSearchEngineFields]: {
        kind: "eq" | "ne";
        namespace: "engine";
        path: P;
        value: WorkflowSearchEngineFields[P];
      };
    }[keyof WorkflowSearchEngineFields]
  | {
      [P in keyof WorkflowSearchEngineFields]: {
        kind: "in" | "notIn";
        namespace: "engine";
        path: P;
        value: readonly WorkflowSearchEngineFields[P][];
      };
    }[keyof WorkflowSearchEngineFields]
  | {
      [P in EngineComparablePath]: {
        kind: "gt" | "gte" | "lt" | "lte";
        namespace: "engine";
        path: P;
        value: WorkflowSearchEngineFields[P];
      };
    }[EngineComparablePath];

export type WorkflowSearchMetaPredicateNode<
  TMetadata extends SearchMetadataRecord,
> =
  | {
      kind: "exists";
      namespace: "meta";
      path: MetaAnyPath<TMetadata>;
      value: boolean;
    }
  | {
      [P in MetaScalarPath<TMetadata>]: {
        kind: "eq" | "ne";
        namespace: "meta";
        path: P;
        value: Extract<MetaPathValue<TMetadata, P>, SearchMetadataScalar | undefined>;
      };
    }[MetaScalarPath<TMetadata>]
  | {
      [P in MetaScalarPath<TMetadata>]: {
        kind: "in" | "notIn";
        namespace: "meta";
        path: P;
        value: readonly Extract<
          MetaPathValue<TMetadata, P>,
          SearchMetadataScalar | undefined
        >[];
      };
    }[MetaScalarPath<TMetadata>]
  | {
      [P in MetaComparablePath<TMetadata>]: {
        kind: "gt" | "gte" | "lt" | "lte";
        namespace: "meta";
        path: P;
        value: Extract<MetaPathValue<TMetadata, P>, string | number>;
      };
    }[MetaComparablePath<TMetadata>]
  | {
      [P in MetaArrayPath<TMetadata>]: {
        kind: "contains";
        namespace: "meta";
        path: P;
        value: MetaArrayElementBranchAtPath<TMetadata, P>;
      };
    }[MetaArrayPath<TMetadata>]
  | {
      [P in MetaArrayPath<TMetadata>]: {
        kind: "containsAny" | "containsAll";
        namespace: "meta";
        path: P;
        value: readonly MetaArrayElementBranchAtPath<TMetadata, P>[];
      };
    }[MetaArrayPath<TMetadata>];

// =============================================================================
// SEARCH QUERY — SORT / ENVELOPE / RESULT
// =============================================================================

export type WorkflowSearchSortDirection = "asc" | "desc";

export type WorkflowSearchSort<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> =
  | {
      namespace: "engine";
      path: keyof WorkflowSearchEngineFields;
      direction: WorkflowSearchSortDirection;
    }
  | {
      namespace: "meta";
      path: MetaSortablePath<TMetadata>;
      direction: WorkflowSearchSortDirection;
    };

export interface WorkflowSearchQuery<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> {
  where?: WorkflowSearchQueryNode<TMetadata>;
  sort?: readonly WorkflowSearchSort<TMetadata>[];
  limit?: number;
}

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
 *
 * Prevents passing a cursor from workflow A into a search call for workflow B.
 */
declare const workflowSearchCursorBrand: unique symbol;
export type WorkflowSearchCursor<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> = string & { readonly [workflowSearchCursorBrand]: TMetadata };

// =============================================================================
// SEARCH QUERY — BUILDER TYPES
// =============================================================================

type EqInBuilder<TRoot extends SearchMetadataRecord, TValue> = {
  eq(value: TValue): WorkflowSearchQueryNode<TRoot>;
  ne(value: TValue): WorkflowSearchQueryNode<TRoot>;
  in(values: readonly TValue[]): WorkflowSearchQueryNode<TRoot>;
  notIn(values: readonly TValue[]): WorkflowSearchQueryNode<TRoot>;
};

type RangeBuilder<TRoot extends SearchMetadataRecord, TValue> =
  [TValue] extends [string | number]
    ? {
        gt(value: TValue): WorkflowSearchQueryNode<TRoot>;
        gte(value: TValue): WorkflowSearchQueryNode<TRoot>;
        lt(value: TValue): WorkflowSearchQueryNode<TRoot>;
        lte(value: TValue): WorkflowSearchQueryNode<TRoot>;
      }
    : {};

type ExistsBuilder<TRoot extends SearchMetadataRecord> = {
  exists(value: boolean): WorkflowSearchQueryNode<TRoot>;
};

type ScalarCapabilityBuilder<
  TRoot extends SearchMetadataRecord,
  TValue,
> = [MetaScalarCapabilityValue<TValue>] extends [never]
  ? {}
  : EqInBuilder<TRoot, MetaScalarCapabilityValue<TValue>> &
      RangeBuilder<TRoot, MetaComparableCapabilityValue<TValue>>;

type ArrayCapabilityBuilder<
  TRoot extends SearchMetadataRecord,
  TValue,
> = [MetaArrayCapabilityElement<TValue>] extends [never]
  ? {}
  : {
      contains(
        value: MetaArrayCapabilityElement<TValue>,
      ): WorkflowSearchQueryNode<TRoot>;
      containsAny(
        values: readonly MetaArrayCapabilityElement<TValue>[],
      ): WorkflowSearchQueryNode<TRoot>;
      containsAll(
        values: readonly MetaArrayCapabilityElement<TValue>[],
      ): WorkflowSearchQueryNode<TRoot>;
    };

type ObjectCapabilityBuilder<
  TRoot extends SearchMetadataRecord,
  TValue,
> = [MetadataObjectKeys<TValue>] extends [never]
  ? {}
  : {
      [K in MetadataObjectKeys<TValue>]-?: MetaBuilderNode<
        TRoot,
        MetaObjectValueAtKey<TValue, K>
      >;
    };

type MetaBuilderNode<
  TRoot extends SearchMetadataRecord,
  TValue,
> = ExistsBuilder<TRoot> &
  ObjectCapabilityBuilder<TRoot, TValue> &
  ArrayCapabilityBuilder<TRoot, TValue> &
  ScalarCapabilityBuilder<TRoot, TValue>;

type EngineBuilderNode<
  TRoot extends SearchMetadataRecord,
  TValue,
> = EqInBuilder<TRoot, TValue> &
  (TValue extends Date | number | bigint
    ? {
        gt(value: TValue): WorkflowSearchQueryNode<TRoot>;
        gte(value: TValue): WorkflowSearchQueryNode<TRoot>;
        lt(value: TValue): WorkflowSearchQueryNode<TRoot>;
        lte(value: TValue): WorkflowSearchQueryNode<TRoot>;
      }
    : {}) &
  ExistsBuilder<TRoot>;

export type WorkflowSearchQueryBuilder<
  TMetadata extends SearchMetadataRecord = Record<string, never>,
> = {
  readonly engine: {
    [K in keyof WorkflowSearchEngineFields]-?: EngineBuilderNode<
      TMetadata,
      WorkflowSearchEngineFields[K]
    >;
  };
  readonly meta: MetaBuilderNode<TMetadata, TMetadata>;
  and(
    ...nodes: readonly WorkflowSearchQueryNode<TMetadata>[]
  ): WorkflowSearchQueryNode<TMetadata>;
  or(
    ...nodes: readonly WorkflowSearchQueryNode<TMetadata>[]
  ): WorkflowSearchQueryNode<TMetadata>;
  not(node: WorkflowSearchQueryNode<TMetadata>): WorkflowSearchQueryNode<TMetadata>;
};
