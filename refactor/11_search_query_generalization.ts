import type {
  DeadLetterSearchQuery,
  SearchQuery,
  SearchQueryBuilder,
  SearchQueryNode,
  TopicFilterQuery,
  WorkflowSearchQuery,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type Namespaces = {
  engine: {
    createdAt: Date;
    status: "running" | "complete" | "failed";
    attempts: number;
  };
  meta: {
    tenant: { id: string; tier: "free" | "pro" };
    tags: string[];
    risk: number | string;
    homogeneous: 1 | 2 | 3;
    mixedObject:
      | { type: "email"; priority: number }
      | { type: "sms"; priority: number };
  };
  payload: {
    type: "created" | "cancelled";
    amount: number;
  };
};

const objectQuery: SearchQuery<Namespaces> = {
  where: {
    kind: "and",
    nodes: [
      {
        kind: "eq",
        namespace: "engine",
        path: "status",
        value: "complete",
      },
      {
        kind: "gte",
        namespace: "engine",
        path: "createdAt",
        value: new Date("2027-01-01T00:00:00.000Z"),
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
    { namespace: "engine", path: "createdAt", direction: "desc" },
    { namespace: "meta", path: "homogeneous", direction: "asc" },
  ],
  limit: 25,
};

type _QueryNoAny = Assert<SearchQuery<Namespaces> extends object ? true : false>;
type _NodeNamespaces = Assert<
  SearchQueryNode<Namespaces> extends { namespace: keyof Namespaces } ? true : false
>;

const invalidRangeOnMixedUnion: SearchQuery<Namespaces> = {
  where: {
    kind: "gte",
    namespace: "meta",
    // @ts-expect-error range comparisons reject heterogeneously typed unions
    path: "risk",
    value: 10,
  },
};

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

const invalidNamespace: SearchQuery<Namespaces> = {
  where: {
    kind: "eq",
    // @ts-expect-error namespace must be declared in TNamespaces
    namespace: "unknown",
    path: "status",
    value: "complete",
  },
};

declare const builder: SearchQueryBuilder<Namespaces>;

const built = builder.and(
  builder.engine.status.eq("complete"),
  builder.meta.tenant.id.eq("tenant-a"),
  builder.payload.amount.gte(100),
  builder.meta.tags.contains("vip"),
);
type _BuiltNode = Assert<typeof built extends SearchQueryNode<Namespaces> ? true : false>;

// @ts-expect-error mixed union paths are equality-only
builder.meta.risk.gte(10);
// @ts-expect-error invalid enum value
builder.engine.status.eq("cancelled");
// @ts-expect-error nested object union value must match allowed literal values
builder.meta.mixedObject.type.eq("push");

type _WorkflowAlias = Assert<
  WorkflowSearchQuery<{ tenantId: string }> extends SearchQuery<{
    engine: any;
    meta: { tenantId: string };
  }>
    ? true
    : false
>;

type _DeadLetterAlias = Assert<
  DeadLetterSearchQuery<{ tenantId: string }, { type: "email" }> extends SearchQuery<{
    deadLetter: any;
    meta: { tenantId: string };
    payload: { type: "email" };
  }>
    ? true
    : false
>;

type _TopicFilterAlias = Assert<
  TopicFilterQuery<{ type: "email" }, { tenantId: string }> extends SearchQuery<{
    meta: { tenantId: string };
    payload: { type: "email" };
  }>
    ? true
    : false
>;

void objectQuery;
void invalidRangeOnMixedUnion;
void invalidSortArray;
void invalidNamespace;
