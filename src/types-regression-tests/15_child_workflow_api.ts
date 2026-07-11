// Regression test — converged child-workflow / external-workflow API.
//
// All assertions run against the REAL project types:
//   - Section 2: deriveIdentity presence via HasDeriveIdentity.
//   - Section 3: childWorkflows accessor — attached-only awaitable entry
//     (an execution deadline adds a timeout variant; NO `.start`; ScopeHandles
//     degrades it to a scope handle with channels.send but no `.start`).
//   - Section 4: identity — conditional identity on start + `.get(identity)` on
//     the client, and externalWorkflows `.get` (reference) / `.start` (create),
//     both yielding ExternalWorkflowHandle.
//   - Section 5: scope semantics — a timed-out child counts as a keyed failure.

import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";
import { orderIdIdentity, orderIdKeyPrefix } from "./test-identity";
import { defineWorkflow, defineWorkflowHeader } from "../workflow";
import type { HasDeriveIdentity } from "../types/helpers";
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
// SECTION 2 — identity block foundations against the REAL types
// HasDeriveIdentity<W> discriminates on deriveIdentity presence.
// ===========================================================================
const _headerExplicit = defineWorkflowHeader({
  name: "explicit-identity",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.void(),
  identity: {
    schema: z.object({ orderId: z.string() }),
    deriveIdempotencyKey: (id: { orderId: string }) => `wf:${id.orderId}`,
  },
});

const _headerDerived = defineWorkflowHeader({
  name: "derived-identity",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.void(),
  identity: orderIdKeyPrefix("wf"),
});

const _wfExplicit = defineWorkflow({
  name: "wf-explicit-identity",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: {
    schema: z.object({ orderId: z.string() }),
    deriveIdempotencyKey: (id: { orderId: string }) => `wf:${id.orderId}`,
  },
  async execute() {
    return { ok: true };
  },
});

const _wfDerived = defineWorkflow({
  name: "wf-derived-identity",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  identity: orderIdKeyPrefix("wf"),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

type _A1 = Assert<IsEqual<HasDeriveIdentity<typeof _headerExplicit>, false>>;
type _A2 = Assert<IsEqual<HasDeriveIdentity<typeof _headerDerived>, true>>;
type _A3 = Assert<IsEqual<HasDeriveIdentity<typeof _wfExplicit>, false>>;
type _A4 = Assert<IsEqual<HasDeriveIdentity<typeof _wfDerived>, true>>;

// ===========================================================================
// SECTION 3 — childWorkflows accessor against the REAL types
// Attached-only: bare call => awaitable attached entry; NO .start (detached
// starts live on externalWorkflows, Section 4).
// ===========================================================================
const _childWf = defineWorkflow({
  name: "child-wf",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ shipped: z.boolean() }),
  identity: orderIdIdentity,
  channels: { cancel: z.object({ reason: z.string() }) },
  async execute() {
    return { shipped: true };
  },
});

const _childWfDerived = defineWorkflow({
  name: "child-wf-derived",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  identity: orderIdKeyPrefix("c"),
  result: z.object({ shipped: z.boolean() }),
  channels: { cancel: z.object({ reason: z.string() }) },
  async execute() {
    return { shipped: true };
  },
});

declare const childAcc: ChildWorkflowUnifiedAccessor<typeof _childWf>;

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
type ChildEntryReal = ReturnType<ChildWorkflowUnifiedAccessor<typeof _childWf>>;
type ChildScopeHandles = RealScopeHandles<{ order: ChildEntryReal }>;
declare const childHandles: ChildScopeHandles;
async function scopeDegradeAssertions() {
  childHandles.order.channels.cancel.send({ reason: "x" });
  await childHandles.order;
  // @ts-expect-error scope handle drops .start
  childHandles.order.start({ identity: { orderId: "k" } });
}
void scopeDegradeAssertions;

