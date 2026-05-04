# 11 Search Query Generalization

## Goal

Generalise the legacy two-namespace
`WorkflowSearchQuery<TMeta>` into a reusable typed
`SearchQuery<TNamespaces>` over an arbitrary record of namespaces, so
that step 12 introspection, queue dead-letter searches, topic consumer
filters, and request-compensation queries all reuse the same query
machinery.

## Source Coverage

- `REFACTOR.MD` Part 9: Search Query Refactoring.
- `REFACTOR.MD` Part 5: Workflow query namespaces (`row` / `args` /
  `result` / `metadata` / `error`) consumed by step 12.
- `REFACTOR.MD` Part 10: dead-letter row + payload namespaces.
- `REFACTOR.MD` Part 12: topic consumer metadata + payload filter
  namespaces.

## Public API Target

### Two namespace shapes

A namespace value falls into one of two structural categories:

```typescript
type RowNamespaceScalar =
  | string | number | boolean | bigint | Date | null | undefined;

type RowNamespaceRecord = { readonly [key: string]: RowNamespaceScalar };

type SearchMetadataScalar = string | number | boolean | null;
type SearchMetadataValue =
  | SearchMetadataScalar
  | readonly SearchMetadataScalar[]
  | undefined
  | SearchMetadataRecord;
type SearchMetadataRecord = { readonly [key: string]: SearchMetadataValue };

type SearchNamespaceRecord = object; // structurally constrained at use sites
```

- **Row namespaces** are flat records of SQL row scalars. They admit
  `bigint` and `Date` because row columns carry total ordering and
  survive across storage backends. Used by the `row` namespace on
  every queryable entity.
- **Metadata namespaces** are nested JSONB-friendly records. Leaves
  are `string | number | boolean | null | undefined`, plus arrays of
  those, plus nested records. No `bigint`/`Date` (those don't survive
  JSONB serialisation without a convention). Used by JSONB columns:
  `args`, `result`, `metadata`, `info`, `payload`, `error`.

The constraint on `SearchNamespaceRecord` is intentionally loose
(`object`) so that explicit row shapes like `WorkflowRow` (step 10),
which lack an `[key: string]` index signature, can serve as namespaces
without being forced to widen their column types.

### Row vs metadata dispatch

The query machinery dispatches on namespace shape via an internal
`IsRowNamespace<T>` predicate. A namespace is treated as a row
namespace iff every property's value type is a `RowNamespaceScalar`
**and** at least one column carries `bigint` or `Date` (to disambiguate
from a metadata namespace whose leaves all happen to be plain
scalars).

This means a row namespace declaration is expected to include a
timestamp / count / id column of type `Date` / `bigint`. The published
`WorkflowRow` and `RequestCompensationRow` (step 10) both do.

### Discriminated AST

```typescript
type SearchQueryNode<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> =
  | { kind: "and"; nodes: readonly SearchQueryNode<TNamespaces>[] }
  | { kind: "or"; nodes: readonly SearchQueryNode<TNamespaces>[] }
  | { kind: "not"; node: SearchQueryNode<TNamespaces> }
  | NamespacePredicateNode<keyof TNamespaces, ...>;
```

Per-namespace predicate nodes:

| Operator       | Row namespaces                              | Metadata namespaces                  |
| -------------- | ------------------------------------------- | ------------------------------------ |
| `eq` / `ne`    | flat key on any column                       | path on any scalar leaf              |
| `in` / `notIn` | flat key on any column                       | path on any scalar leaf              |
| `gt` / `gte` / `lt` / `lte` | flat key on `string` / `number` / `bigint` / `Date` columns | path on `string` / `number` leaves |
| `exists`       | flat key on any column                       | path on any descendable position     |
| `contains` / `containsAny` / `containsAll` | n/a (rows have no array columns) | array paths only |

Range comparisons and sorting are restricted to homogeneously-typed
paths. A `string | number` union is admitted under equality only —
ordering across storage backends is not portable.

### Sort

```typescript
type SearchSort<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> = NamespaceSortTerm<keyof TNamespaces, ...>;
```

