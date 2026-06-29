import { z } from "zod";
/**
 * Regression coverage for workflow/step interfaces, `.implement`, structural
 * assignability, `extend`, and execution surfaces (`execute` and `ctx.scope`
 * callbacks) typed from `defineWorkflowInterface().implement(...)`.
 *
 * Touches workflow primitives that flow into `WorkflowContext`,
 * `WorkflowConcurrencyContext`, and `CompensationContext`: channels, streams,
 * events, patches, rng, errors, steps, requests, childWorkflows (attached + detached),
 * externalWorkflows accessors, sleep/sleepUntil, schedule, scope helpers, join, listen,
 * and match.
 *
 * **Transforms:** Zod `.transform` splits Standard Schema **input** vs **output**
 * types; we assert `execute` / steps use **decoded args** (`InferOutput` of args
 * schemas) and workflow **returns** the **encoding** shape (`InferInput` of the
 * result schema).
 */
import {
  defineRequest,
  defineStep,
  defineStepInterface,
  defineWorkflow,
  defineWorkflowHeader,
  defineWorkflowInterface,
} from "../workflow";
import { createWorkflowClient } from "../client";
import type { StandardSchemaV1 } from "../types/standard-schema";
import type {
  AttachedChildWorkflowEntry,
  AttachedChildWorkflowExternalHandle,
  AttachedChildWorkflowResult,
  ChannelReceiveCall,
  ErrorValue,
  FirstResult,
  ExternalWorkflowHandle,
  InferWorkflowChannels,
  InferWorkflowErrors,
  IsHeaderAuthoringKind,
  JoinResult,
  KeyedSuccess,
  Listener,
  MatchEvents,
  NoEntryCompleted,
  QuorumNotMet,
  ScheduleHandle,
  ScopeSuccessResults,
  SomeEntriesFailed,
  StepEntry,
  StepInterface,
  WorkflowInterface,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";

/** Structural assignability: `U` must be assignable to `T`. */
type AssertAssignable<T, U extends T> = U;

// =============================================================================
// Shared headers / childWorkflows / externalWorkflows targets (graph primitives)
// =============================================================================

const ctx13ChildHeader = defineWorkflowHeader({
  name: "ctx13ChildA",
  args: z.object({ seed: z.number() }),
  result: z.string(),
  channels: { childPing: z.boolean() },
  errors: { ChildErr: true },
});

const ctx13ChildWorkflow = defineWorkflow({
  ...ctx13ChildHeader,
  async execute(_ctx, _args) {
    return "child-result";
  },
});

const ctx13DetachedHeader = defineWorkflowHeader({
  name: "ctx13Detached",
  args: z.object({ flag: z.boolean() }),
  result: z.void(),
  channels: { detachCh: z.string() },
});

const ctx13DetachedWorkflow = defineWorkflow({
  ...ctx13DetachedHeader,
  async execute() {
    return undefined;
  },
});

const ctx13ExtHeader = defineWorkflowHeader({
  name: "ctx13ExtPartner",
  args: z.object({ token: z.string() }),
  result: z.number(),
  channels: { extOut: z.object({ n: z.number() }) },
});

const ctx13ExtWorkflow = defineWorkflow({
  ...ctx13ExtHeader,
  async execute() {
    return 0;
  },
});

const ctx13InnerStep = defineStep({
  name: "ctx13Inner",
  args: z.object({ k: z.string() }),
  result: z.void(),
  async execute() {
    return undefined;
  },
});

const ctx13PlainStepIface = defineStepInterface({
  name: "ctx13Plain",
  args: z.object({ factor: z.number() }),
  result: z.object({ ok: z.boolean() }),
});

const ctx13PlainStep = ctx13PlainStepIface.implement({
  async execute() {
    return { ok: true };
  },
});

const ctx13CompStepIface = defineStepInterface({
  name: "ctx13WithComp",
  args: z.object({ token: z.string() }),
  result: z.object({ paid: z.boolean() }),
  compensation: {
    channels: { cUndo: z.number() },
    streams: { sUndo: z.object({ row: z.string() }) },
    events: { eUndo: true },
    steps: { ctx13InnerStep },
  },
});

const ctx13CompStep = ctx13CompStepIface.implement({
  async execute() {
    return { paid: true };
  },
  compensation: {
    channels: { cUndo: z.number() },
    streams: { sUndo: z.object({ row: z.string() }) },
    events: { eUndo: true },
    steps: { ctx13InnerStep },
    externalWorkflows: { partner: ctx13ExtHeader },
    async undo() {
      return undefined;
    },
  },
});

const ctx13RpcRequest = defineRequest({
  name: "ctx13Rpc",
  payload: z.object({ v: z.number() }),
  response: z.object({ out: z.string() }),
  compensation: { result: z.object({ reversed: z.boolean() }) },
});

// =============================================================================
// Full declarative surface → implement → execution context (execute / scope)
// =============================================================================

const ctx13MainHeader = defineWorkflowHeader({
  name: "ctx13FullSurface",
  args: z.object({ wid: z.string() }),
  result: z.number(),
  metadata: z.object({ region: z.string() }),
  channels: {
    cIn: z.object({ a: z.number() }),
    cAux: z.string(),
  },
  errors: {
    ErrA: true,
    ErrB: z.object({ code: z.number() }),
  },
});

const ctx13FullInterface = ctx13MainHeader.extend({
  streams: {
    slog: z.object({ line: z.string() }),
    slog2: z.object({ n: z.number() }),
  },
  events: { evReady: true, evDone: true },
  patches: { patchAlpha: true, patchBeta: false },
  rng: {
    rngSimple: true,
    rngKeyed: (...args: unknown[]) => `b:${String(args[0])}`,
  },
  retention: 86400,
  evictAfterSeconds: 7200,
  steps: {
    plain: ctx13PlainStepIface,
    withComp: ctx13CompStepIface,
  },
  requests: {
    rpc: {
      name: "ctx13Rpc",
      payload: z.object({ v: z.number() }),
      response: z.object({ out: z.string() }),
      compensation: { result: z.object({ reversed: z.boolean() }) },
    },
  },
  childWorkflows: { childA: ctx13ChildWorkflow, childD: ctx13DetachedWorkflow },
});

void defineWorkflowInterface({
  ...ctx13MainHeader,
  steps: { plain: ctx13PlainStepIface },
  // @ts-expect-error — `externalWorkflows` is not on `WorkflowInterface`; pass it to `.implement({ externalWorkflows })` only
  externalWorkflows: { partner: ctx13ExtWorkflow },
});

const ctx13FullWorkflow = ctx13FullInterface.implement({
  externalWorkflows: { partner: ctx13ExtWorkflow },
  steps: {
    plain: ctx13PlainStep,
    withComp: ctx13CompStep,
  },
  requests: { rpc: ctx13RpcRequest },
  async execute(ctx, args) {
    type _Args = Assert<IsEqual<typeof args, { wid: string }>>;

    void ctx.workflowId;
    void ctx.timestamp;
    void ctx.date;
    void ctx.logger;

    void ctx.channels.cIn.receive;
    void ctx.channels.cAux.receive;
    void ctx.streams.slog.write;
    void ctx.streams.slog2.write;
    void ctx.events.evReady.set;
    void ctx.events.evDone.set;

    void ctx.patches.patchAlpha;
    void ctx.patches.patchBeta;

    void ctx.rng.rngSimple.uuidv4;
    void ctx.rng.rngKeyed("z").int;

    void ctx.errors.ErrA("x");
    void ctx.errors.ErrB("y", { code: 2 });

    void ctx.steps.plain;
    void ctx.steps.withComp;

    type _PlainCall = Parameters<(typeof ctx)["steps"]["plain"]>[0];
    type _PlainCallOk = Assert<
      _PlainCall extends { factor: number } ? true : false
    >;

    const _plainEntry = ctx.steps.plain({
      factor: 2,
    });
    type _PlainEntry = Assert<
      IsEqual<typeof _plainEntry, StepEntry<{ ok: boolean }>>
    >;
    void _plainEntry;

    void ctx.requests.rpc;

    void ctx.childWorkflows.childA;
    void ctx.childWorkflows.childD;

    const _extPartner = ctx.externalWorkflows.partner.get("idem-1");
    type _ExtPartner = Assert<
      IsEqual<
        typeof _extPartner,
        ExternalWorkflowHandle<InferWorkflowChannels<typeof ctx13ExtWorkflow>>
      >
    >;
    void _extPartner.channels.extOut.send({ n: 1 });

    const _sleep1 = ctx.sleep(1);
    type _Sleep1 = Assert<typeof _sleep1 extends PromiseLike<void> ? true : false>;
    const _sleepUntil1 = ctx.sleepUntil(Date.now());
    type _SleepUntil1 = Assert<
      typeof _sleepUntil1 extends PromiseLike<void> ? true : false
    >;

    const _sched13 = ctx.schedule("*/5 * * * *");
    type _Sched13 = Assert<IsEqual<typeof _sched13, ScheduleHandle>>;

    const _listen13 = ctx.listen({ a: ctx.channels.cIn });
    type _Listen13 = Assert<
      IsEqual<typeof _listen13, Listener<{ a: typeof ctx.channels.cIn }>>
    >;
    void _listen13;

    const _scope13Out = await ctx.scope(
      "scope13",
      { pe: ctx.steps.plain({ factor: args.wid.length }) },
      async (sctx, handles) => {
        void sctx.channels.cIn;
        void sctx.streams.slog.write;
        void sctx.events.evReady.set;
        void sctx.patches.patchAlpha;
        void sctx.rng.rngSimple;
        void sctx.errors.ErrA("scope");
        void sctx.steps.plain;
        void sctx.requests.rpc;
        void sctx.childWorkflows.childA;
        void sctx.childWorkflows.childD;
        void sctx.externalWorkflows.partner;
        const _joinPe = await sctx.join(handles.pe);
        type _JoinPe = Assert<
          IsEqual<typeof _joinPe, JoinResult<(typeof handles)["pe"]>>
        >;
        void _joinPe;
        // @ts-expect-error — scope context omits `schedule` vs root `WorkflowContext`
        void sctx.schedule;
        return 0;
      },
    );
    type _Scope13Out = Assert<IsEqual<typeof _scope13Out, number>>;

    type _Orchestrate13Entries = { pe: StepEntry<{ ok: boolean }> };

    const _all13 = await ctx.all("all13", { pe: ctx.steps.plain({ factor: 3 }) });
    type _All13 = Assert<
      IsEqual<
        typeof _all13,
        | { ok: true; result: ScopeSuccessResults<_Orchestrate13Entries> }
        | { ok: false; error: SomeEntriesFailed<_Orchestrate13Entries> }
      >
    >;
    void _all13;

    const _first13 = await ctx.first("first13", {
      pe: ctx.steps.plain({ factor: 4 }),
    });
    type _First13 = Assert<
      IsEqual<
        typeof _first13,
        | { ok: true; result: FirstResult<_Orchestrate13Entries> }
        | { ok: false; error: NoEntryCompleted<_Orchestrate13Entries> }
      >
    >;
    void _first13;

    const _al13 = await ctx.atLeast("al13", 1, {
      pe: ctx.steps.plain({ factor: 5 }),
    });
    type _Al13 = Assert<
      IsEqual<
        typeof _al13,
        | { ok: true; result: KeyedSuccess<_Orchestrate13Entries>[] }
        | { ok: false; error: QuorumNotMet<_Orchestrate13Entries> }
      >
    >;
    void _al13;

    const _am13 = await ctx.atMost("am13", 2, {
      pe: ctx.steps.plain({ factor: 6 }),
    });
    type _Am13 = Assert<
      IsEqual<typeof _am13, KeyedSuccess<_Orchestrate13Entries>[]>
    >;
    void _am13;

    const _sm13 = await ctx.some("sm13", { pe: ctx.steps.plain({ factor: 7 }) });
    type _Sm13 = Assert<
      IsEqual<typeof _sm13, KeyedSuccess<_Orchestrate13Entries>[]>
    >;
    void _sm13;

    for await (const _ev of ctx.match({ pe: ctx.steps.plain({ factor: 8 }) })) {
      type _MatchEv = Assert<
        IsEqual<typeof _ev, MatchEvents<_Orchestrate13Entries>>
      >;
      void _ev;
      break;
    }

    const _childAEntry = ctx.childWorkflows.childA({
      seed: 1,
    });
    type _ChildAResult = AttachedChildWorkflowResult<
      string,
      ErrorValue<InferWorkflowErrors<typeof ctx13ChildWorkflow>>
    >;
    // The unified accessor returns an UnstartedChildWorkflowEntry, which
    // extends AttachedChildWorkflowEntry (adding `.start()` for detached). The
    // attached awaited shape is unchanged. (`.start()` is covered in step 15.)
    type _ChildAEntry = Assert<
      typeof _childAEntry extends AttachedChildWorkflowEntry<
        typeof ctx13ChildWorkflow,
        _ChildAResult
      >
        ? true
        : false
    >;
    void _childAEntry;
    type _RpcPayload = Parameters<(typeof ctx)["requests"]["rpc"]>[0];
    type _RpcPayloadOk = Assert<
      _RpcPayload extends { v: number } ? true : false
    >;

    // @ts-expect-error — request payload `v` must be a number
    void ctx.requests.rpc({ v: "not-a-number" });

    // @ts-expect-error — step args `factor` must be a number
    void ctx.steps.plain({ factor: "not-a-number" });

    return args.wid.length;
  },
});

void ctx13FullWorkflow;

// =============================================================================
// Execution context negatives (narrow declaration → forbidden access)
// =============================================================================

const ctx13NarrowIface = defineWorkflowInterface({
  name: "ctx13Narrow",
  args: z.object({ only: z.string() }),
  result: z.void(),
  channels: { sole: z.number() },
});

const ctx13NarrowWf = ctx13NarrowIface.implement({
  async execute(ctx) {
    const soleRecv = ctx.channels.sole.receive();
    type _SoleRecv = Assert<
      IsEqual<typeof soleRecv, ChannelReceiveCall<number>>
    >;
    void soleRecv;
    // @ts-expect-error — channel not declared on this workflow
    void ctx.channels.missing;
    return undefined;
  },
});

void ctx13NarrowWf;

// =============================================================================
// implement() negatives (keys / shapes)
// =============================================================================

const ctx13IfaceTwoSteps = defineWorkflowInterface({
  name: "ctx13TwoSteps",
  args: z.void(),
  result: z.void(),
  steps: {
    a: ctx13PlainStepIface,
    b: ctx13PlainStepIface,
  },
});

ctx13IfaceTwoSteps.implement({
  // @ts-expect-error — missing required step key `b` for this interface
  steps: { a: ctx13PlainStep },
  async execute() {
    return undefined;
  },
});

const ctx13BadStep = defineStep({
  name: "ctx13BadStepName",
  args: z.object({ factor: z.number() }),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: false };
  },
});

