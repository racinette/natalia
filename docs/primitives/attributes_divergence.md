# Attributes — divergence (docs/ ↔ REFACTOR.MD ↔ src/types)

> Parked working note. Goal: decide the canonical API for attributes, then reconcile all three sources. No source is authoritative yet.

## Three-source status
- **docs/attributes.md**: Full surface — `attributes` slot on `defineWorkflow`, `ctx.attributes.<name>.set(value)` (void, buffered) in body, external `handle.attributes.<name>.get({ afterVersion, signal })` / `getNowait()` returning `{ status, value, version }` | `not_set` | `never`. Also a per-block `attributes` slot on step `compensation`. AHEAD of code (except the compensation slot).
- **REFACTOR.MD Part 13 (Attributes)**: Same — `ctx.attributes.progress.set(...)`, external `get`/`getNowait` result unions, `workflow_attributes` table (`workflow_id`,`attribute_name`,`value`,`version`), per-instance NOTIFY long-poll, `never` driven by `wf_ended:<id>`. AHEAD of code.
- **src/types (impl)**: Partial. `AttributeDefinitions` type exists; the only live slot is `StepCompensation.attributes?` (primitives.ts:206) wired through `WorkflowContract`'s `TAttributes` (workflow-contract.ts:38). No body accessor, no workflow-definition slot, no external get/getNowait result types. Compensation handle plane is a placeholder.

## Divergences
| # | Topic | docs/ says | REFACTOR.MD says | src/types has | Direction |
|---|-------|-----------|------------------|---------------|-----------|
| 1 | Workflow-definition slot | `attributes: { progress: z.object({...}) }` on `defineWorkflow` | Implied by `ctx.attributes.<declaredName>` | `WorkflowDefinition` has NO `attributes` slot and NO `TAttributes` generic (only channels/streams/events/patches + steps/requests/queues/children/external) | docs + REFACTOR ahead |
| 2 | Set from body | `ctx.attributes.progress.set(value)` → `void`, buffered, set-only | `ctx.attributes.progress.set({...})` → `void`, buffered, body + compensation contexts | No `attributes` accessor on `BaseContext`/`WorkflowContext`/`CompensationContext`; no `AttributeAccessor` type anywhere in `src/types` | docs + REFACTOR ahead |
| 3 | External read (blocking) | `handle.attributes.progress.get({ afterVersion, signal })` → `{ status:"ok", value, version }` \| `{ status:"never" }` | Same union | Not present. No external attribute accessor; no `afterVersion`; no `get` result type | docs + REFACTOR ahead |
| 4 | External read (non-blocking) | `handle.attributes.progress.getNowait()` → `{ status:"ok", value, version }` \| `{ status:"not_set" }` | Same union | Not present (`getNowait` named only in an `engine.ts` "lands in step 16" comment) | docs + REFACTOR ahead |
| 5 | Compensation-block attributes | `compensation.attributes: { undoProgress: ... }`, set via `ctx.attributes.undoProgress.set(...)` | Per-block primitive, own namespace, reads via `compensations.steps.<s>.findUnique(...).attributes.X.get()` | Slot EXISTS (`StepCompensation.attributes?`, `TAttributes`), exercised in regression test 08; but the body-side `set` accessor and external `.get()` are still placeholders (`CompensationBlockPrimitivePlane.attributes: Record<string, unknown>`) | code partial (slot only) |

## Open API decisions (for later)
- [ ] Add `attributes` slot + `TAttributes` generic to `WorkflowDefinition`/`WorkflowContext` (today it only lives on compensation), or keep attributes compensation-only?
- [ ] Canonical body accessor: `AttributeAccessor.set(value): void` (buffered, set-only) — confirm signature and add to `io-accessors.ts`.
- [ ] Canonical external result unions: `get` → `ok|never`; `getNowait` → `ok|not_set`. Reconcile with the event-style `{ ok, status }` shape used elsewhere in `results.ts` (attributes docs use bare `status`, no `ok`).
- [ ] `afterVersion` long-poll parameter + `version` monotonic counter — confirm and type.
- [ ] Whether external reads are `FindUniqueResult<T>`-wrapped (per compensation handle comment) or use the flat `{ status, value, version }` union (per docs/REFACTOR Part 13).