// ===========================================================================
// SECTION 4 — identity: conditional identity on start + .get(identity)
// (client start surface + in-body externalWorkflows lookup), against the REAL types.
// ===========================================================================
declare const clientExplicit: WorkflowClientAccessor<typeof _wfExplicit>;
declare const clientDerived: WorkflowClientAccessor<typeof _wfDerived>;

async function clientIdentityAssertions() {
  // no deriveIdentity => identity is REQUIRED on start
  await clientExplicit.start(session, {
    metadata: undefined,
    identity: { orderId: "o" },
    args: { orderId: "o" },
  });
  // @ts-expect-error no deriveIdentity => identity is required
  await clientExplicit.start(session, { metadata: undefined, args: { orderId: "o" } });

  // deriveIdentity => args + metadata only; idempotencyKey forbidden
  await clientDerived.start(session, { metadata: undefined, args: { orderId: "o" } });
  await clientDerived.start(session, {
    metadata: undefined,
    args: { orderId: "o" },
    // @ts-expect-error idempotencyKey is not a start option
    idempotencyKey: "override-key",
  });

  // get: always by identity schema output
  clientExplicit.get({ orderId: "o" });
  clientDerived.get({ orderId: "o" });
  // @ts-expect-error lookup is by identity, not idempotency key string
  clientExplicit.get("k");
  // @ts-expect-error lookup is by identity, not idempotency key string
  clientDerived.get("k");
}
void clientIdentityAssertions;

// in-body externalWorkflows lookup mirrors the same identity model
declare const extReal: ExternalWorkflowAccessor<typeof _childWf>;
declare const extRealDerived: ExternalWorkflowAccessor<typeof _childWfDerived>;
extReal.get({ orderId: "o" });
extRealDerived.get({ orderId: "o" });
// @ts-expect-error external get is by identity, not string key
extReal.get("k");
// @ts-expect-error external get is by identity, not string key
extRealDerived.get("k");

// externalWorkflows.start creates an independent root
const started = extReal.start({ orderId: "o" }, { metadata: undefined });
const _startedKey: string = started.idempotencyKey;
void _startedKey;
started.channels.cancel.send({ reason: "x" });

const _childWfExplicit = defineWorkflow({
  name: "child-wf-explicit",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ shipped: z.boolean() }),
  identity: {
    schema: z.object({ orderId: z.string() }),
    deriveIdempotencyKey: (id: { orderId: string }) => `c-explicit:${id.orderId}`,
  },
  channels: { cancel: z.object({ reason: z.string() }) },
  async execute() {
    return { shipped: true };
  },
});

declare const extExplicit: ExternalWorkflowAccessor<typeof _childWfExplicit>;
const startedExplicit = extExplicit.start(
  { orderId: "o" },
  { metadata: undefined, identity: { orderId: "o" } },
);
void startedExplicit;
// @ts-expect-error explicit identity required when no deriveIdentity
extExplicit.start({ orderId: "o" }, { metadata: undefined });

// deriveIdentity => metadata only in options
extRealDerived.start({ orderId: "o" }, { metadata: undefined });
extRealDerived.start(
  { orderId: "o" },
  {
    metadata: undefined,
    // @ts-expect-error idempotencyKey forbidden on external start
    idempotencyKey: "override-key",
  },
);

// ===========================================================================
// SECTION 5 — scope semantics: a timed-out child counts as a keyed FAILURE.
// Its execution-deadline `{ ok: false; status: "timeout" }` variant lands in
// the failure bucket (KeyedFailure / SomeEntriesFailed / QuorumNotMet) and is
// excluded from the success bucket — no source change needed, since the
// combinators bucket every `{ ok: false }` member as a failure.
// ===========================================================================
declare const childAccForTimeout: ChildWorkflowUnifiedAccessor<typeof _childWf>;
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

type TimedSuccesses = KeyedSuccess<{ x: TimedEntry }>;
type TimedSuccessResult = TimedSuccesses extends { result: infer R } ? R : never;

// ...and excluded from the success bucket.
type _TimeoutNotSuccess = Assert<
  Extract<TimedSuccessResult, { status: "timeout" }> extends never ? true : false
>;