Only paths whose value resolves to a single one of `string` / `number`
/ `bigint` / `Date` (row namespaces) or `string` / `number` (metadata
namespaces) appear in `SearchSort`. Boolean columns and heterogeneous
unions are rejected at compile time.

### Builder

```typescript
type SearchQueryBuilder<
  TNamespaces extends Record<string, SearchNamespaceRecord>,
> = {
  readonly [K in keyof TNamespaces]: NamespaceBuilder<TNamespaces, TNamespaces[K]>;
} & {
  and(...nodes): SearchQueryNode<TNamespaces>;
  or(...nodes):  SearchQueryNode<TNamespaces>;
  not(node):     SearchQueryNode<TNamespaces>;
};
```

The builder exposes a sub-builder per namespace key. Row sub-builders
are flat (`builder.row.status.eq(...)`), metadata sub-builders are
nested (`builder.metadata.tenant.id.eq(...)`).

### Legacy aliases preserved

The existing workflow-search aliases remain so call sites and step
12 can transition incrementally:

```typescript
type WorkflowSearchNamespaces<TMetadata> = {
  engine: WorkflowSearchEngineFields;
  meta: TMetadata;
};

type WorkflowSearchQueryNode<TMeta> =
  SearchQueryNode<WorkflowSearchNamespaces<TMeta>>;
type WorkflowSearchSort<TMeta> =
  SearchSort<WorkflowSearchNamespaces<TMeta>>;
type WorkflowSearchQuery<TMeta> extends
  SearchQuery<WorkflowSearchNamespaces<TMeta>> {}
type WorkflowSearchQueryBuilder<TMeta> =
  SearchQueryBuilder<WorkflowSearchNamespaces<TMeta>>;
```

Step 12 will replace `WorkflowSearchEngineFields` with the unified
`WorkflowRow` row namespace and add the JSONB namespaces (`args`,
`result`, `metadata`, `error`) to produce the workflow query
namespaces from REFACTOR.MD Part 5.

## Affected Areas

- `src/types/search-query.ts` — all the new generic types plus thin
  legacy aliases.
- `src/types/engine.ts` — unchanged; legacy `WorkflowSearchQuery`
  consumers still typecheck via the alias. Step 12 will rewrite the
  consumption.

## Acceptance Contract

The paired file
`src/types-regression-tests/11_search_query_generalization.ts`
verifies:

1. `RowNamespaceScalar` admits `string | number | boolean | bigint |
   Date | null | undefined`.
2. Both namespace shapes (`RowNamespaceRecord`,
   `SearchMetadataRecord`) and the umbrella `SearchNamespaceRecord`
   are publicly exported.
3. `SearchQuery<TNamespaces>` accepts a multi-namespace map (tested
   with `row` + `meta` + `payload`).
4. The discriminated AST form supports `eq`/`gte`/`contains` etc.
   keyed by the supplied namespace name.
5. Range comparisons on heterogeneous-union meta paths are rejected.
6. Sort terms on array meta paths are rejected.
7. The builder form exposes one sub-builder per namespace key, with
   row vs metadata dispatch.
8. The builder rejects:
   - range on boolean row columns,
   - range on heterogeneous-union meta paths,
   - invalid enum values,
   - cross-shape misuse (e.g. range on a string-typed metadata leaf).
9. Range on `bigint` / `Date` row columns is admitted.
10. The legacy `WorkflowSearchQuery<TMeta>` /
    `WorkflowSearchQueryNode<TMeta>` /
    `WorkflowSearchQueryBuilder<TMeta>` aliases resolve to the
    generic forms and continue to type-check workflow searches.

## Out of Scope (Deferred)

- Workflow query namespaces (`row` / `args` / `result` / `metadata`
  / `error`) and their consumption on operator handles — step 12.
- Replacing `WorkflowSearchEngineFields` with `WorkflowRow` — step
  12.
- The `findUnique` / `findMany` / `count` surface that consumes a
  `SearchQuery<TNamespaces>` predicate — step 12.
- `SearchSort<TNamespaces>` ordering invariants beyond compile-time
  homogeneity (descending null-position semantics, stable ordering)
  — runtime concern.
- SQL lowering of the AST — runtime concern.
