# 12 Introspection

## Goal

Establish the operator-facing introspection surface: the unified
`QueryableNamespace<...>` shape that every queryable entity uses, the
`FetchableHandle<TRow>` row-fetch interface, the row-prefetch ergonomics,
and the concrete handles for workflows, attached child workflows,
detached child workflows, compensation block instances, and request
compensation invocations.

This step also lands the cross-cutting operator session rule (REFACTOR.MD
Part 19) on snapshot/command IO methods, plugs the operator-action verb
signatures from step 09 onto the concrete handles, and consumes the
schema-derived row / namespace types from steps 10–11.

## Source Coverage

- `REFACTOR.MD` Part 5 §"Search and introspection — unified shape" —
  `QueryableNamespace<...>`, `FetchableHandle<TRow>`,
  `FindResult`, `FieldsMask` /
  `ProjectedKeys` / `HandleWithRow`.
- `REFACTOR.MD` Part 5 §"Workflow row, query namespaces, and
  `WorkflowHandleExternal`" — the new workflow handle shape.
- `REFACTOR.MD` Part 5 §"External introspection of children" —
  `children.attached.<name>` and
  `children.detached.<name>` parent-scoped namespaces.
- `REFACTOR.MD` Part 2 §"Query-grounding handle pattern" —
  compensation block instance unique handle.
- `REFACTOR.MD` Part 11 §"Request compensation query surface" —
  request compensation unique handle.
- `REFACTOR.MD` Part 19 — operator session model; snapshot/command IO
  takes `session` first.

## Public API Target

### Unified introspection types (`src/types/introspection.ts`)

```typescript
type FindResult<T> = Promise<readonly T[]>;

type FieldsMask<TRow> = { readonly [K in keyof TRow]?: true };
type ProjectedKeys<TRow, F extends FieldsMask<TRow>> = ...;
type HandleWithRow<H, TRow> = H & { readonly row: TRow };

interface FetchableHandle<TRow> {
  fetchRow<TRaw>(session: OperatorSession<TRaw>, opts?: FetchRowOptions<TRow>): Promise<TRow | undefined>;
  fetchRow<TRaw, F extends FieldsMask<TRow>>(
    session: OperatorSession<TRaw>,
    opts: FetchRowOptions<TRow> & { readonly fields: F },
  ): Promise<Pick<TRow, ProjectedKeys<TRow, F>> | undefined>;
}

interface QueryableNamespace<THandle, TNamespaces, TRow, TId> {
  get(id: TId): THandle;

  find<TRaw>(session: OperatorSession<TRaw>, query?, opts?): FindResult<THandle>;
  find<TRaw, F>(session: OperatorSession<TRaw>, query, opts: { fields: F; ... }): FindResult<HandleWithRow<...>>;

  count<TRaw>(session: OperatorSession<TRaw>, query?, opts?): Promise<number>;
}
```

Per Part 19 snapshot/command IO takes `session` as the first argument.
Watch IO (`wait`, blocking stream `read`, workflow `wait`) does not.
`FetchRowOptions`, `FindOptions`, and `CountOptions` carry entity-specific
options only (`fields`, `sort`, `limit`).

### Workflow handle (`WorkflowHandleExternal<W>`)

Single-generic shape parameterised over the workflow header. Wires:

- **`FetchableHandle<WorkflowRow<TArgs, TResult, TMetadata>>`** —
  `fetchRow(session, …)` reads a fresh row snapshot.
- **`WorkflowOperatorActions<TResult>`** (step 09) —
  `sigkill(session)` / `sigterm(session)` / `skip(session, result?, opts?)`.
- **Primitive plane** — `channels` / `streams` / `events` accessors
  (existing shapes; step 16 adds `attributes`).
- **`halts: HaltsNamespaceExternal`** — full `QueryableNamespace` over
  workflow execution halt records. Resolution is patch + replay or
  `skip(...)` on the workflow itself (which transitions the workflow to
  `'skipped'`).
- **Parent-scoped namespaces** —
  `children.attached.<name>` /
  `children.detached.<name>` /
  `compensations.steps.<step>` /
  `compensations.requests.<request>`.
  On full workflow definitions these are key-narrowed from
  `children.attached` / `children.detached`, compensable `steps`, and
  compensable `requests`.
  On header-only `W` (or widened `W` that erases those maps), these
  intentionally fall back to loose `Record<string, ...>` namespaces
  because definition-level maps are not present in the type.
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
- `attempts` — {@link HandlerAttemptsReadNamespace} for row reads (Part 15).
  Not a row column; handler-side materialization only.
- `skip(session, result, opts?)` for non-void result; `skip(session)` for void.
- `id: RequestCompensationInstanceId`.
- No per-instance primitives; no halts (Part 11).

### Request compensation namespace

`extends QueryableNamespace<...>` with the corresponding
`RequestCompensationQueryNamespaces<TPayload, TCompResult>` and
`RequestCompensationRow<TPayload, TCompResult>`.

### Attached child workflow handle
(`AttachedChildWorkflowExternalHandle<W>`)

