# 12 Introspection

## Goal

Specify the operator-facing introspection surface for queryable entities
inside a workflow instance — branches, compensation block instances, and
request compensation invocations — and the read-only halt observation surface
for workflow execution halts.

This refactor depends on `11_search_query_generalization` because every
introspection accessor is parameterised over `SearchQuery<TNamespaces>`.

## Source Coverage

- `BUFFER.MD` §5: query-grounding handle pattern for compensation block
  instances.
- `BUFFER.MD` §10: request compensation invocation query surface.
- `BUFFER.MD` §15.10: branch invocation query surface.
- `BUFFER.MD` §7: halts in compensation are skippable; execution halts are not.
- `REFACTOR.MD` Part 2: compensation block instance handle.
- `REFACTOR.MD` Part 3: workflow execution halt records.
- `REFACTOR.MD` Part 7: branch instance status; skip recovery.
- `REFACTOR.MD` Part 8: persistence shapes used by handle reads.

## Public API Target

### Workflow handle introspection namespace

A workflow instance handle (returned by `client.workflows.X.start()` or
`client.workflows.X.get(idempotencyKey)`) exposes three introspection
namespaces:

```ts
workflowInstance.branches.<branchName>.findUnique(query | id)
workflowInstance.branches.<branchName>.findMany(query)
workflowInstance.compensations.<stepName>.findUnique(query | id)
workflowInstance.compensations.<stepName>.findMany(query)
workflowInstance.requestCompensations.<requestName>.findUnique(query | id)
workflowInstance.requestCompensations.<requestName>.findMany(query)
```

Plus a halt-observation surface on the workflow handle for execution halts:

```ts
workflowInstance.halts.list(): Promise<readonly WorkflowHaltRecord[]>
```

Execution halts have no `skip` — resolution is by patch + replay (automatic on
worker restart) or `sigkill()` on the workflow handle.

### Result types

`FindUniqueResult<T>` carries cardinality:

- `{ status: "unique"; value: T }`
- `{ status: "missing" }`
- `{ status: "ambiguous"; count: number }`

### Query overloads

`findUnique` and `findMany` accept either a `SearchQuery<TNamespaces>` builder
callback or, for `findUnique` only, an opaque branded instance id. Branches
and compensation blocks share the namespace shape `{ args: TArgs; metadata:
EntityMetadata }`. Request compensations expose `{ payload: TPayload;
metadata: RequestCompensationMetadata }`.

### Branch instance unique handle

```ts
interface BranchInstanceUniqueHandle<TBranch> {
  status(): Promise<FindUniqueResult<BranchInstanceStatus>>;
  result(): Promise<FindUniqueResult<BranchResultStored<TBranch> | null>>;
  args(): Promise<FindUniqueResult<BranchArgs<TBranch>>>;
  halt(): Promise<FindUniqueResult<BranchHaltRecord | null>>;
  skip(
    ...args: BranchResult<TBranch> extends void
      ? []
      : [result: BranchResultInput<TBranch>]
  ): Promise<
    | FindUniqueResult<{ skipped: true }>
    | { status: "already_terminal"; current: "complete" | "skipped" }
  >;
}
```

### Compensation block instance unique handle

```ts
interface CompensationBlockInstanceUniqueHandle<TStep> {
  status(): Promise<FindUniqueResult<CompensationBlockStatus>>;
  result(): Promise<FindUniqueResult<CompensationBlockStored<TStep> | null>>;
  args(): Promise<FindUniqueResult<StepArgs<TStep>>>;
  halt(): Promise<FindUniqueResult<CompensationBlockHaltRecord | null>>;
  skip(
    ...args: CompensationBlockResult<TStep> extends void
      ? []
      : [result: CompensationBlockResultInput<TStep>]
  ): Promise<
    | FindUniqueResult<{ skipped: true }>
    | { status: "already_terminal"; current: "complete" | "skipped" }
  >;

  attributes: { [K in DeclaredAttributes<TStep>]: PerInstanceAttributeReader };
  streams: { [K in DeclaredStreams<TStep>]: PerInstanceStreamReader };
  events: { [K in DeclaredEvents<TStep>]: PerInstanceEventReader };
  channels: { [K in DeclaredChannels<TStep>]: PerInstanceChannelWriter };
}
```

