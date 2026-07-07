// Regression test — stream primitive surface (write offset, external read,
// readNowait, sequential read loops, compensation-block readers).

import { z } from "zod";
import { createTestWorkflowClient } from "./test-client";
import { defineStep, defineWorkflow } from "../workflow";
import type {
  StreamReadNowaitResult,
  StreamReadResult,
  StreamReaderAccessorExternal,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";

const auditStream = z.object({ line: z.string() });

const compStep = defineStep({
  name: "streamsRegressionCompStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    streams: { undoAudit: auditStream },
    async undo(ctx) {
      const _offset = ctx.streams.undoAudit.write({ line: "undo" });
      type _WriteOffset = Assert<IsEqual<typeof _offset, number>>;
      return;
    },
  },
  async execute() {
    return { ok: true };
  },
});

const streamsWorkflow = defineWorkflow({
  name: "streamsRegressionWorkflow",
  streams: {
    log: auditStream,
    metrics: z.object({ step: z.number(), loss: z.number() }),
  },
  steps: { compStep },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    const _first = ctx.streams.log.write({ line: "start" });
    const _second = ctx.streams.metrics.write({ step: 1, loss: 0.5 });
    type _FirstOffset = Assert<IsEqual<typeof _first, number>>;
    type _SecondOffset = Assert<IsEqual<typeof _second, number>>;

    // @ts-expect-error body is write-only — no read on ctx.streams
    await ctx.streams.log.read(0);

    return { ok: true };
  },
});

const client = createTestWorkflowClient({
  streamsRegressionWorkflow: streamsWorkflow,
});

async function externalStreamReads(): Promise<void> {
  const handle = await client.workflows.streamsRegressionWorkflow.start(session, {
    idempotencyKey: "streams-regression-1",
  });

  type _LogReader = Assert<
    IsEqual<
      typeof handle.streams.log,
      StreamReaderAccessorExternal<{ line: string }>
    >
  >;

  const blocking: StreamReadResult<{ line: string }> =
    await handle.streams.log.read(0, { signal: AbortSignal.timeout(5_000) });
  type _BlockingShape = Assert<
    typeof blocking extends
      | { ok: true; status: "read"; data: { line: string }; offset: number }
      | { ok: false; status: "never" }
      ? true
      : false
  >;

  if (blocking.ok && blocking.status === "read") {
    type _ReceivedData = Assert<
      IsEqual<typeof blocking.data, { line: string }>
    >;
    type _ReceivedOffset = Assert<IsEqual<typeof blocking.offset, number>>;
  }

  const _nowait: StreamReadNowaitResult<{ line: string }> =
    await handle.streams.log.readNowait(session, 0);
  type _NowaitShape = Assert<
    typeof _nowait extends
      | { ok: true; status: "read"; data: { line: string }; offset: number }
      | { ok: false; status: "not_found" }
      | { ok: false; status: "never" }
      ? true
      : false
  >;

  const _withDefault = await handle.streams.log.readNowait(session, 99, {
    line: "placeholder",
  });
  type _DefaultShape = Assert<
    typeof _withDefault extends
      | { ok: true; status: "read"; data: { line: string }; offset: number }
      | { ok: false; status: "never" }
      | { line: string }
      ? true
      : false
  >;

  for (let n = 0; n < 100; n++) {
    const step = await handle.streams.metrics.read(n);
    if (!step.ok) break;
    if (step.ok && step.status === "read") {
      type _LoopRow = Assert<
        IsEqual<typeof step.data, { step: number; loss: number }>
      >;
    }
  }

  // @ts-expect-error iterator was removed — use explicit read loops
  handle.streams.log.iterator(0, 100);

  // @ts-expect-error reader is not async-iterable
  for await (const _row of handle.streams.metrics) {
    break;
  }

  const compNs = handle.compensations.steps.compStep;
  const [compHandle] = await compNs.find(session, { limit: 1 });
  if (compHandle) {
    type _CompStreamReader = Assert<
      IsEqual<
        typeof compHandle.streams.undoAudit,
        StreamReaderAccessorExternal<{ line: string }>
      >
    >;
    await compHandle.streams.undoAudit.readNowait(session, 0);
  }
}

void externalStreamReads();

// @ts-expect-error StreamOpenResult was removed
import type { StreamOpenResult as _RemovedStreamOpenResult } from "../types";
