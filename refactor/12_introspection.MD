# 12 Introspection

## Goal

Establish the operator-facing introspection surface: the unified
`QueryableNamespace<...>` shape that every queryable entity uses, the
`FetchableHandle<TRow>` row-fetch interface, the row-prefetch ergonomics,
and the concrete handles for workflows, attached child workflows,
detached child workflows, compensation block instances, and request
compensation invocations.

This step also lands the cross-cutting `txOrConn?` rule (REFACTOR.MD
Part 19) on the new operator-facing IO methods, plugs the
operator-action verb signatures from step 09 onto the concrete
handles, and consumes the schema-derived row / namespace types from
steps 10–11.

## Source Coverage

- `REFACTOR.MD` Part 5 §"Search and introspection — unified shape" —
  `QueryableNamespace<...>`, `FetchableHandle<TRow>`,
  `FindManyResult` / `FindUniqueResult`, `FieldsMask` /
  `ProjectedKeys` / `HandleWithRow`.
- `REFACTOR.MD` Part 5 §"Workflow row, query namespaces, and
  `WorkflowHandleExternal`" — the new workflow handle shape.
- `REFACTOR.MD` Part 5 §"External introspection of children" —
  `attachedChildWorkflows.<name>` and
  `detachedChildWorkflows.<name>` parent-scoped namespaces.
- `REFACTOR.MD` Part 2 §"Query-grounding handle pattern" —
  compensation block instance unique handle.
- `REFACTOR.MD` Part 11 §"Request compensation query surface" —
  request compensation unique handle.
- `REFACTOR.MD` Part 19 — `txOrConn?` rule applied uniformly.

## Public API Target

### Unified introspection types (`src/types/introspection.ts`)

```typescript
type FindUniqueResult<T> =
  | { readonly status: "unique"; readonly value: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly count: number };

interface FindManyResult<T>
  extends PromiseLike<readonly T[]>, AsyncIterable<T> {}

type FieldsMask<TRow> = { readonly [K in keyof TRow]?: true };
type ProjectedKeys<TRow, F extends FieldsMask<TRow>> = ...;
type HandleWithRow<H, TRow> = H & { readonly row: TRow };

interface FetchableHandle<TRow> {
  fetchRow(opts?: FetchOptions): Promise<FindUniqueResult<TRow>>;
  fetchRow<F extends FieldsMask<TRow>>(
    fields: F,
    opts?: FetchOptions,
  ): Promise<FindUniqueResult<Pick<TRow, ProjectedKeys<TRow, F>>>>;
}

interface QueryableNamespace<THandle, TNamespaces, TRow, TId> {
  get(id: TId): THandle;
  get<F>(id: TId, fields: F): HandleWithRow<THandle, Pick<TRow, ...>>;

  findUnique(query, opts?): Promise<FindUniqueResult<THandle>>;
  findUnique<F>(query, opts: { fields: F; ... }): Promise<FindUniqueResult<HandleWithRow<...>>>;

  findMany(query, opts?): FindManyResult<THandle>;
  findMany<F>(query, opts: { fields: F; ... }): FindManyResult<HandleWithRow<...>>;

  count(query, opts?): Promise<number>;
}
```

Per Part 19 every option bag carries `txOrConn?:
IWorkflowConnection | IWorkflowTransaction`. `FetchOptions`,
`FindUniqueOptions`, `FindManyOptions<TNamespaces>`, `CountOptions`
are the option shapes.

### Workflow handle (`WorkflowHandleExternal<W>`)

Single-generic shape parameterised over the workflow header. Wires:

- **`FetchableHandle<WorkflowRow<TArgs, TResult, TMetadata>>`** —
  `fetchRow(...)` reads a fresh row snapshot.
- **`WorkflowOperatorActions<TResult>`** (step 09) —
  `sigkill / sigterm / skip(result, opts?)`.
- **Primitive plane** — `channels` / `streams` / `events` accessors
  (existing shapes; step 16 adds `attributes`).
- **`halts: HaltsNamespaceExternal`** — read-only `list()` over
  workflow execution halt records. No `skip` on the namespace
  itself (resolution is patch + replay or `skip(...)` on the
  workflow itself, which transitions the workflow to `'skipped'`).