The per-instance accessors mirror the workflow-handle attribute / stream /
event / channel APIs from `16_attributes_and_streams`, but every read is
wrapped in `FindUniqueResult` to express row-level absence and ambiguity.

### Request compensation unique handle

```ts
interface RequestCompensationUniqueHandle<TRequest> {
  status(): Promise<FindUniqueResult<RequestCompensationStatus>>;
  result(): Promise<FindUniqueResult<RequestCompResult<TRequest> | null>>;
  payload(): Promise<FindUniqueResult<RequestPayload<TRequest>>>;
  info(): Promise<FindUniqueResult<RequestCompensationInfo<unknown>>>;
  attempts(): Promise<FindUniqueResult<AttemptAccessor>>;
  skip(
    ...args: RequestCompResult<TRequest> extends void
      ? []
      : [result: RequestCompResultInput<TRequest>]
  ): Promise<
    | FindUniqueResult<{ skipped: true }>
    | { status: "already_terminal"; current: "complete" | "skipped" }
  >;
}
```

Request compensation invocations have no primitives, no halts.

### Subset handles

`findMany(query)` returns a subset handle. The subset handle exposes only
operations that have well-defined semantics over `N >= 0` matched rows:

```ts
interface SubsetHandle<TStored, TSkipResult> {
  count(): Promise<number>;
  list(opts?: { limit?: number; cursor?: string }): Promise<{
    items: readonly TStored[];
    cursor: string | null;
  }>;
  skip(
    ...args: TSkipResult extends void ? [] : [result: TSkipResult]
  ): Promise<{ affected: number }>;
}
```

For compensation block subset handles, `channels` adds a fan-out `send` that
delivers the same payload to every matched instance.

## Out Of Scope

- Per-namespace search-query namespace contents — that is owned by the
  individual primitive refactors (queues, topics, etc.) layering on
  `11_search_query_generalization`.
- Workflow client cross-workflow search (already covered by
  `11_search_query_generalization` and the existing `WorkflowSearchQuery`
  alias).

## Affected Areas

- `src/types/engine.ts` — `WorkflowHandleExternal` gains the introspection
  namespaces and `halts.list()`.
- `src/types/definitions/steps.ts` — `CompensationBlockHandle` /
  `CompensationBlockUniqueHandle` extended with the search-query overload,
  per-instance primitive accessors, and `skip(...)`.
- `src/types/definitions/branches.ts` — new `BranchInstanceHandle` /
  `BranchInstanceUniqueHandle` types.
- `src/types/definitions/requests.ts` — new
  `RequestCompensationHandle` / `RequestCompensationUniqueHandle` types.
- `src/types/results.ts` — record types for branch/compensation halt rows.

## Acceptance Contract

The paired file `refactor/12_introspection.ts` verifies:

1. `workflowInstance.branches.<name>.findUnique(query)` and
   `findUnique(id)` return a typed unique handle whose `status`, `result`,
   `args`, `halt`, and `skip` return the documented result shapes.
2. `workflowInstance.branches.<name>.findMany(query)` returns a subset
   handle with `count`, `list`, and `skip`.
3. Branches with `result: z.void()` reject any positional arg to `skip`;
   branches with a `result` schema require the result.
4. `workflowInstance.compensations.<step>.findUnique(query)` returns a
   handle that exposes the step's declared per-instance attributes,
   streams, events, and channels, each wrapped in `FindUniqueResult`.
5. No-result compensation blocks expose `null` through `result()` and
   forbid arguments to `skip()`.
6. `workflowInstance.requestCompensations.<request>.findUnique(...)`
   returns a handle whose surface omits primitives and halt observation.
7. `workflowInstance.halts.list()` returns workflow execution halt records;
   the workflow handle does not expose any `skip` for execution halts.
8. Search-query callbacks are typed against the entity's namespaces
   (`args`/`payload` plus `metadata`), and ill-typed references (unknown
   namespace, range comparisons on heterogeneous unions, sort on array
   fields) are rejected.
