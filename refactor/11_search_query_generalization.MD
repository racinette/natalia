# 11 Search Query Generalization

## Goal

Generalize workflow search into a reusable typed query system over named JSON namespaces.

## Source Coverage

- `REFACTOR.MD` Part 9: Search Query Refactoring.
- Queue dead-letter search from Part 10.
- Request compensation query surface from Part 11.
- Topic filter namespaces from Part 12.

## Public API Target

- Export `SearchQuery<TNamespaces>` and `SearchQueryNode`.
- Workflow search becomes an alias over engine and metadata namespaces.
- Dead-letter queries, topic filters, and request compensation queries use the same generic query machinery.
- Union fields are equality-only unless the union is homogeneously comparable.
- Range comparisons and sorting are limited to comparable homogeneous fields.
- Array fields support containment where appropriate but are not sortable.

## Affected Areas

- `src/types/search-query.ts`
- `src/types/engine.ts`
- Queue, request, topic, and dead-letter public types.
- SQL query lowering for JSONB namespaces.

## Acceptance Contract

The paired file `refactor/11_search_query_generalization.ts` verifies multi-namespace query inference, valid object and builder forms, and invalid range/sort behavior for union and non-comparable fields.
