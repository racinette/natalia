import {
  and,
  contains,
  desc,
  eq,
  every,
  gt,
  gte,
  in_,
  isMissing,
  isNull,
  isNullish,
  lt,
  lte,
  ne,
  not,
  notIn,
  or,
  some,
} from "../search";
import type { Predicate, SearchQuery, SearchSort, WhereScope } from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

interface ExampleWhereTemplate {
  readonly id: string;
  readonly status: "running" | "completed" | "failed";
  readonly attempts: number;
  readonly createdAt: Date;
  readonly executorId: bigint;
  readonly cancelled: boolean;
  readonly maybeCount: number | null;
  readonly maybeScore: number | null | undefined;
  readonly slugOrRevision: string | bigint;
  readonly riskOrMissing: string | number | null | undefined;
  readonly metadata: {
    readonly tenant: { readonly id: string; readonly tier: "free" | "pro" };
    readonly tags: readonly string[];
    readonly optionalTags: readonly ("priority" | "vip")[] | null;
    readonly maybeMissing?: number;
    readonly risk: number | string; // heterogeneous union; equality-only
    readonly homogeneous: 1 | 2 | 3; // homogeneous number; range OK
  };
  readonly payload: {
    readonly type: "created" | "cancelled";
    readonly amount: number;
  };
  readonly args: {
    readonly providers: readonly ("metamask" | "polymarket" | "bybit")[];
  };
  readonly result: {
    readonly resolutions: readonly { readonly status: "resolved" | "pending" }[];
  } | null;
  readonly matrix: readonly (readonly number[])[];
  readonly audits: readonly {
    readonly by: string;
    readonly at: Date;
    readonly tags: readonly string[];
  }[];
};

declare const scope: WhereScope<ExampleWhereTemplate>;

const built: Predicate = and(
  eq(scope.status, "completed"),
  gte(scope.createdAt, new Date("2027-01-01T00:00:00.000Z")),
  gt(scope.executorId, 1000n),
  eq(scope.metadata.tenant.id, "acme"),
  contains(scope.metadata.tags, "vip"),
  gte(scope.payload.amount, 100),
  every(scope.args.providers, (provider) =>
    in_(provider, ["metamask", "polymarket", "bybit"]),
  ),
  some(scope.result.resolutions, (resolution) =>
    eq(resolution.status, "resolved"),
  ),
  some(scope.matrix, (row) => some(row, (cell) => gt(cell, 0))),
  every(scope.audits, (audit) =>
    and(
      ne(audit.by, ""),
      lte(audit.at, new Date("2099-12-31T00:00:00.000Z")),
      some(audit.tags, (tag) => ne(tag, "")),
    ),
  ),
);
void built;

const logicalComposition: Predicate = not(
  or(eq(scope.status, "running"), eq(scope.status, "failed")),
);
void logicalComposition;

// Range on heterogeneous-union fields is rejected.
// @ts-expect-error metadata.risk is `number | string`; range comparisons rejected
gt(scope.metadata.risk, 10);
// @ts-expect-error slugOrRevision is `string | bigint`; heterogeneous comparable unions rejected
gt(scope.slugOrRevision, 10n);

// Equality on heterogeneous-union fields is allowed.
const eqOnUnion = eq(scope.metadata.risk, "medium");
void eqOnUnion;

// Range on bigint/date leaves works.
const rangeBigint = gt(scope.executorId, 1_000n);
const rangeDate = lt(scope.createdAt, new Date("2099-12-31T00:00:00.000Z"));
void rangeBigint;
void rangeDate;

const boolEq = eq(scope.cancelled, true);
void boolEq;
const nullableEq = eq(scope.maybeCount, null);
const nullableIn = in_(scope.maybeCount, [1, 2, null]);
void nullableEq;
void nullableIn;

const nullableRange = gt(scope.maybeScore, 0);
const nullableRange2 = lte(scope.maybeScore, 10);
const eqUndefined = eq(scope.maybeScore, undefined);
const inNullish = in_(scope.maybeScore, [1, null, undefined]);
const nestedUndefinedEq = eq(scope.metadata.maybeMissing, undefined);
const nestedNullableRange = gt(scope.metadata.maybeMissing, 0);
void nullableRange;
void nullableRange2;
void eqUndefined;
void inNullish;
void nestedUndefinedEq;
void nestedNullableRange;