void ctx13FullInterface.implement({
  requests: { rpc: ctx13RpcRequest },
  // @ts-expect-error — wrong step definition for `plain` slot (name mismatch vs interface)
  steps: { plain: ctx13BadStep, withComp: ctx13CompStep },
  async execute() {
    return 0;
  },
});

// =============================================================================
// Authoring chain — named step implement (reuse story)
// =============================================================================

const orderHeader = defineWorkflowHeader({
  name: "ifaceOrder",
  args: z.object({ sku: z.string() }),
  result: z.object({ id: z.string() }),
  channels: { notice: z.string() },
});

const chargeStepInterface = defineStepInterface({
  name: "ifaceCharge",
  args: z.object({ amount: z.number() }),
  result: z.object({ chargeId: z.string() }),
});

const chargeStep = chargeStepInterface.implement({
  async execute() {
    return { chargeId: "c1" };
  },
});

const orderInterface = orderHeader.extend({
  streams: { audit: z.object({ line: z.string() }) },
  events: { paid: true },
  steps: { charge: chargeStepInterface },
  childWorkflows: {},
});

// @ts-expect-error — header-locked keys cannot be passed to `.extend()`
void orderHeader.extend({ name: "badName" });

const orderWorkflow = orderInterface.implement({
  steps: { charge: chargeStep },
  async execute(ctx, _args) {
    type _Sku = Assert<IsEqual<(typeof _args)["sku"], string>>;
    void ctx.streams.audit.write;
    return { id: "o1" };
  },
});

