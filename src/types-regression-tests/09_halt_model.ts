import { z } from "zod";
import { defineBranch, defineStep, defineWorkflow } from "../workflow";
import type {
  BranchHaltHandle,
  BranchJoinResult,
  CompensationBlockHaltHandle,
  ExecutionHaltHandle,
  HaltStatus,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type _HaltStatus = Assert<
  IsEqual<HaltStatus, "open" | "resolved" | "skipped" | "terminated">
>;

const haltingStep = defineStep({
  name: "haltingStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

const haltingBranch = defineBranch({
  name: "haltingBranch",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  steps: { haltingStep },
  async execute(ctx, args) {
    return ctx.steps.haltingStep({ id: args.id });
  },
});

export const haltModelAcceptanceWorkflow = defineWorkflow({
  name: "haltModelAcceptance",
  branches: { haltingBranch },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    const branch = ctx.branches.haltingBranch({ id: "b-1" });
    const joined = await ctx.join(branch);

    type _JoinDoesNotObserveHalt = Assert<
      IsEqual<
        typeof joined,
        BranchJoinResult<{ ok: boolean }>
      >
    >;

    return { ok: joined.ok };
  },
});

declare const executionHalt: ExecutionHaltHandle;
declare const branchHalt: BranchHaltHandle<{ ok: boolean }>;
declare const compensationHalt: CompensationBlockHaltHandle;

async function inspectHalts(): Promise<void> {
  const execution = await executionHalt.get();
  type _ExecutionHaltStatus = Assert<IsEqual<typeof execution.status, HaltStatus>>;

  await executionHalt.replayAfterPatch();
  await executionHalt.terminateWorkflow();
  // @ts-expect-error execution halts are not skippable
  await executionHalt.skip();

  const branch = await branchHalt.get();
  type _BranchHaltStatus = Assert<IsEqual<typeof branch.status, HaltStatus>>;
  type _BranchHaltReason = Assert<
    IsEqual<typeof branch.reason, "determinism" | "unhandled_error">
  >;
  await branchHalt.skip({
    reason: "operator_decision",
    result: { ok: true },
  });
  // @ts-expect-error branch halt skips must provide the replay result
  await branchHalt.skip({ reason: "operator_decision" });

  const compensation = await compensationHalt.get();
  type _CompensationHaltStatus = Assert<
    IsEqual<typeof compensation.status, HaltStatus>
  >;
  await compensationHalt.skip({ reason: "manual_compensation_completed" });
}

void inspectHalts;
