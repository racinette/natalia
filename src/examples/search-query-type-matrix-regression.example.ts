import { z } from "zod";
import { createWorkflowClient } from "../client";
import type { SearchMetadataFromInput, WorkflowSearchQuery } from "../types";
import { defineWorkflow } from "../workflow";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type UnionObjectProp<U, K extends PropertyKey> = U extends unknown
  ? U extends readonly unknown[]
    ? undefined
    : U extends object
      ? K extends keyof U
        ? U[K]
        : undefined
      : undefined
  : never;

const SearchTypeMatrixMetadata = z.object({
  tenant: z.object({
    id: z.string(),
    priority: z.number(),
    flags: z.array(z.string()),
    active: z.boolean().optional(),
  }),
  tags: z.array(z.string()),
  riskScore: z.number(),
  status: z.enum(["new", "approved", "rejected"]),
  nullableMarker: z.string().nullable(),
  present: z.union([
    z.object({
      type: z.literal("package"),
      status: z.enum(["shipping", "delivered"]),
    }),
    z.object({
      type: z.enum(["sms", "call"]),
      status: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    }),
    z.array(z.number()),
    z.number(),
    z.undefined(),
    z.null(),
  ]),
  deep: z.object({
    a: z.union([
      z.object({
        b: z.union([
          z.object({
            c: z.object({
              d: z.union([z.number(), z.string()]),
            }),
          }),
          z.number(),
        ]),
      }),
      z.undefined(),
    ]),
  }),
});

const SearchTypeMatrixWorkflow = defineWorkflow({
  name: "searchTypeMatrix",
  metadata: SearchTypeMatrixMetadata,
  execute: async () => undefined,
});

type SearchTypeMatrixQueryMetadata = SearchMetadataFromInput<
  z.input<typeof SearchTypeMatrixMetadata>
>;

type _PresentTypeInferred = UnionObjectProp<
  SearchTypeMatrixQueryMetadata["present"],
  "type"
>;
type _PresentStatusInferred = UnionObjectProp<
  SearchTypeMatrixQueryMetadata["present"],
  "status"
>;
type _PresentTypeExpected = Assert<
  IsEqual<_PresentTypeInferred, "package" | "sms" | "call" | undefined>
>;
type _PresentStatusExpected = Assert<
  IsEqual<
    _PresentStatusInferred,
    "shipping" | "delivered" | 1 | 2 | 3 | 4 | undefined
  >
>;
type _DeepAInferred = UnionObjectProp<SearchTypeMatrixQueryMetadata["deep"], "a">;
type _DeepBInferred = UnionObjectProp<_DeepAInferred, "b">;
type _DeepCInferred = UnionObjectProp<_DeepBInferred, "c">;
type _DeepDInferred = UnionObjectProp<_DeepCInferred, "d">;
type _DeepBExpected = Assert<
  IsEqual<_DeepBInferred, { c: { d: number | string } } | number | undefined>
>;
type _DeepDExpected = Assert<IsEqual<_DeepDInferred, number | string | undefined>>;