void orderWorkflow;

type _OrderName = Assert<IsEqual<(typeof orderWorkflow)["name"], "ifaceOrder">>;

// =============================================================================
// Structural triple — header, plain interface object, implementation (no `.implement` bridge)
// =============================================================================

const tripleHeader = defineWorkflowHeader({
  name: "tripleWf",
  args: z.object({ q: z.string() }),
  result: z.number(),
  channels: { ctl: z.boolean() },
  errors: { TripleErr: true },
});

const tripleStepIface = defineStepInterface({
  name: "tripleStep",
  args: z.object({ n: z.number() }),
  result: z.void(),
});

type TripleWorkIface = StepInterface<
  "tripleStep",
  (typeof tripleStepIface)["args"],
  (typeof tripleStepIface)["result"]
>;

type TripleContract = WorkflowInterface<
  "tripleWf",
  { ctl: z.ZodBoolean },
  { log: z.ZodObject<{ line: z.ZodString }> },
  { done: true },
  { work: TripleWorkIface },
  Record<string, never>,
  Record<string, never>,
  { childSlot: typeof tripleHeader },
  z.ZodNumber,
  z.ZodObject<{ q: z.ZodString }>,
  StandardSchemaV1<void, void>,
  { TripleErr: true },
  Record<string, never>,
  Record<string, never>
