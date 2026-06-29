// Regression test — converged child-workflow API (Move 2).
//
// Section 1 is a SELF-CONTAINED proof of the API *mechanics* (stand-in types),
// relocated from the original spike. It proves the shapes are expressible; it
// migrates to the real project types as Tasks 10–11 land the accessor.
// Section 2 asserts the real Task-9 foundations (idempotencyKeyFactory presence
// via HasIdempotencyFactory) against the actual define* output.
//
// Mechanic A: the unstarted entry is simultaneously
//   (1) awaitable -> attached success/failure union
//   (2) carries .start(delta) -> detached ForeignWorkflowHandle
//   (3) degrades under ScopeHandles<E> to an attached scope handle
//       (awaitable + channels.send, NO .start)
// Mechanic B: HasIdempotencyFactory<W> drives .start() arity
//   (factory => .start();  no factory => .start({ idempotencyKey }))
// Bonus: the same flag drives the .get(args | key) lookup overload.

import type { Assert, IsEqual } from "./type-assertions";
import { defineWorkflow, defineWorkflowHeader } from "../workflow";
import type { HasIdempotencyFactory } from "../types/helpers";
import type {
  ChildWorkflowUnifiedAccessor,
  ForeignWorkflowAccessor,
} from "../types/context/call-builders";
import type {
  KeyedFailure,
  KeyedSuccess,
  ScopeHandles as RealScopeHandles,
} from "../types/context/scope-results";
import type { WorkflowClientAccessor } from "../types/engine";
import { z } from "zod";

// ===========================================================================
// SECTION 1 — mechanics proof (self-contained stand-ins)
// ===========================================================================
declare const FWH: unique symbol;
interface ForeignWorkflowHandle<Ch> {
  readonly idempotencyKey: string;
  readonly channels: ChannelSend<Ch>;
  readonly [FWH]: true;
}

type ChannelSend<Ch> = { readonly [K in keyof Ch]: { send(data: Ch[K]): void } };

type AttachedResult<R, E> =
  | { ok: true; result: R }
  | { ok: false; status: "failed"; error: E };

interface WF<Args, Result, Err, Ch, HasFactory extends boolean> {
  readonly __args: Args;
  readonly __result: Result;
  readonly __err: Err;
  readonly __ch: Ch;
  readonly __factory: HasFactory;
}

interface ChildStartOptionsSpike<Meta = unknown> {
  metadata?: Meta;
  seed?: string;
  retention?: number;
  deadlineSeconds?: number;
}

type StartDelta<HasFactory extends boolean> = HasFactory extends true
  ? []
  : [opts: { idempotencyKey: string }];

interface ChildEntry<R, Err, Ch, HasFactory extends boolean>
  extends PromiseLike<AttachedResult<R, Err>> {
  start(...args: StartDelta<HasFactory>): ForeignWorkflowHandle<Ch>;
  readonly __ch?: Ch;
  readonly __r?: R;
  readonly __err?: Err;
}

type AttachedScopeHandle<R, Err, Ch> = PromiseLike<AttachedResult<R, Err>> & {
  readonly channels: ChannelSend<Ch>;
};

type ScopeHandles<E> = E extends ChildEntry<infer R, infer Err, infer Ch, boolean>
  ? AttachedScopeHandle<R, Err, Ch>
  : E extends object
    ? { [K in keyof E]: ScopeHandles<E[K]> }
    : E;

type ChildAccessor<W> = W extends WF<
  infer A,
  infer R,
  infer Err,
  infer Ch,
  infer HasF
>
  ? (args: A, opts?: ChildStartOptionsSpike) => ChildEntry<R, Err, Ch, HasF>
  : never;

type GetArgs<W> = W extends WF<infer A, unknown, unknown, unknown, infer HasF>
  ? HasF extends true
    ? [args: A]
    : [idempotencyKey: string]
  : never;

interface ForeignAccessor<W> {
  get(
    ...a: GetArgs<W>
  ): ForeignWorkflowHandle<
    W extends WF<unknown, unknown, unknown, infer Ch, boolean> ? Ch : never
  >;
}

type Ch1 = { cancel: { reason: string } };
type WfNoFactory = WF<{ orderId: string }, { ok: boolean }, "Boom", Ch1, false>;
type WfFactory = WF<{ orderId: string }, { ok: boolean }, "Boom", Ch1, true>;

declare const childNoF: ChildAccessor<WfNoFactory>;
declare const childF: ChildAccessor<WfFactory>;
declare function scope<E, R>(
  name: string,
  entries: E,
  cb: (handles: ScopeHandles<E>) => Promise<R>,
): PromiseLike<R>;

async function mechanicsAssertions() {
  const r = await childNoF({ orderId: "o1" });
  if (r.ok) {
    const _ok: boolean = r.result.ok;
    void _ok;
  } else {
    const _s: "failed" = r.status;
    const _e: "Boom" = r.error;
    void _s;
    void _e;
  }

  const h = childNoF({ orderId: "o1" }).start({ idempotencyKey: "k" });
  const _k: string = h.idempotencyKey;
  void _k;
  h.channels.cancel.send({ reason: "x" });

  // @ts-expect-error no factory => idempotencyKey is required
  childNoF({ orderId: "o1" }).start();
  childF({ orderId: "o1" }).start();
  // @ts-expect-error factory => key is not passable
  childF({ orderId: "o1" }).start({ idempotencyKey: "k" });

  childNoF({ orderId: "o1" }, { deadlineSeconds: 60, metadata: {} }).start({
    idempotencyKey: "k",
  });

  await scope("s", { order: childNoF({ orderId: "o1" }) }, async (handles) => {
    handles.order.channels.cancel.send({ reason: "y" });
    const ar = await handles.order;
    // @ts-expect-error scope handle must not expose .start
    handles.order.start({ idempotencyKey: "k" });
    return ar;
  });
}
void mechanicsAssertions;