**Non-lifecycle** operator surface (do not describe as blanket “read-only”):
lifecycle verbs are absent; messaging / introspection may still exist where typed.

- **Present:** `FetchableHandle<WorkflowRow<...>>`, branded `id`,
  declared `channels` / `streams` / `events` / `attributes` (per child
  definition), `fetchRow`.
- **Absent:** `idempotencyKey`, `sigkill`, `sigterm`, `skip` — attached
  rows are parent-coupled; operators do not treat them as independent roots.

### Attached child workflow namespace
(`AttachedChildWorkflowNamespaceExternal<W>`)

`extends QueryableNamespace<...>` — namespaces are the standard
`WorkflowQueryNamespaces<TArgs, TResult, TMetadata>`; `TId` is
`AttachedChildWorkflowId<W>`.

### Detached child workflow namespace
(`DetachedChildWorkflowNamespaceExternal<W>`)

Returns **`WorkflowHandleExternal<W>`** through `find` /
`get` — the **full root** operator handle (including lifecycle actions and
`idempotencyKey`), same family as `client.workflows.<def>`. The parent-scoped
namespace only **filters** to detached children of this parent; it does **not**
reuse the attached-child handle type or “non-lifecycle” wording.

Keys are derived from the parent workflow's declared `children.attached` /
`children.detached` maps when available; otherwise header-only / widened
workflows keep the loose `Record<string, ...>` fallback. Step 18
(idempotency-key factory) and step 17 (scheduled delivery) refine the detached
`.get(args | idempotencyKey)` overloads.

### Client workflow accessor (`WorkflowClientAccessor<W>`)

`extends Omit<QueryableNamespace<...>, "get">` — gains
`find(session, …)` / `count(session, …)` over the workflow query
namespaces, alongside `start(session, …)` / `execute(...)` / `get(idempotencyKey)`.

The omitted `get` is replaced with the identity-based
`get(idempotencyKey: string): WorkflowHandleExternal<W>` overload.
Step 18 will add the `get(args)` overload conditional on
`idempotencyKeyFactory` being declared on the workflow.

`find` excludes attached children automatically at runtime
(filter on `row.attached = TRUE`) — runtime guarantee; the type
surface is unchanged.

### Halts namespace

`HaltsNamespaceExternal` is a full `QueryableNamespace` — same
`get` / `find` / `count` shape as other namespaces. Execution halt
resolution remains patch + replay (automatic on worker restart) or
`skip(...)` on the workflow itself.

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
  `find` / `count` instead of the old `search`.

## Acceptance Contract

The paired file
`src/types-regression-tests/12_introspection.ts` verifies:

1. `FindResult<T>` is `Promise<readonly T[]>`.
2. `FetchableHandle.fetchRow(session)` returns `TRow | undefined`;
   `fetchRow(session, { fields })` returns `Pick<TRow, ProjectedKeys<TRow, F>> | undefined`.
3. `QueryableNamespace.get(id)` returns a synchronous handle (identity
   grounding only — no I/O, no `.row`). Prefetch attaches `.row` on
   `find(session, …)` results when `{ fields }` is supplied.
4. `find(session, query?)` returns `FindResult<Handle>`.
5. `count(session, query?)` returns `Promise<number>`.
6. `WorkflowHandleExternal<W>` exposes
   `sigkill(session)` / `sigterm(session)` / `skip(session, result?, opts?)` from step 09.
7. `WorkflowHandleExternal<W>` exposes `fetchRow`, `wait`,
   `setRetention`, `halts`, plus the four parent-scoped namespaces.
8. The `halts` namespace is a full `QueryableNamespace` — no `skip`.
9. `CompensationBlockUniqueHandleExternal` exposes `skip(session, result)`
   only — no `sigkill` / `sigterm`; the `strategy` option is
   rejected.
10. `RequestCompensationUniqueHandleExternal` exposes `attempts`
    query namespace.
11. `WorkflowClientAccessor<W>` exposes
    `start / execute / get / find / count`.
12. `WorkflowClient` exposes `compensations.requests` and
    `compensations.steps` — global L1 search keyed by definition
    `name`, aggregated across registered workflows.
13. The legacy `search()` method is gone.
14. `FindUniqueResult` is not exported.

## Out of Scope (Deferred)

- Per-instance primitive accessors on compensation block handles —
  the namespace placeholders exist but the full
  `attributes.X.get(session)` / `getNowait(session)` and similar accessors land in
  steps 13/15/16.
- `client.workflows.<def>.get(args)` overload (when
  `idempotencyKeyFactory` is declared) — step 18.
- `idempotencyKey` on workflow start required + factory-derivation
  rules — step 18.
- `ScheduledDeliveryOptions` (`delaySeconds` / `scheduledAt`) on
  start options — step 17.
- The full `attributes.X` accessor surface on workflow handles —
  step 16.
- `ChannelSendResult` and other primitive operator surfaces take
  `session` first — covered piecemeal as steps 13/15/16 land.