>;

type TripleContractSurface = Pick<
  TripleContract,
  | "name"
  | "channels"
  | "args"
  | "result"
  | "errors"
  | "streams"
  | "events"
  | "steps"
  | "childWorkflows"
>;

const tripleInterfaceOnly: TripleContract = {
  name: "tripleWf",
  channels: { ctl: z.boolean() },
  args: z.object({ q: z.string() }),
  result: z.number(),
  errors: { TripleErr: true },
  streams: { log: z.object({ line: z.string() }) },
  events: { done: true },
  steps: {
    work: {
      name: "tripleStep",
      args: z.object({ n: z.number() }),
      result: z.void(),
    },
  },
  childWorkflows: { childSlot: tripleHeader },
};

const tripleStep = tripleStepIface.implement({
  async execute() {
    return undefined;
  },
});

const triplePublicFromHeader = tripleHeader.extend({
  streams: tripleInterfaceOnly.streams,
  events: tripleInterfaceOnly.events,
  steps: { work: tripleStepIface },
  childWorkflows: tripleInterfaceOnly.childWorkflows,
});

const tripleImplementation = triplePublicFromHeader.implement({
  steps: { work: tripleStep },
  externalWorkflows: { ext: tripleHeader },
  async execute() {
    return 1;
  },
});