- **Parent-scoped namespaces** —
  `attachedChildWorkflows.<name>` /
  `detachedChildWorkflows.<name>` /
  `compensations.<step>` /
  `requestCompensations.<request>`.
- **`wait(opts?)`** — terminal-outcome wait returning
  `WorkflowResult<TResult, ErrorValue<TErrors>>`. Useful for
  already-started workflows; `client.workflows.X.execute(opts)` is
  the equivalent start+wait one-shot.
- **`setRetention(...)`** — operator override of the workflow's
  retention policy.

### Compensation block handle
(`CompensationBlockUniqueHandleExternal<TStep, TArgs, TResult>`)

- `FetchableHandle<CompensationBlockRow<TStep, TArgs, TResult>>`
- `CompensationBlockOperatorActions<TResult>` (step 09) — `skip`
  only; no `sigkill` / `sigterm`; no `strategy` option.
- `id: CompensationId<TStep>` — branded per step.
- Per-instance primitive plane placeholders
  (`attributes` / `streams` / `events` / `channels`). Full accessor
  surfaces wire in steps 13/15/16.

### Compensation block namespace
(`CompensationBlockNamespaceExternal<TStep, TArgs, TResult>`)

`extends QueryableNamespace<...>` — the unified surface, with:

- `THandle = CompensationBlockUniqueHandleExternal<...>`
- `TNamespaces = CompensationBlockQueryNamespaces<TStep, TArgs, TResult>`
- `TRow = CompensationBlockRow<TStep, TArgs, TResult>`
- `TId = CompensationId<TStep>`

### Request compensation handle
(`RequestCompensationUniqueHandleExternal<TPayload, TCompResult>`)

- `FetchableHandle<RequestCompensationRow<TPayload, TCompResult>>`
- `attempts(opts?): Promise<FindUniqueResult<AttemptAccessor>>` —
  separate accessor (not a row column) because `AttemptAccessor`
  exposes its own methods (Part 15).
- `skip(result, opts?)` for non-void result; `skip(opts?)` for void.
- `id: RequestCompensationInstanceId`.
- No per-instance primitives; no halts (Part 11).

### Request compensation namespace

`extends QueryableNamespace<...>` with the corresponding
`RequestCompensationQueryNamespaces<TPayload, TCompResult>` and
`RequestCompensationRow<TPayload, TCompResult>`.

### Attached child workflow handle
(`AttachedChildWorkflowExternalHandle<W>`)

- `FetchableHandle<WorkflowRow<TArgs, TResult, TMetadata>>`
- `id: AttachedChildWorkflowId<W>` — branded per child workflow
  definition.