const shortcutNull = isNull(scope.maybeCount);
const shortcutMissing = isMissing(scope.maybeScore);
const shortcutNullish = isNullish(scope.maybeScore);
const nestedShortcutMissing = isMissing(scope.metadata.maybeMissing);
void shortcutNull;
void shortcutMissing;
void shortcutNullish;
void nestedShortcutMissing;

const enumIn = in_(scope.status, ["running", "completed"]);
const enumNotIn = notIn(scope.status, ["failed"]);
void enumIn;
void enumNotIn;
// @ts-expect-error boolean columns are not comparable
gt(scope.cancelled, false);
// @ts-expect-error heterogeneous non-nullish branches remain invalid for range
gt(scope.riskOrMissing, 0);

// Invalid enum value is rejected.
// @ts-expect-error value must be a member of the column's union
eq(scope.status, "unknown");
// @ts-expect-error in_ values must conform to field union
in_(scope.status, ["running", "unknown"]);
// @ts-expect-error array membership value type must match element type
contains(scope.metadata.tags, 123);
// @ts-expect-error quantifiers require an array reference
some(scope.status, (value) => eq(value, "running"));
// @ts-expect-error quantifier callback must return Predicate
every(scope.metadata.tags, () => true);
// @ts-expect-error object scopes are navigable nodes, not scalar field refs
eq(scope.result, null);
// @ts-expect-error isNull requires a field that includes null
isNull(scope.status);
// @ts-expect-error isMissing requires a field that includes undefined
isMissing(scope.maybeCount);
// @ts-expect-error isNullish requires both null and undefined in the field union
isNullish(scope.metadata.maybeMissing);

const validSorts: readonly SearchSort<ExampleWhereTemplate>[] = [
  { path: "createdAt", direction: "desc" },
  { path: "executorId", direction: "asc" },
  { path: "id", direction: "asc" },
  { path: "attempts", direction: "asc" },
  { path: "maybeCount", direction: "asc" },
  { path: "metadata.homogeneous", direction: "asc" },
  { path: "payload.amount", direction: "desc" },
];
void validSorts;

const fromHelper = desc(scope.createdAt);
type _DescDirection = Assert<IsEqual<typeof fromHelper.direction, "desc">>;
void fromHelper;

const _badSortBool: SearchSort<ExampleWhereTemplate> = {
  // @ts-expect-error boolean columns are not sortable
  path: "cancelled",
  direction: "asc",
};
void _badSortBool;

const _badSortArray: SearchSort<ExampleWhereTemplate> = {
  // @ts-expect-error array paths are not sortable
  path: "metadata.tags",
  direction: "asc",
};
void _badSortArray;

const _badSortMixedUnion: SearchSort<ExampleWhereTemplate> = {
  // @ts-expect-error heterogeneous-union meta paths are not sortable
  path: "metadata.risk",
  direction: "asc",
};
void _badSortMixedUnion;

const _badSortIntoArrayElements: SearchSort<ExampleWhereTemplate> = {
  // @ts-expect-error sort paths cannot traverse into array element properties
  path: "audits.by",
  direction: "asc",
};
void _badSortIntoArrayElements;

const _badSortUnknownPath: SearchSort<ExampleWhereTemplate> = {
  // @ts-expect-error path must exist in the where template
  path: "metadata.tenant.plan",
  direction: "asc",
};
void _badSortUnknownPath;

const query: SearchQuery<ExampleWhereTemplate> = {
  where: built,
  sort: validSorts,
  limit: 25,
};
void query;

const queryWithoutWhere: SearchQuery<ExampleWhereTemplate> = {
  limit: 1,
};
void queryWithoutWhere;

const _badQueryLimit: SearchQuery<ExampleWhereTemplate> = {
  // @ts-expect-error limit must be a number
  limit: "25",
};
void _badQueryLimit;

// @ts-expect-error Legacy builder surface is removed from public API.
import type { SearchQueryBuilder as _RemovedSearchQueryBuilder } from "../types";
// @ts-expect-error Legacy AST node surface is removed from public API.
import type { SearchQueryNode as _RemovedSearchQueryNode } from "../types";