const _structuralOk: AssertAssignable<
  TripleContractSurface,
  typeof tripleImplementation
> = tripleImplementation;

// @ts-expect-error — wrong stream payload schema vs `triplePublicFromHeader`
const _badStreamFromHeader: typeof triplePublicFromHeader = tripleHeader.extend({
  streams: { log: z.object({ line: z.number() }) },
  events: tripleInterfaceOnly.events,
  steps: { work: tripleStepIface },
  childWorkflows: tripleInterfaceOnly.childWorkflows,
});
void _badStreamFromHeader;

type TripleExternalSlot = Pick<typeof tripleImplementation, "externalWorkflows">;
// @ts-expect-error — wrong `externalWorkflows` key vs `TripleExternalSlot`
const _wrongExternalSlot: TripleExternalSlot = { extx: tripleHeader };

// =============================================================================
// Standard Schema input/output (Zod `.transform` on args / result / steps)
// =============================================================================

const transformWorkflowArgs = z
  .object({ wire: z.string() })
  .transform((o) => ({ decoded: o.wire, len: o.wire.length }));

const transformWorkflowResult = z
  .object({ score: z.number() })
  .transform((o) => ({ doubled: o.score * 2 }));

type _StdArgsOut = Assert<
  IsEqual<
    StandardSchemaV1.InferOutput<typeof transformWorkflowArgs>,
    { decoded: string; len: number }
  >
