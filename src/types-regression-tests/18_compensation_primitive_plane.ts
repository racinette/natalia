// Regression test — compensation block per-instance primitive plane:
// internal set/write accessors on undo ctx and typed external readers on
// `CompensationBlockUniqueHandleExternal`.

import { z } from "zod";
import { createTestWorkflowClient } from "./test-client";
import { defineStep, defineWorkflow } from "../workflow";
import type {
  AttributeGetNowaitResult,
  AttributeGetResult,
  AttributeReaderAccessorExternal,
  ChannelAccessorExternal,
  CompensationBlockUniqueHandleExternal,
  EventAccessorExternal,
  EventCheckResult,
  StreamReaderAccessorExternal,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";

const undoProgress = z.object({ percent: z.number(), phase: z.string() });
const undoAudit = z.object({ entry: z.string() });
const undoNotification = z.object({ note: z.string() });

const compPlaneStep = defineStep({
  name: "compPlaneStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    channels: { undoNotification },
    streams: { undoAudit },
    events: { undoSettled: true },
    attributes: { undoProgress },

    async undo(ctx) {
      ctx.streams.undoAudit.write({ entry: "start" });
      ctx.events.undoSettled.set();
      ctx.attributes.undoProgress.set({ percent: 0.5, phase: "running" });

      // @ts-expect-error attributes are set-only inside compensation bodies
      await ctx.attributes.undoProgress.get();
      // @ts-expect-error schema-checked attribute value
      ctx.attributes.undoProgress.set({ percent: "half", phase: "running" });

      await ctx.channels.undoNotification.receive();

      return;
    },
  },
  async execute() {
    return { ok: true };
  },
});

const compPlaneWorkflow = defineWorkflow({
  name: "compPlaneWorkflow",
  args: z.undefined(),
  steps: { compPlaneStep },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    await ctx.steps.compPlaneStep({ id: "x" });
    return { ok: true };
  },
});

const client = createTestWorkflowClient({
  compPlaneWorkflow,
});

declare const compHandle: CompensationBlockUniqueHandleExternal<
  typeof compPlaneStep,
  { id: string },
  void
>;

type _CompAttributes = Assert<
  IsEqual<
    typeof compHandle.attributes.undoProgress,
    AttributeReaderAccessorExternal<{ percent: number; phase: string }>
  >
>;
type _CompEvents = Assert<
  IsEqual<typeof compHandle.events.undoSettled, EventAccessorExternal>
>;
type _CompChannels = Assert<
  IsEqual<
    typeof compHandle.channels.undoNotification,
    ChannelAccessorExternal<{ note: string }>
  >
>;
type _CompStreams = Assert<
  IsEqual<
    typeof compHandle.streams.undoAudit,
    StreamReaderAccessorExternal<{ entry: string }>
  >
>;

// @ts-expect-error undeclared compensation primitive keys are absent
void compHandle.attributes.typo;
// @ts-expect-error undeclared compensation primitive keys are absent
void compHandle.events.typo;
// @ts-expect-error undeclared compensation primitive keys are absent
void compHandle.channels.typo;
// @ts-expect-error undeclared compensation primitive keys are absent
void compHandle.streams.typo;

async function externalCompPlaneReads(): Promise<void> {
  const handle = await client.workflows.compPlaneWorkflow.start(session, {
    idempotencyKey: "comp-plane-1",
  });

  const compNs = handle.compensations.steps.compPlaneStep;
  const [compHandleFromFind] = await compNs.find(session, { limit: 1 });
  if (!compHandleFromFind) return;

  type _HandleMatchesFixture = Assert<
    IsEqual<typeof compHandleFromFind, typeof compHandle>
  >;
  void (0 as unknown as _HandleMatchesFixture);

  const _progress = await compHandleFromFind.attributes.undoProgress.get({
    afterVersion: 1,
  });
  type _AttributeGet = Assert<
    IsEqual<
      typeof _progress,
      AttributeGetResult<{ percent: number; phase: string }>
    >
  >;

  const _current =
    await compHandleFromFind.attributes.undoProgress.getNowait(session);
  type _AttributeNowait = Assert<
    IsEqual<
      typeof _current,
      AttributeGetNowaitResult<{ percent: number; phase: string }>
    >
  >;

  const _settled = await compHandleFromFind.events.undoSettled.isSet(session);
  type _EventCheck = Assert<IsEqual<typeof _settled, EventCheckResult>>;

  await compHandleFromFind.channels.undoNotification.send(session, {
    note: "hello",
  });
  await compHandleFromFind.streams.undoAudit.readNowait(session, 0);
}

void externalCompPlaneReads();