declare const extNoF: ForeignAccessor<WfNoFactory>;
declare const extF: ForeignAccessor<WfFactory>;
extNoF.get("key");
extF.get({ orderId: "o1" });
// @ts-expect-error no factory => lookup is by key, not args
extNoF.get({ orderId: "o1" });
// @ts-expect-error factory => lookup is by args, not key
extF.get("key");

// ===========================================================================
// SECTION 2 — Task 9 foundations against the REAL types
// HasIdempotencyFactory<W> discriminates on actual define* output.
// ===========================================================================
const headerNoFactory = defineWorkflowHeader({
  name: "no-factory",
  args: z.object({ orderId: z.string() }),
});

const headerWithFactory = defineWorkflowHeader({
  name: "with-factory",
  args: z.object({ orderId: z.string() }),
  idempotencyKeyFactory: (args) => `wf:${args.orderId}`,
});

const wfNoFactory = defineWorkflow({
  name: "wf-no-factory",
  args: z.object({ orderId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

const wfWithFactory = defineWorkflow({
  name: "wf-with-factory",
  args: z.object({ orderId: z.string() }),
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
// SECTION 3 — unified child accessor against the REAL types
// One accessor: bare call => attached entry (awaitable); .start() => detached.
// ===========================================================================
const childWf = defineWorkflow({
  name: "child-wf",
  args: z.object({ orderId: z.string() }),
  result: z.object({ shipped: z.boolean() }),
  channels: { cancel: z.object({ reason: z.string() }) },
  async execute() {
    return { shipped: true };
  },
});

const childWfFactory = defineWorkflow({
  name: "child-wf-factory",
  args: z.object({ orderId: z.string() }),
  idempotencyKeyFactory: (args) => `c:${args.orderId}`,
  result: z.object({ shipped: z.boolean() }),
  channels: { cancel: z.object({ reason: z.string() }) },
  async execute() {
    return { shipped: true };
  },
});

declare const childAcc: ChildWorkflowUnifiedAccessor<typeof childWf>;
declare const childAccF: ChildWorkflowUnifiedAccessor<typeof childWfFactory>;

async function unifiedAccessorAssertions() {
  // attached: await -> success/failure union
  const r = await childAcc({ orderId: "o" });
  if (r.ok) {
    const _shipped: boolean = r.result.shipped;
    void _shipped;
  } else {
    const _s: "failed" = r.status;
    void _s;
  }

  // detached: .start({ idempotencyKey }) -> send-only handle
  const h = childAcc({ orderId: "o" }).start({ idempotencyKey: "k" });
  const _k: string = h.idempotencyKey;
  void _k;
  h.channels.cancel.send({ reason: "x" });

  // @ts-expect-error no factory => idempotencyKey is required on .start()
  childAcc({ orderId: "o" }).start();

  // factory => .start() takes nothing
  childAccF({ orderId: "o" }).start();
  // @ts-expect-error factory => key is not passable
  childAccF({ orderId: "o" }).start({ idempotencyKey: "k" });

  // execution deadline => adds the timeout variant to the awaited union
  const rt = await childAcc({ orderId: "o" }, { deadlineSeconds: 30 });
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
// (client start surface + in-body external lookup), against the REAL types.
// ===========================================================================
declare const clientNoF: WorkflowClientAccessor<typeof wfNoFactory>;
declare const clientF: WorkflowClientAccessor<typeof wfWithFactory>;

async function clientIdentityAssertions() {
  // no factory => idempotencyKey is REQUIRED on start
  await clientNoF.start({ idempotencyKey: "k", args: { orderId: "o" } });
  // @ts-expect-error no factory => idempotencyKey is required
  await clientNoF.start({ args: { orderId: "o" } });

  // factory => idempotencyKey is NOT passable (derived from args)
  await clientF.start({ args: { orderId: "o" } });
  // @ts-expect-error factory => idempotencyKey is not passable
  await clientF.start({ args: { orderId: "o" }, idempotencyKey: "k" });

  // get: no factory => by key; factory => by args
  clientNoF.get("k");
  clientF.get({ orderId: "o" });
  // @ts-expect-error no factory => lookup by key, not args
  clientNoF.get({ orderId: "o" });
  // @ts-expect-error factory => lookup by args, not key
  clientF.get("k");
}
void clientIdentityAssertions;

// in-body external lookup mirrors the same conditional
declare const extReal: ForeignWorkflowAccessor<typeof childWf>;
declare const extRealF: ForeignWorkflowAccessor<typeof childWfFactory>;
extReal.get("k");
extRealF.get({ orderId: "o" });
// @ts-expect-error no factory => external lookup by key, not args
extReal.get({ orderId: "o" });
// @ts-expect-error factory => external lookup by args, not key
extRealF.get("k");

// ===========================================================================
// SECTION 5 — scope semantics: a timed-out child counts as a keyed FAILURE.
// Its execution-deadline `{ ok: false; status: "timeout" }` variant lands in
// the failure bucket (KeyedFailure / SomeEntriesFailed / QuorumNotMet) and is
// excluded from the success bucket — no source change needed, since the
// combinators bucket every `{ ok: false }` member as a failure.
// ===========================================================================
declare const childAccForTimeout: ChildWorkflowUnifiedAccessor<typeof childWf>;
const _timedEntry = childAccForTimeout({ orderId: "o" }, { deadlineSeconds: 30 });
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