>;
type _StdArgsIn = Assert<
  IsEqual<
    StandardSchemaV1.InferInput<typeof transformWorkflowArgs>,
    { wire: string }
  >
>;
type _StdResultOut = Assert<
  IsEqual<
    StandardSchemaV1.InferOutput<typeof transformWorkflowResult>,
    { doubled: number }
  >
>;
type _StdResultIn = Assert<
  IsEqual<
    StandardSchemaV1.InferInput<typeof transformWorkflowResult>,
    { score: number }
  >
>;

type TransformWorkflowContract = WorkflowInterface<
  "tfWf",
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  typeof transformWorkflowResult,
  typeof transformWorkflowArgs,
  StandardSchemaV1<void, void>,
  Record<string, never>,
  Record<string, never>,
  Record<string, never>
>;

type TransformWorkflowContractSurface = Pick<
  TransformWorkflowContract,
  "name" | "args" | "result"
>;

const transformWorkflowHeader = defineWorkflowHeader({
  name: "tfWf",
  args: transformWorkflowArgs,
  result: transformWorkflowResult,
});

const transformWorkflowInterface = transformWorkflowHeader.extend({});

const transformWorkflowFromInterface = transformWorkflowInterface.implement({
  async execute(_ctx, args) {
    type _ExArgs = Assert<
      IsEqual<
        typeof args,
        StandardSchemaV1.InferOutput<typeof transformWorkflowArgs>
      >
    >;
    type _ExArgsShape = Assert<
      IsEqual<typeof args, { decoded: string; len: number }>
    >;
    // @ts-expect-error — execute receives **decoded** args (`InferOutput`), not wire input
    void args.wire;
    return { score: args.len };
  },
});

void transformWorkflowFromInterface;

const transformWorkflowDirect = defineWorkflow({
  ...transformWorkflowHeader,
  async execute(_ctx, args) {
    type _DirectArgs = Assert<
      IsEqual<typeof args, { decoded: string; len: number }>
    >;
    return { score: args.len };
  },
});

const _transformStructuralOk: AssertAssignable<
  TransformWorkflowContractSurface,
  typeof transformWorkflowDirect
> = transformWorkflowDirect;

const transformManualDecl: TransformWorkflowContract = {
  name: "tfWf",
  args: transformWorkflowArgs,
  result: transformWorkflowResult,
};

const transformManualImpl = defineWorkflow({
  ...transformManualDecl,
  async execute() {
    return { score: 1 };
  },
});

