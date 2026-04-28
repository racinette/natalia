import { z } from "zod";
import { createWorkflowClient } from "../client";
import { defineWorkflow } from "../workflow";
import type {
  AttributeGetNowaitResult,
  AttributeGetResult,
  StreamReadNowaitResult,
} from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const ProgressAttribute = z.object({
  percent: z.number(),
  phase: z.enum(["queued", "running", "done"]),
});
const LogRecord = z.object({ message: z.string() });
const Command = z.object({ type: z.literal("cancel") });

export const attributesAndStreamsAcceptanceWorkflow = defineWorkflow({
  name: "attributesAndStreamsAcceptance",
  attributes: {
    progress: ProgressAttribute,
  },
  streams: {
    log: LogRecord,
  },
  channels: {
    command: Command,
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.attributes.progress.set({ percent: 0.5, phase: "running" });

    // @ts-expect-error attribute set is a buffered synchronous operation
    await ctx.attributes.progress.set({ percent: 0.75, phase: "running" });
    // @ts-expect-error workflow code writes attributes but does not read them
    await ctx.attributes.progress.get();
    // @ts-expect-error schema checked value
    ctx.attributes.progress.set({ percent: "half", phase: "running" });

    await ctx.streams.log.write({ message: "started" });

    const bySeconds = await ctx.channels.command.receive(30);
    type _ReceiveSeconds = Assert<
      IsEqual<typeof bySeconds, { type: "cancel" } | undefined>
    >;

    const byDate = await ctx.channels.command.receive(
      new Date("2027-01-01T00:00:00.000Z"),
    );
    type _ReceiveDate = Assert<
      IsEqual<typeof byDate, { type: "cancel" } | undefined>
    >;

    const withDefault = await ctx.channels.command.receive(new Date(), {
      type: "cancel" as const,
    });
    type _ReceiveDefault = Assert<IsEqual<typeof withDefault, { type: "cancel" }>>;

    return { ok: true };
  },
});

const client = createWorkflowClient({
  attributesAndStreamsAcceptance: attributesAndStreamsAcceptanceWorkflow,
});

async function externalReads(): Promise<void> {
  const handle = await client.workflows.attributesAndStreamsAcceptance.start({
    idempotencyKey: "attr-stream-1",
  });

  const progress = await handle.attributes.progress.get({ afterVersion: 3 });
  type _AttributeGet = Assert<
    IsEqual<
      typeof progress,
      AttributeGetResult<{ percent: number; phase: "queued" | "running" | "done" }>
    >
  >;

  const current = await handle.attributes.progress.getNowait();
  type _AttributeNowait = Assert<
    IsEqual<
      typeof current,
      AttributeGetNowaitResult<{
        percent: number;
        phase: "queued" | "running" | "done";
      }>
    >
  >;

  const record = await handle.streams.log.readNowait(0);
  type _StreamNowait = Assert<
    IsEqual<typeof record, StreamReadNowaitResult<{ message: string }>>
  >;

  const defaulted = await handle.streams.log.readNowait(10, {
    status: "not_found" as const,
    value: { message: "missing" },
  });
  type _StreamNowaitDefault = Assert<
    IsEqual<
      typeof defaulted,
      | StreamReadNowaitResult<{ message: string }>
      | { status: "not_found"; value: { message: string } }
    >
  >;
}

void externalReads;
