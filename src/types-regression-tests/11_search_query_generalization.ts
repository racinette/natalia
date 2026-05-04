import type {
  RowNamespaceRecord,
  RowNamespaceScalar,
  SearchMetadataRecord,
  SearchNamespaceRecord,
  SearchQuery,
  SearchQueryBuilder,
  SearchQueryNode,
  SearchSort,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// NAMESPACE-SHAPE PRIMITIVES
// =============================================================================

// Row scalars include `string | number | boolean | bigint | Date | null |
// undefined` — total ordering survives across storage backends.
const _rowScalarString: RowNamespaceScalar = "x";
const _rowScalarNumber: RowNamespaceScalar = 1;
const _rowScalarBoolean: RowNamespaceScalar = true;
const _rowScalarBigInt: RowNamespaceScalar = 1n;
const _rowScalarDate: RowNamespaceScalar = new Date();
const _rowScalarNull: RowNamespaceScalar = null;
const _rowScalarUndefined: RowNamespaceScalar = undefined;

void _rowScalarString;
void _rowScalarNumber;
void _rowScalarBoolean;
void _rowScalarBigInt;
void _rowScalarDate;
void _rowScalarNull;
void _rowScalarUndefined;

// Row namespaces are flat — index signature shape works for record
// declarations, but the constraint is structural: any object whose property
// values fit `RowNamespaceScalar` qualifies.
const _rowRecord: RowNamespaceRecord = {
  status: "completed",
  attempts: 3,
  createdAt: new Date(),
  cursor: 12345n,
  active: true,
};
void _rowRecord;

// SearchMetadataRecord is the JSONB nested shape (no bigint/Date).
const _metaRecord: SearchMetadataRecord = {
  tenant: { id: "acme", tier: "pro" },
  tags: ["vip", "internal"],
  flags: { verified: true },
};
void _metaRecord;

// SearchNamespaceRecord is the umbrella; both shapes satisfy.
const _row: SearchNamespaceRecord = _rowRecord;
const _meta: SearchNamespaceRecord = _metaRecord;
void _row;
void _meta;

// =============================================================================
// SEARCHQUERY OVER MULTIPLE NAMESPACES — both row and metadata together.
//
// Mirrors REFACTOR.MD Part 5's workflow query namespaces:
//   row: WorkflowRow (flat columns including bigint/Date)
//   args: TArgs (JSONB nested)
//   result: TResult (JSONB nested)
//   metadata: TMetadata (JSONB nested)
// =============================================================================

interface ExampleRow {
  readonly id: string;
  readonly status: "running" | "completed" | "failed";
  readonly attempts: number;
  readonly createdAt: Date;
  readonly executorId: bigint;
  readonly cancelled: boolean;
}

interface ExampleMetadata {
  readonly tenant: { readonly id: string; readonly tier: "free" | "pro" };
  readonly tags: readonly string[];
  readonly risk: number | string; // heterogeneous union; equality-only
  readonly homogeneous: 1 | 2 | 3; // homogeneous number; range OK
}

interface ExamplePayload {
  readonly type: "created" | "cancelled";
  readonly amount: number;
}

type Namespaces = {
  row: ExampleRow;
  meta: ExampleMetadata;
  payload: ExamplePayload;
};

// =============================================================================
// QUERY OBJECT FORM — discriminated AST nodes, namespace-keyed.
// =============================================================================

const objectQuery: SearchQuery<Namespaces> = {
  where: {
    kind: "and",
    nodes: [
      {
        kind: "eq",
        namespace: "row",
        path: "status",
        value: "completed",
      },
      {
        kind: "gte",
        namespace: "row",
        path: "createdAt",
        value: new Date("2027-01-01T00:00:00.000Z"),
      },
      // bigint range comparison on a row column is allowed.
      {
        kind: "gt",
        namespace: "row",
        path: "executorId",
        value: 1000n,
      },
      {
        kind: "contains",
        namespace: "meta",
        path: "tags",
        value: "vip",
      },
      {
        kind: "eq",
        namespace: "payload",
        path: "type",
        value: "created",
      },
    ],
  },
  sort: [
    { namespace: "row", path: "createdAt", direction: "desc" },
    { namespace: "meta", path: "homogeneous", direction: "asc" },
  ],
  limit: 25,
};
void objectQuery;

type _NodeNamespaces = Assert<
  SearchQueryNode<Namespaces> extends { namespace: keyof Namespaces } | { kind: "and" | "or" | "not" }
    ? true
    : false
>;

// =============================================================================
// REJECTED PATTERNS
// =============================================================================

// (range-on-heterogeneous-union rejection is tested below via the builder
// fluent surface; the discriminated-AST form has the same constraint.)

const invalidSortArray: SearchQuery<Namespaces> = {
  sort: [
    {
      namespace: "meta",
      // @ts-expect-error array paths are not sortable
      path: "tags",
      direction: "asc",
    },
  ],
};
void invalidSortArray;

const invalidNamespace: SearchQuery<Namespaces> = {
  where: {
    kind: "eq",
    // @ts-expect-error namespace must be declared in TNamespaces
    namespace: "unknown",
    path: "status",
    value: "completed",
  },
};
void invalidNamespace;

// =============================================================================
// BUILDER FORM — fluent sub-builder per namespace.
// =============================================================================

declare const builder: SearchQueryBuilder<Namespaces>;

const built = builder.and(
  builder.row.status.eq("completed"),
  builder.row.createdAt.gte(new Date("2027-01-01T00:00:00.000Z")),
  builder.row.executorId.gt(1000n),
  builder.meta.tenant.id.eq("acme"),
  builder.meta.tags.contains("vip"),
  builder.payload.amount.gte(100),
);

type _BuiltNode = Assert<typeof built extends SearchQueryNode<Namespaces> ? true : false>;
void built;

// Range on heterogeneous-union meta path is rejected.
// @ts-expect-error meta.risk is `number | string`; range comparisons rejected
builder.meta.risk.gte(10);

// Equality on heterogeneous-union meta path is allowed.
const eqOnUnion = builder.meta.risk.eq("medium");
void eqOnUnion;

// Range on row column with bigint works.
const rangeBigint = builder.row.executorId.lte(2_000n);
void rangeBigint;

// Range on Date column works.
const rangeDate = builder.row.createdAt.lt(new Date("2099-12-31T00:00:00.000Z"));
void rangeDate;

// Boolean column accepts eq/ne/in/notIn but no range.
const boolEq = builder.row.cancelled.eq(true);
void boolEq;
// @ts-expect-error boolean columns are not comparable
builder.row.cancelled.gt(false);

// Invalid enum value is rejected.
// @ts-expect-error value must be a member of the column's union
builder.row.status.eq("unknown");

// =============================================================================
// SEARCHSORT — only homogeneous comparable paths.
// =============================================================================

const validSorts: readonly SearchSort<Namespaces>[] = [
  { namespace: "row", path: "createdAt", direction: "desc" },
  { namespace: "row", path: "executorId", direction: "asc" },
  { namespace: "row", path: "id", direction: "asc" },
  { namespace: "row", path: "attempts", direction: "asc" },
  { namespace: "meta", path: "homogeneous", direction: "asc" },
  { namespace: "payload", path: "amount", direction: "desc" },
];
void validSorts;

const _badSortBool: SearchSort<Namespaces> = {
  namespace: "row",
  // @ts-expect-error boolean columns are not sortable
  path: "cancelled",
  direction: "asc",
};
void _badSortBool;

const _badSortMixedUnion: SearchSort<Namespaces> = {
  namespace: "meta",
  // @ts-expect-error heterogeneous-union meta paths are not sortable
  path: "risk",
  direction: "asc",
};
void _badSortMixedUnion;

// =============================================================================
// REMOVED LEGACY WORKFLOW SEARCH TYPES — must NOT be exported from "../types".
//
// These were the pre-step-12 workflow-specific aliases over the generic
// `SearchQuery<TNamespaces>`. Step 12's introspection consumes the generic
// surface directly with `WorkflowQueryNamespaces<TArgs, TResult, TMetadata>`
// (from schema.ts), making these aliases redundant.
// =============================================================================

// @ts-expect-error WorkflowSearchEngineFields was superseded by `WorkflowRow` (step 10) plus `WorkflowQueryNamespaces` (step 10/12).
import type { WorkflowSearchEngineFields as _RemovedWorkflowSearchEngineFields } from "../types";
// @ts-expect-error WorkflowSearchQuery is removed in favour of `SearchQuery<TNamespaces>` (step 11).
import type { WorkflowSearchQuery as _RemovedWorkflowSearchQuery } from "../types";
// @ts-expect-error WorkflowSearchQueryNode is removed in favour of `SearchQueryNode<TNamespaces>` (step 11).
import type { WorkflowSearchQueryNode as _RemovedWorkflowSearchQueryNode } from "../types";
// @ts-expect-error WorkflowSearchQueryBuilder is removed in favour of `SearchQueryBuilder<TNamespaces>` (step 11).
import type { WorkflowSearchQueryBuilder as _RemovedWorkflowSearchQueryBuilder } from "../types";
// @ts-expect-error WorkflowSearchSort is removed in favour of `SearchSort<TNamespaces>` (step 11).
import type { WorkflowSearchSort as _RemovedWorkflowSearchSort } from "../types";
// @ts-expect-error WorkflowSearchSortDirection is removed in favour of `SearchSortDirection` (step 11).
import type { WorkflowSearchSortDirection as _RemovedWorkflowSearchSortDirection } from "../types";
// @ts-expect-error WorkflowSearchNamespace is removed.
import type { WorkflowSearchNamespace as _RemovedWorkflowSearchNamespace } from "../types";
// @ts-expect-error WorkflowSearchItem is removed in favour of FetchableHandle + WorkflowRow (step 12).
import type { WorkflowSearchItem as _RemovedWorkflowSearchItem } from "../types";
// @ts-expect-error WorkflowSearchResultPage is removed in favour of FindManyResult (step 12).
import type { WorkflowSearchResultPage as _RemovedWorkflowSearchResultPage } from "../types";
// @ts-expect-error WorkflowSearchCursor is removed; FindManyResult is async-iterable with internal pagination (step 12).
import type { WorkflowSearchCursor as _RemovedWorkflowSearchCursor } from "../types";
