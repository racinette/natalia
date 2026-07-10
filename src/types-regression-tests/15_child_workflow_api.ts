// Regression test — converged child-workflow / external-workflow API.
//
// All assertions run against the REAL project types:
//   - Section 2: idempotencyKeyFactory presence via HasIdempotencyFactory.
//   - Section 3: childWorkflows accessor — attached-only awaitable entry
//     (an execution deadline adds a timeout variant; NO `.start`; ScopeHandles
//     degrades it to a scope handle with channels.send but no `.start`).
//   - Section 4: identity — conditional idempotencyKey + `.get(args | key)` on
//     the client, and externalWorkflows `.get` (reference) / `.start` (create),
//     both yielding ExternalWorkflowHandle.
//   - Section 5: scope semantics — a timed-out child counts as a keyed failure.

import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";
import { defineWorkflow, defineWorkflowHeader } from "../workflow";
import type { HasIdempotencyFactory } from "../types/helpers";
import type {
  ChildWorkflowUnifiedAccessor,
  ExternalWorkflowAccessor,
} from "../types/context/call-builders";
import type {
  KeyedFailure,
  KeyedSuccess,
  ScopeHandles as RealScopeHandles,
} from "../types/context/scope-results";
import type { WorkflowClientAccessor } from "../types/engine";
import { z } from "zod";

// ===========================================================================
// SECTION 2 — Task 9 foundations against the REAL types
// HasIdempotencyFactory<W> discriminates on actual define* output.
// ===========================================================================
const headerNoFactory = defineWorkflowHeader({
  name: "no-factory",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.void(),
});

const headerWithFactory = defineWorkflowHeader({
  name: "with-factory",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.void(),
  idempotencyKeyFactory: (args) => `wf:${args.orderId}`,
});

