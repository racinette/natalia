import type {
  RowNamespaceRecord,
  RowNamespaceScalar,
  SearchMetadataRecord,
  SearchNamespaceRecord,
  SearchQuery,
  SearchQueryBuilder,
  SearchQueryNode,
  SearchSort,
  WorkflowSearchEngineFields,
  WorkflowSearchQuery,
  WorkflowSearchQueryBuilder,
  WorkflowSearchQueryNode,
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
// LEGACY WORKFLOW ALIASES — thin aliases over SearchQuery<{ engine; meta }>.
// =============================================================================

interface ExampleWorkflowMetadata extends SearchMetadataRecord {
  readonly tenantId: string;
  readonly priority: 1 | 2 | 3;
}

type _WorkflowQueryAlias = Assert<
  IsEqual<
    WorkflowSearchQuery<ExampleWorkflowMetadata>,
    SearchQuery<{
      engine: WorkflowSearchEngineFields;
      meta: ExampleWorkflowMetadata;
    }>
  > extends false
    ? false // structural extends-but-not-equals due to interface vs type — accept as long as it's a valid alias
    : true
>;

type _WorkflowNodeAlias = Assert<
  WorkflowSearchQueryNode<ExampleWorkflowMetadata> extends SearchQueryNode<{
    engine: WorkflowSearchEngineFields;
    meta: ExampleWorkflowMetadata;
  }>
    ? true
    : false
>;

declare const workflowBuilder: WorkflowSearchQueryBuilder<ExampleWorkflowMetadata>;

// engine namespace is a row namespace → flat-key access with bigint/Date range.
const workflowBuilt = workflowBuilder.and(
  workflowBuilder.engine.executionTerminalStatus.eq("complete"),
  workflowBuilder.engine.createdAt.gte(new Date("2027-01-01T00:00:00.000Z")),
  workflowBuilder.engine.executorId.gt(1000n),
  workflowBuilder.meta.tenantId.eq("acme"),
);
void workflowBuilt;

// @ts-expect-error executor id range expects bigint
workflowBuilder.engine.executorId.gt(1000);

// @ts-expect-error invalid enum value
workflowBuilder.engine.executionTerminalStatus.eq("succeeded");

// @ts-expect-error meta is the JSONB namespace; tenantId is string only
workflowBuilder.meta.tenantId.gte(1);