const _transformManualStructuralOk: AssertAssignable<
  TransformWorkflowContractSurface,
  typeof transformManualImpl
> = transformManualImpl;

const _badTransformReturn = defineWorkflow({
  ...transformWorkflowHeader,
  // @ts-expect-error — must return `InferInput` of result schema (`{ score: number }`), not post-transform output
  async execute(_ctx, _args) {
    return { doubled: 2 };
  },
});
void _badTransformReturn;

const transformStepArgs = z.string().transform((s) => s.length);
const transformStepResult = z.boolean().transform((b) => ({ wrapped: b }));

const transformStepIface = defineStepInterface({
  name: "tfStep",
  args: transformStepArgs,
  result: transformStepResult,
});

const transformStepDef = transformStepIface.implement({
  async execute(args, _opts) {
    type _StepDecodedArgs = Assert<IsEqual<typeof args, number>>;
    // @ts-expect-error — step `execute` args are `InferOutput` of the args schema (length), not the raw string input
    void args.charAt;
    return args > 0;
  },
});

void transformStepDef;

const transformStepWorkflowIface = defineWorkflowInterface({
  name: "tfWfWithStep",
  args: z.void(),
  result: z.void(),
  steps: { tf: transformStepIface },
});

const transformStepWorkflow = transformStepWorkflowIface.implement({
  steps: { tf: transformStepDef },
  async execute(ctx) {
    type _StepCallArg = Assert<
      IsEqual<Parameters<(typeof ctx)["steps"]["tf"]>[0], string>
    >;
    // @ts-expect-error — dispatch uses `SchemaInvocationInput` / `InferInput` of args schema (string), not decoded length
    void ctx.steps.tf(3);
    const out = await ctx.steps.tf("ab");
    type _StepAwaited = Assert<IsEqual<typeof out, { wrapped: boolean }>>;
    void out.wrapped;
    return undefined;
  },
});

void transformStepWorkflow;

// =============================================================================
// extend — header-derived handles only
// =============================================================================

const fulfillmentHeader = defineWorkflowHeader({
  name: "ifaceFulfillment",
  args: z.object({ orderId: z.string() }),
  result: z.void(),
});

const fulfillmentInterface = fulfillmentHeader.extend({
  streams: { metrics: z.object({ units: z.number() }) },
});

declare const fulfillmentChildFromGraph: AttachedChildWorkflowExternalHandle<
  typeof fulfillmentHeader
>;

const fulfillmentStrong =
  fulfillmentChildFromGraph.extend(fulfillmentInterface);

type _FulfillmentStrong = Assert<
  IsEqual<
    typeof fulfillmentStrong,
    AttachedChildWorkflowExternalHandle<typeof fulfillmentInterface>
  >
>;

void fulfillmentStrong.streams.metrics.read(0);

const fulfillmentWorkflow = fulfillmentInterface.implement({
  async execute(ctx) {
    void ctx.streams.metrics.write;
    return undefined;
  },
});

void fulfillmentWorkflow;

type _FulfillmentRootIsHeader = IsHeaderAuthoringKind<
  typeof fulfillmentWorkflow
>;
type _DefinitionHandleNotHeaderDerived = Assert<
  _FulfillmentRootIsHeader extends false ? true : false
>;

type _FulfillmentHeaderIsHeader = IsHeaderAuthoringKind<
  typeof fulfillmentHeader
>;
type _HeaderMarkedForExtend = Assert<
  _FulfillmentHeaderIsHeader extends true ? true : false
>;

// =============================================================================
// Client registry prefers interface / definition (not header-only)
// =============================================================================

const _ctx13Client = createWorkflowClient({
  order: orderInterface,
  full: ctx13FullInterface,
});
type _Ctx13ClientKeys = Assert<
  IsEqual<keyof typeof _ctx13Client.workflows, "order" | "full">
>;
void _ctx13Client;