const wfNoFactory = defineWorkflow({
  name: "wf-no-factory",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

const wfWithFactory = defineWorkflow({
  name: "wf-with-factory",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  idempotencyKeyFactory: (args) => `wf:${args.orderId}`,
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

// the factory callback receives decoded args
const _factoryArgs = headerWithFactory.idempotencyKeyFactory;
void _factoryArgs;

type _A1 = Assert<IsEqual<HasIdempotencyFactory<typeof headerNoFactory>, false>>;
type _A2 = Assert<IsEqual<HasIdempotencyFactory<typeof headerWithFactory>, true>>;
type _A3 = Assert<IsEqual<HasIdempotencyFactory<typeof wfNoFactory>, false>>;
type _A4 = Assert<IsEqual<HasIdempotencyFactory<typeof wfWithFactory>, true>>;

// ===========================================================================
// SECTION 3 — childWorkflows accessor against the REAL types
// Attached-only: bare call => awaitable attached entry; NO .start (detached
// starts live on externalWorkflows, Section 4).
// ===========================================================================
const childWf = defineWorkflow({
  name: "child-wf",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ shipped: z.boolean() }),
  channels: { cancel: z.object({ reason: z.string() }) },
  async execute() {
    return { shipped: true };
  },
});

const childWfFactory = defineWorkflow({
  name: "child-wf-factory",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  idempotencyKeyFactory: (args) => `c:${args.orderId}`,
  result: z.object({ shipped: z.boolean() }),
  channels: { cancel: z.object({ reason: z.string() }) },
  async execute() {
    return { shipped: true };
  },
});

declare const childAcc: ChildWorkflowUnifiedAccessor<typeof childWf>;

async function unifiedAccessorAssertions() {
  // attached: await -> success/failure union
  const r = await childAcc({ orderId: "o" }, { metadata: undefined });
  if (r.ok) {
    const _shipped: boolean = r.result.shipped;
    void _shipped;
  } else {
    const _s: "failed" = r.status;
    void _s;
  }

  // childWorkflows are attached-only — no `.start()` (detached starts live on
  // externalWorkflows; see Section 4).
  // @ts-expect-error childWorkflows accessor entry has no `.start`
  void childAcc({ orderId: "o" }).start;

  // execution deadline => adds the timeout variant to the awaited union
  const rt = await childAcc({ orderId: "o" }, { metadata: undefined, deadlineSeconds: 30 });
  if (!rt.ok && rt.status === "timeout") {
    void rt;
  }

  // @ts-expect-error `retry` is no longer a child-call option
  childAcc({ orderId: "o" }, { retry: { intervalSeconds: 1 } });
}
void unifiedAccessorAssertions;

// ScopeHandles degrades the entry: channels.send present, .start absent.
type ChildEntryReal = ReturnType<ChildWorkflowUnifiedAccessor<typeof childWf>>;
type ChildScopeHandles = RealScopeHandles<{ order: ChildEntryReal }>;
declare const childHandles: ChildScopeHandles;
async function scopeDegradeAssertions() {
  childHandles.order.channels.cancel.send({ reason: "x" });
  await childHandles.order;
  // @ts-expect-error scope handle drops .start
  childHandles.order.start({ idempotencyKey: "k" });
}
void scopeDegradeAssertions;

// ===========================================================================
// SECTION 4 — identity: conditional idempotencyKey + .get(args | key)
// (client start surface + in-body externalWorkflows lookup), against the REAL types.
// ===========================================================================
declare const clientNoF: WorkflowClientAccessor<typeof wfNoFactory>;
declare const clientF: WorkflowClientAccessor<typeof wfWithFactory>;

async function clientIdentityAssertions() {
  // no factory => idempotencyKey is REQUIRED on start
  await clientNoF.start(session, { metadata: undefined, idempotencyKey: "k", args: { orderId: "o" } });
  // @ts-expect-error no factory => idempotencyKey is required
  await clientNoF.start(session, { metadata: undefined, args: { orderId: "o" } });

  // factory => idempotencyKey is NOT passable (derived from args)
  await clientF.start(session, { metadata: undefined, args: { orderId: "o" } });
  // @ts-expect-error factory => idempotencyKey is not passable
  await clientF.start(session, { metadata: undefined, args: { orderId: "o" }, idempotencyKey: "k" });

  // get: no factory => by key; factory => by args
  clientNoF.get("k");
  clientF.get({ orderId: "o" });
  // @ts-expect-error no factory => lookup by key, not args
  clientNoF.get({ orderId: "o" });
  // @ts-expect-error factory => lookup by args, not key
  clientF.get("k");
}
void clientIdentityAssertions;

// in-body externalWorkflows lookup mirrors the same conditional
declare const extReal: ExternalWorkflowAccessor<typeof childWf>;
declare const extRealF: ExternalWorkflowAccessor<typeof childWfFactory>;
extReal.get("k");
extRealF.get({ orderId: "o" });
// @ts-expect-error no factory => externalWorkflows lookup by key, not args
extReal.get({ orderId: "o" });
// @ts-expect-error factory => externalWorkflows lookup by args, not key
extRealF.get("k");

// externalWorkflows.start creates an independent root; identity is conditional
const started = extReal.start({ orderId: "o" }, { metadata: undefined, idempotencyKey: "k" });
const _startedKey: string = started.idempotencyKey;
void _startedKey;
started.channels.cancel.send({ reason: "x" });
// @ts-expect-error no factory => idempotencyKey required on start
extReal.start({ orderId: "o" }, { metadata: undefined,});
// factory => key derived from args, not passable
extRealF.start({ orderId: "o" }, { metadata: undefined,});
// @ts-expect-error factory => idempotencyKey not passable on start
extRealF.start({ orderId: "o" }, { metadata: undefined, idempotencyKey: "k" });

// ===========================================================================
// SECTION 5 — scope semantics: a timed-out child counts as a keyed FAILURE.
// Its execution-deadline `{ ok: false; status: "timeout" }` variant lands in
// the failure bucket (KeyedFailure / SomeEntriesFailed / QuorumNotMet) and is
// excluded from the success bucket — no source change needed, since the
// combinators bucket every `{ ok: false }` member as a failure.
// ===========================================================================
declare const childAccForTimeout: ChildWorkflowUnifiedAccessor<typeof childWf>;
const _timedEntry = childAccForTimeout({ orderId: "o" }, { metadata: undefined, deadlineSeconds: 30 });
void _timedEntry;
type TimedEntry = typeof _timedEntry;

type TimedFailures = KeyedFailure<{ x: TimedEntry }>;
type TimedFailureError = TimedFailures extends { error: infer Err } ? Err : never;

// the execution-deadline timeout is present in the failure bucket...
type _TimeoutIsFailure = Assert<
  Extract<TimedFailureError, { status: "timeout" }> extends never ? false : true
>;
// ...alongside the ordinary structural failure...
type _FailedIsFailure = Assert<
  Extract<TimedFailureError, { status: "failed" }> extends never ? false : true
>;
// ...and the success bucket is just the result (no timeout leakage).
type _SuccessIsResult = Assert<
  IsEqual<
    KeyedSuccess<{ x: TimedEntry }>,
    { key: "x"; value: { shipped: boolean } }
  >
>;

// fixtures referenced only via `typeof` above — mark as used for no-unused-vars
void [headerNoFactory, wfNoFactory, wfWithFactory, childWf, childWfFactory];

export {};
