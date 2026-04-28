import { z } from "zod";
import {
  defineBranch,
  defineRequest,
  defineStep,
  defineWorkflow,
} from "../workflow";
import type {
  AttemptAccessor,
  BranchHaltRecord,
  BranchInstanceStatus,
  CompensationBlockHaltRecord,
  CompensationBlockStatus,
  FindUniqueResult,
  RequestCompensationInfo,
  RequestCompensationStatus,
  WorkflowHaltRecord,
} from "../types";
import type { WorkflowHandleExternal } from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// =============================================================================
// FIXTURE: a workflow with branches, compensable steps, compensable requests
// =============================================================================

const refundStep = defineStep({
  name: "introspectionRefundStep",
  args: z.object({ chargeId: z.string() }),
  result: z.void(),
  async execute() {},
});

const chargeStep = defineStep({
  name: "introspectionChargeStep",
  args: z.object({ customerId: z.string(), amount: z.number() }),
  result: z.object({ chargeId: z.string() }),
  compensation: {
    steps: { refundStep },
    attributes: {
      progress: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("waiting") }),
        z.object({ kind: z.literal("refunded"), refundId: z.string() }),
      ]),
    },
    streams: {
      audit: z.object({ msg: z.string() }),
    },
    events: {
      settled: true,
    },
    channels: {
      operatorNote: z.object({ note: z.string() }),
    },
    result: z.object({
      status: z.enum(["refunded", "manual_review"]),
    }),
    async undo(_ctx, _args, _info) {
      return { status: "refunded" as const };
    },
  },
  async execute(_ctx, args) {
    return { chargeId: `c-${args.customerId}` };
  },
});

const noResultCompensableStep = defineStep({
  name: "introspectionNoResultStep",
  args: z.object({ id: z.string() }),
  result: z.void(),
  compensation: {
    async undo() {},
  },
  async execute() {},
});

const approvalRequest = defineRequest({
  name: "introspectionApprovalRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ approved: z.boolean() }),
  compensation: {
    result: z.object({ cancelled: z.boolean() }),
  },
});

const noResultCompensableRequest = defineRequest({
  name: "introspectionNoResultRequest",
  payload: z.object({ chargeId: z.string() }),
  response: z.object({ ok: z.boolean() }),
  compensation: true,
});

const provisionBranch = defineBranch({
  name: "introspectionProvisionBranch",
  args: z.object({ city: z.string() }),
  result: z.object({ confirmationId: z.string() }),
  async execute(_ctx, args) {
    return { confirmationId: `c-${args.city}` };
  },
});

const voidResultBranch = defineBranch({
  name: "introspectionVoidBranch",
  args: z.object({ id: z.string() }),
  result: z.void(),
  async execute() {},
});