export async function searchQueryTypeMatrixRegression(): Promise<void> {
  const client = createWorkflowClient({
    searchTypeMatrix: SearchTypeMatrixWorkflow,
  });

  // ---------------------------------------------------------------------------
  // Object query overload: valid usages
  // ---------------------------------------------------------------------------

  const objectQueryResult = await client.workflows.searchTypeMatrix.search({
    where: {
      kind: "and",
      nodes: [
        {
          kind: "eq",
          namespace: "engine",
          path: "executionTerminalStatus",
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
          path: "tenant.flags",
          value: "can_view_transactions",
        },
        {
          kind: "eq",
          namespace: "meta",
          path: "tenant.id",
          value: "tenant-acme",
        },
        {
          kind: "not",
          node: {
            kind: "eq",
            namespace: "meta",
            path: "status",
            value: "rejected",
          },
        },
      ],
    },
    sort: [
      { namespace: "engine", path: "createdAt", direction: "desc" },
      { namespace: "meta", path: "riskScore", direction: "asc" },
    ],
    limit: 50,
    cursor: "opaque-cursor",
  });

  type _ObjectResultNoAny = Assert<
    IsAny<typeof objectQueryResult> extends false ? true : false
  >;
  type _MetadataNoAny = Assert<
    IsAny<(typeof objectQueryResult.items)[number]["metadata"]> extends false
      ? true
      : false
  >;

  // ---------------------------------------------------------------------------
  // Object query overload: invalid usages
  // ---------------------------------------------------------------------------

  const invalidGroupShape: WorkflowSearchQuery<SearchTypeMatrixQueryMetadata> = {
    where: {
      kind: "and",
      nodes: [],
      // @ts-expect-error group nodes do not accept `node`; only `nodes`
      node: { kind: "or", nodes: [] },
    },
  };

  const invalidEnginePath: WorkflowSearchQuery<SearchTypeMatrixQueryMetadata> = {
    where: {
      kind: "eq",
      namespace: "engine",
      // @ts-expect-error engine namespace does not accept metadata paths
      path: "tenant.id",
      // @ts-expect-error engine path/value pairing requires engine field value
      value: "tenant-acme",
    },
  };

  const invalidMetaContainsOnScalar: WorkflowSearchQuery<SearchTypeMatrixQueryMetadata> =
    {
      where: {
        kind: "contains",
        namespace: "meta",
        // @ts-expect-error `riskScore` is scalar, not array
        path: "riskScore",
        value: 10,
      },
    };

  const invalidMetaEqValueType: WorkflowSearchQuery<SearchTypeMatrixQueryMetadata> =
    {
      where: {
        kind: "eq",
        namespace: "meta",
        path: "riskScore",
        // @ts-expect-error riskScore expects number
        value: "high",
      },
    };

  const invalidSortDirection: WorkflowSearchQuery<SearchTypeMatrixQueryMetadata> =
    {
      sort: [
        {
          namespace: "engine",
          path: "createdAt",
          // @ts-expect-error direction must be "asc" | "desc"
          direction: "descending",
        },
      ],
    };

  const invalidMetaSortPath: WorkflowSearchQuery<SearchTypeMatrixQueryMetadata> =
    {
      sort: [
        {
          namespace: "meta",
          // @ts-expect-error unknown metadata sort path
          path: "tenant.unknown",
          direction: "asc",
        },
      ],
    };

  void invalidGroupShape;
  void invalidEnginePath;
  void invalidMetaContainsOnScalar;
  void invalidMetaEqValueType;
  void invalidSortDirection;
  void invalidMetaSortPath;

  // ---------------------------------------------------------------------------
  // Builder overload: valid usages
  // ---------------------------------------------------------------------------

  const builderQueryResult = await client.workflows.searchTypeMatrix.search(
    (q) =>
      q.and(
        q.engine.createdAt.gte(new Date("2027-01-01T00:00:00.000Z")),
        q.engine.executionTerminalStatus.eq("complete"),
        q.meta.tenant.id.eq("tenant-acme"),
        q.meta.tenant.flags.contains("can_view_transactions"),
        q.not(q.meta.status.eq("rejected")),
      ),
    {
      sort: [
        { namespace: "engine", path: "createdAt", direction: "desc" },
        { namespace: "meta", path: "riskScore", direction: "asc" },
      ],
      limit: 20,
      cursor: "opaque-cursor-2",
    },
  );

  type _BuilderResultNoAny = Assert<
    IsAny<typeof builderQueryResult> extends false ? true : false
  >;
  type _BuilderCursorType = Assert<
    IsEqual<typeof builderQueryResult.nextCursor, string | undefined>
  >;

  // ---------------------------------------------------------------------------
  // Builder overload: invalid usages
  // ---------------------------------------------------------------------------

  client.workflows.searchTypeMatrix.search((q) => {
    // @ts-expect-error array metadata fields do not expose eq/ne/in/notIn
    return q.meta.tags.eq("vip");
  });

  client.workflows.searchTypeMatrix.search((q) => {
    // @ts-expect-error boolean engine field does not expose range operators
    return q.engine.isChild.gt(true);
  });

  client.workflows.searchTypeMatrix.search((q) => {
    // @ts-expect-error number metadata field does not expose contains
    return q.meta.riskScore.contains(10);
  });

  // ---------------------------------------------------------------------------
  // Nasty union metadata: transitive absence/nullability + mixed capabilities
  // ---------------------------------------------------------------------------

  const nastyUnionBuilderResult = await client.workflows.searchTypeMatrix.search(
    (q) =>
      q.and(
        // object-branch access: type exists on object branches; undefined on others
        q.meta.present.type.eq("package"),
        q.meta.present.type.eq(undefined),
        // mixed string|number union on status from different object variants
        q.meta.present.status.eq(1),
        q.meta.present.status.eq("shipping"),
        q.meta.present.status.in([1, 2, "delivered", undefined]),
        // range exists because status has comparable branches (string|number)
        q.meta.present.status.gte(2),
        // scalar capability on present itself because one branch is number
        q.meta.present.gt(10),
        q.meta.present.eq(null),
        q.meta.present.eq(undefined),
        // array capability on present itself because one branch is number[]
        q.meta.present.contains(42),
        q.meta.present.containsAny([1, 2, 3]),
      ),
  );

  type _NastyUnionResultNoAny = Assert<
    IsAny<typeof nastyUnionBuilderResult> extends false ? true : false
  >;

  client.workflows.searchTypeMatrix.search((q) => {
    // @ts-expect-error present array branch is number[] only
    return q.meta.present.contains("bad");
  });

  client.workflows.searchTypeMatrix.search((q) => {
    // @ts-expect-error type is scalar/undefined, no array contains capability
    return q.meta.present.type.contains("package");
  });

  client.workflows.searchTypeMatrix.search((q) => {
    // @ts-expect-error present number branch does not allow string eq directly
    return q.meta.present.eq("sms");
  });

  // ---------------------------------------------------------------------------
  // Deep nested union tree: a.b.c.d with transitive optionality
  // ---------------------------------------------------------------------------

  const deepUnionBuilderResult = await client.workflows.searchTypeMatrix.search(
    (q) =>
      q.and(
        q.meta.deep.a.b.c.d.eq(1),
        q.meta.deep.a.b.c.d.eq("delivered"),
        q.meta.deep.a.b.c.d.eq(undefined),
        q.meta.deep.a.b.c.d.in([1, "x", undefined]),
        q.meta.deep.a.b.c.d.gte(0),
        q.meta.deep.a.b.c.d.gte("a"),
        // b is union(object | number | undefined), so it should support both
        // object descent and scalar range operations.
        q.meta.deep.a.b.gte(10),
      ),
  );

  type _DeepUnionResultNoAny = Assert<
    IsAny<typeof deepUnionBuilderResult> extends false ? true : false
  >;

  client.workflows.searchTypeMatrix.search((q) => {
    // @ts-expect-error d is scalar union, no array contains capability
    return q.meta.deep.a.b.c.d.contains(1);
  });
}
