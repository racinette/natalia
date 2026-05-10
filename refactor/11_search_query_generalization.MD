# 11 Search Query Generalization

## Goal

Replace the step-11 namespace builder model with a row-scoped predicate DSL:

- old public shape: `(q: SearchQueryBuilder<TNamespaces>) => SearchQueryNode<TNamespaces>`
- new public shape: `(scope: WhereScope<TRowTemplate>) => Predicate`

Authors now write normal filter-like TypeScript over one template that mirrors
the logical row (`WorkflowRow`-style), regardless of whether fields are backed
by scalar SQL columns or JSONB columns.

## Public API Target

### Single row-shaped template

Each queryable entity exposes one template type:

```typescript
type WorkflowWhereTemplate<TArgs, TResult, TMetadata> = {
  readonly id: WorkflowId;
  readonly status: WorkflowStatus;
  readonly createdAt: Date;
  readonly args: TArgs;
  readonly result: TResult | null;
  readonly metadata: TMetadata;
  readonly error: WorkflowErrorEnvelope | null;
  // ...
};
```

No author-facing `row` / `args` / `metadata` namespace map.

### Predicate DSL

```typescript
import { and, eq, gt, every, some } from "natalia/search";

findMany(({ args, metadata, createdAt }) =>
  and(
    eq(args.provider, "metamask"),
    eq(metadata.tenant.id, "acme"),
    gt(createdAt, yesterday),
    every(args.providers, (provider) =>
      eq(provider, "metamask"),
    ),
    some(args.providers, (provider) =>
      eq(provider, "bybit"),
    ),
  ),
);
```

Operators/combinators are value exports from `natalia/search`:

- logical: `and`, `or`, `not`
- scalar: `eq`, `ne`, `in_`, `notIn`, `gt`, `gte`, `lt`, `lte`
- arrays: `contains` (sugar), `every`, `some`

### Typing rules

- Field access is driven by `WhereScope<TRowTemplate>`.
- Operator availability is determined by each field's declared type.
- Range operators are allowed only for homogeneous comparable types
  (`string`, `number`, `bigint`, `Date`).
- Arrays are queried via quantifiers (`every` / `some`) instead of fluent
  `.contains(...)` on namespace builders.

### Sorting

Sorting remains in query options and is typed from the same template:

```typescript
type SearchSort<TTemplate> = {
  path: ComparablePath<TTemplate>;
  direction: "asc" | "desc";
};
```

## Removed Public Shapes

- `SearchQueryBuilder<TNamespaces>`
- `SearchQueryNode<TNamespaces>`
- namespace heuristics (`IsRowNamespace<T>`)
- author-facing namespace maps (`WorkflowQueryNamespaces`, etc.)
- object-literal authoring as primary API (`{ kind, namespace, path, value }`)

## Affected Areas

- `src/types/search-query.ts` — row-scoped DSL (`WhereScope`, `Predicate`,
  operators, quantifiers, sort typing).
- `src/types/introspection.ts` — `QueryPredicate` and `QueryableNamespace`
  rewired to `WhereScope<TRowTemplate>`.
- `src/types/schema.ts` — query templates become full row templates
  (`WorkflowWhereTemplate`, `RequestCompensationWhereTemplate`,
  `CompensationBlockWhereTemplate`).
- `src/types/engine.ts` — introspection wiring uses where-template aliases.
- `src/types-regression-tests/11_search_query_generalization.ts`
- `src/types-regression-tests/12_introspection.ts`

## Acceptance Contract

The paired regression tests verify:

1. Predicate callbacks receive one destructure-friendly scope object.
2. Public return type is `Predicate`.
3. `eq`/`gt`/`gte` and logical combinators work over row + JSON-backed fields
   from the same template.
4. `every` / `some` type-check array predicates.
5. Range operators reject heterogeneous unions and booleans.
6. Sort paths are typed from one template (no namespace key).
7. Legacy `SearchQueryBuilder` / `SearchQueryNode` are absent from public types.