const introspectionWorkflow = defineWorkflow({
  name: "introspectionAcceptance",
  args: z.object({ orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  steps: { chargeStep, noResultCompensableStep },
  requests: { approvalRequest, noResultCompensableRequest },
  branches: { provision: provisionBranch, voidBranch: voidResultBranch },
  result: z.object({ ok: z.boolean() }),
  async execute(_ctx, _args) {
    return { ok: true };
  },
});

declare const handle: WorkflowHandleExternal<
  { ok: boolean },
  unknown,
  Record<string, never>,
  Record<string, never>,
  Record<string, never>
>;

// =============================================================================
// BRANCH INSTANCE INTROSPECTION
// =============================================================================

async function inspectBranchInstance(): Promise<void> {
  // findUnique by query callback (typed against args + metadata namespaces).
  const provisionByQuery = handle.branches.provision.findUnique((q) =>
    q.args.city.eq("Paris"),
  );

  const status = await provisionByQuery.status();
  type _BranchStatusReturn = Assert<
    IsEqual<typeof status, FindUniqueResult<BranchInstanceStatus>>
  >;

  const result = await provisionByQuery.result();
  type _BranchResultReturn = Assert<
    IsEqual<
      typeof result,
      FindUniqueResult<{ confirmationId: string } | null>
    >
  >;

  const args = await provisionByQuery.args();
  type _BranchArgsReturn = Assert<
    IsEqual<typeof args, FindUniqueResult<{ city: string }>>
  >;

  const halt = await provisionByQuery.halt();
  type _BranchHaltReturn = Assert<
    IsEqual<typeof halt, FindUniqueResult<BranchHaltRecord | null>>
  >;

  // Skip on a branch with a result schema requires a typed result.
  await provisionByQuery.skip({ confirmationId: "manual" });

  // @ts-expect-error skip on a branch with a result schema requires the result
  await provisionByQuery.skip();

  // findUnique by id (opaque branded id).
  const provisionById = handle.branches.provision.findUnique(
    "branch-instance-id" as never,
  );
  void provisionById;

  // @ts-expect-error querying a non-existent namespace
  handle.branches.provision.findUnique((q) => q.unknown.foo.eq("x"));

  // @ts-expect-error unknown branch name
  handle.branches.unknown.findUnique((q) => q.args);

  // void-result branches accept skip with no arguments.
  const voidByQuery = handle.branches.voidBranch.findUnique((q) =>
    q.args.id.eq("x"),
  );
  await voidByQuery.skip();

  // @ts-expect-error void-result branches reject any positional skip arg
  await voidByQuery.skip({ id: "x" });

  // findMany returns a subset handle; reads operate over the subset.
  const provisionMany = handle.branches.provision.findMany((q) =>
    q.metadata.tenantId.eq("tenant-a"),
  );
  const count = await provisionMany.count();
  type _SubsetCount = Assert<IsEqual<typeof count, number>>;

  const list = await provisionMany.list({ limit: 10 });
  type _SubsetListShape = Assert<
    IsEqual<
      typeof list.items[number]["status"],
      BranchInstanceStatus
    >
  >;

  const fanout = await provisionMany.skip({ confirmationId: "bulk" });
  type _FanoutSkipShape = Assert<IsEqual<typeof fanout, { affected: number }>>;

  // @ts-expect-error per-instance reads are not exposed on subset handles
  await provisionMany.status();
}

// =============================================================================
// COMPENSATION BLOCK INSTANCE INTROSPECTION
// =============================================================================

async function inspectCompensationBlockInstance(): Promise<void> {
  const chargeBlocks = handle.compensations.chargeStep.findUnique((q) =>
    q.args.customerId.eq("cust-1"),
  );

  const status = await chargeBlocks.status();
  type _CompStatus = Assert<
    IsEqual<typeof status, FindUniqueResult<CompensationBlockStatus>>
  >;

  const result = await chargeBlocks.result();
  type _CompResult = Assert<
    IsEqual<
      typeof result,
      FindUniqueResult<{ status: "refunded" | "manual_review" } | null>
    >
  >;

  const args = await chargeBlocks.args();
  type _CompArgs = Assert<
    IsEqual<
      typeof args,
      FindUniqueResult<{ customerId: string; amount: number }>
    >
  >;

  const halt = await chargeBlocks.halt();
  type _CompHalt = Assert<
    IsEqual<typeof halt, FindUniqueResult<CompensationBlockHaltRecord | null>>
  >;

  // Skip with a typed result.
  await chargeBlocks.skip({ status: "manual_review" });

  // Per-instance attribute read.
  const progress = await chargeBlocks.attributes.progress.getNowait();
  type _ProgressNowait = Assert<
    IsEqual<
      typeof progress,
      FindUniqueResult<
        | {
            value:
              | { kind: "waiting" }
              | { kind: "refunded"; refundId: string };
            version: number;
          }
        | { status: "not_set" }
      >
    >
  >;

  // Per-instance event wait.
  const settled = await chargeBlocks.events.settled.wait();
  type _SettledWait = Assert<
    IsEqual<
      typeof settled,
      FindUniqueResult<
        { ok: true; status: "set" } | { ok: false; status: "never" }
      >
    >
  >;

  // Per-instance channel send.
  const sent = await chargeBlocks.channels.operatorNote.send({ note: "hi" });
  type _OperatorNoteSend = Assert<
    IsEqual<typeof sent, FindUniqueResult<{ delivered: true }>>
  >;

  // No-result compensation blocks expose null and reject skip arguments.
  const noResult = handle.compensations.noResultCompensableStep.findUnique(
    (q) => q.args.id.eq("x"),
  );
  const noResultRead = await noResult.result();
  type _NoResultRead = Assert<
    IsEqual<typeof noResultRead, FindUniqueResult<null>>
  >;
  await noResult.skip();

  // @ts-expect-error no-result compensation skip rejects positional args
  await noResult.skip({ status: "manual_review" });

  // Subset handles for fan-out.
  const haltedCharges = handle.compensations.chargeStep.findMany((q) =>
    q.metadata.status.eq("halted"),
  );
  const fanoutResult = await haltedCharges.skip({ status: "manual_review" });
  type _FanoutCompShape = Assert<
    IsEqual<typeof fanoutResult, { affected: number }>
  >;

  await haltedCharges.channels.operatorNote.send({ note: "fanout" });

  // @ts-expect-error subset handles do not expose per-instance attribute reads
  await haltedCharges.attributes.progress.getNowait();

  // @ts-expect-error compensation block names must be declared on the workflow
  handle.compensations.unknownStep.findUnique((q) => q.args);
}

// =============================================================================
// REQUEST COMPENSATION INTROSPECTION
// =============================================================================

async function inspectRequestCompensation(): Promise<void> {
  const approval = handle.requestCompensations.approvalRequest.findUnique(
    (q) => q.payload.chargeId.eq("ch_1"),
  );

  const status = await approval.status();
  type _ReqCompStatus = Assert<
    IsEqual<typeof status, FindUniqueResult<RequestCompensationStatus>>
  >;

  const result = await approval.result();
  type _ReqCompResult = Assert<
    IsEqual<typeof result, FindUniqueResult<{ cancelled: boolean } | null>>
  >;

  const payload = await approval.payload();
  type _ReqCompPayload = Assert<
    IsEqual<typeof payload, FindUniqueResult<{ chargeId: string }>>
  >;

  const info = await approval.info();
  type _ReqCompInfo = Assert<
    IsEqual<
      typeof info,
      FindUniqueResult<RequestCompensationInfo<unknown>>
    >
  >;

  const attempts = await approval.attempts();
  type _ReqCompAttempts = Assert<
    IsEqual<typeof attempts, FindUniqueResult<AttemptAccessor>>
  >;

  await approval.skip({ cancelled: true });

  // Request compensations have no halts and no per-instance primitives.
  // @ts-expect-error request compensation invocations have no halt records
  approval.halt;
  // @ts-expect-error request compensation invocations have no per-instance attributes
  approval.attributes;
  // @ts-expect-error request compensation invocations have no per-instance streams
  approval.streams;
  // @ts-expect-error request compensation invocations have no per-instance events
  approval.events;
  // @ts-expect-error request compensation invocations have no per-instance channels
  approval.channels;

  // No-result compensation skip rejects positional args.
  const noResult =
    handle.requestCompensations.noResultCompensableRequest.findUnique((q) =>
      q.payload.chargeId.eq("x"),
    );
  await noResult.skip();
  // @ts-expect-error no-result request compensation skip rejects positional args
  await noResult.skip({ cancelled: true });

  // @ts-expect-error request compensations must be declared on the workflow
  handle.requestCompensations.unknownRequest.findUnique((q) => q.payload);
}

// =============================================================================
// WORKFLOW EXECUTION HALT OBSERVATION
// =============================================================================

async function inspectExecutionHalts(): Promise<void> {
  const halts = await handle.halts.list();
  type _HaltsListShape = Assert<
    IsEqual<typeof halts, readonly WorkflowHaltRecord[]>
  >;

  // @ts-expect-error workflow execution halts have no skip — resolution is patch+replay or sigkill
  await handle.halts.skip();
  // @ts-expect-error workflow handle does not expose halt reasoning beyond list()
  handle.halts.findUnique;
}

void introspectionWorkflow;
void inspectBranchInstance;
void inspectCompensationBlockInstance;
void inspectRequestCompensation;
void inspectExecutionHalts;