- Primitive plane (per the parent's child workflow declaration).
- **No** terminal-action verbs (no `sigkill`, no `sigterm`, no
  `skip`). Attached children are subordinate to the parent's
  lifecycle; the parent's verbs cascade down.

### Attached child workflow namespace
(`AttachedChildWorkflowNamespaceExternal<W>`)

`extends QueryableNamespace<...>` — namespaces are the standard
`WorkflowQueryNamespaces<TArgs, TResult, TMetadata>`; `TId` is
`AttachedChildWorkflowId<W>`.

### Detached child workflow namespace

Returns the **standard** `WorkflowHandleExternal<W>` (detached
children are real root workflows). The parent-scoped namespace is a
convenience filter; identity-based `.get(idempotencyKey | args)`
works the same way as the global `client.workflows.<def>.get(...)`.

For step 12's surface we publish
`AttachedChildWorkflowNamespaceExternal` and reuse the same shape
for detached (modulo `THandle`). Step 12's
`workflowInstance.detachedChildWorkflows.<name>` is typed against
`Record<string, AttachedChildWorkflowNamespaceExternal<...>>` for
brevity; step 18 (idempotency-key factory) and step 17 (scheduled
delivery) refine the detached `.get(args | idempotencyKey)`
overloads.

### Client workflow accessor (`WorkflowClientAccessor<W>`)

`extends Omit<QueryableNamespace<...>, "get">` — gains
`findUnique` / `findMany` / `count` over the workflow query
namespaces, alongside `start` / `execute` / `get(idempotencyKey)`.

The omitted `get` is replaced with the identity-based
`get(idempotencyKey: string): WorkflowHandleExternal<W>` overload.
Step 18 will add the `get(args)` overload conditional on
`idempotencyKeyFactory` being declared on the workflow.

`findMany` excludes attached children automatically at runtime
(filter on `row.attached = TRUE`) — runtime guarantee; the type
surface is unchanged.

### Halts namespace

`HaltsNamespaceExternal` exposes `list(opts?)` only. No `findUnique`
or `skip` — REFACTOR.MD Part 3 specifies execution halt resolution
is patch + replay (automatic on worker restart) or `skip(...)` on
the workflow itself.

## Affected Areas

- `src/types/introspection.ts` (new) — abstract introspection types.
- `src/types/schema.ts` — adds `WorkflowRowFlat`,
  `RequestCompensationRowFlat`, `CompensationBlockRow`,
  `CompensationBlockRowFlat`, query-namespace types
  (`WorkflowQueryNamespaces`, `RequestCompensationQueryNamespaces`,
  `CompensationBlockQueryNamespaces`).
- `src/types/search-query.ts` — relaxed
  `SearchNamespaceRecord = unknown` so JSONB namespaces inferred as
  primitive types are accepted.
- `src/types/engine.ts` — full rewrite:
  - new `WorkflowHandleExternal<W>` (single generic);
  - new `CompensationBlockUniqueHandleExternal` /
    `CompensationBlockNamespaceExternal`;
  - new `RequestCompensationUniqueHandleExternal` /
    `RequestCompensationNamespaceExternal`;
  - new `AttachedChildWorkflowExternalHandle` /
    `AttachedChildWorkflowNamespaceExternal`;
  - new `HaltsNamespaceExternal`;
  - `WorkflowClientAccessor<W>` extends the queryable surface;
  - legacy `.execution` / `.compensation` / `.lifecycle` removed.
- `src/types/helpers.ts` — added `InferWorkflowMetadata<W>`.
- `src/client.ts` — runtime stub updated to mirror
  `findUnique` / `findMany` / `count` instead of the old `search`.

## Acceptance Contract

The paired file
`src/types-regression-tests/12_introspection.ts` verifies:

1. `FindUniqueResult<T>` shape (unique / missing / ambiguous).
2. `FindManyResult<T>` is both `PromiseLike<readonly T[]>` and
   `AsyncIterable<T>`.
3. `FetchableHandle.fetchRow()` returns the full row;
   `fetchRow(fields)` returns a typed projection
   (`Pick<TRow, ProjectedKeys<TRow, F>>`).
4. `QueryableNamespace.get(id)` returns a synchronous handle;
   `get(id, fields)` adds a typed `.row` snapshot.
5. `findUnique(query)` resolves to `FindUniqueResult<Handle>`.
6. `findMany(query)` returns `FindManyResult<Handle>`.
7. `count(query)` returns `Promise<number>`.
8. `WorkflowHandleExternal<W>` exposes
   `sigkill / sigterm / skip(result, opts?)` from step 09.
9. `WorkflowHandleExternal<W>` exposes `fetchRow`, `wait`,
   `setRetention`, `halts.list()`, plus the four parent-scoped
   namespaces.
10. The `halts` namespace exposes `list()` only — no `skip`.
11. `CompensationBlockUniqueHandleExternal` exposes `skip(result)`
    only — no `sigkill` / `sigterm`; the `strategy` option is
    rejected.
12. `RequestCompensationUniqueHandleExternal` exposes `attempts()`
    returning `FindUniqueResult<AttemptAccessor>`.
13. `WorkflowClientAccessor<W>` exposes
    `start / execute / get / findUnique / findMany / count`.
14. The legacy `search()` method is gone.

## Out of Scope (Deferred)

- Per-instance primitive accessors on compensation block handles —
  the namespace placeholders exist but the full
  `attributes.X.get / getNowait` and similar accessors land in
  steps 13/15/16.
- `client.workflows.<def>.get(args)` overload (when
  `idempotencyKeyFactory` is declared) — step 18.
- `idempotencyKey` on workflow start required + factory-derivation
  rules — step 18.
- `ScheduledDeliveryOptions` (`delaySeconds` / `scheduledAt`) on
  start options — step 17.
- The full `attributes.X` accessor surface on workflow handles —
  step 16.
- `ChannelSendResult` updates with `txOrConn?` to other primitive
  handles — covered piecemeal as steps 13/15/16 land.
