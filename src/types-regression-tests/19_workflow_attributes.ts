// Regression test — workflow-level attributes: declaration, body set-only
// accessors, and typed external get/getNowait on WorkflowHandleExternal.

import { z } from "zod";
import { createTestWorkflowClient } from "./test-client";
import { defineWorkflow } from "../workflow";
import type {
  AttributeGetNowaitResult,
  AttributeGetResult,
  AttributeReaderAccessorExternal,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";
import { session } from "./test-session";

const ProgressAttribute = z.object({
  percent: z.number(),
  phase: z.enum(["queued", "running", "done"]),
});

const attributesWorkflow = defineWorkflow({
  name: "workflowAttributesRegression",
  args: z.undefined(),
  metadata: z.undefined(),
  attributes: {
    progress: ProgressAttribute,
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.attributes.progress.set({ percent: 0.5, phase: "running" });

    // @ts-expect-error workflow code writes attributes but does not read them
    await ctx.attributes.progress.get();
    // @ts-expect-error schema-checked value
    ctx.attributes.progress.set({ percent: "half", phase: "running" });

    return { ok: true };
  },
});

const client = createTestWorkflowClient({
  workflowAttributesRegression: attributesWorkflow,
});

async function externalAttributeReads(): Promise<void> {
  const handle = await client.workflows.workflowAttributesRegression.start(session, { metadata: undefined,
    idempotencyKey: "workflow-attr-1",
  args: undefined,
    });

  type _ProgressReader = Assert<
    IsEqual<
      typeof handle.attributes.progress,
      AttributeReaderAccessorExternal<{
        percent: number;
        phase: "queued" | "running" | "done";
      }>
    >
  >;
  void (0 as unknown as _ProgressReader);

  // @ts-expect-error undeclared workflow attribute should be absent
  void handle.attributes.typo;

  const _progress = await handle.attributes.progress.get({ afterVersion: 3 });
  type _AttributeGet = Assert<
    IsEqual<
      typeof _progress,
      AttributeGetResult<{ percent: number; phase: "queued" | "running" | "done" }>
    >
  >;

  const _current = await handle.attributes.progress.getNowait(session);
  type _AttributeNowait = Assert<
    IsEqual<
      typeof _current,
      AttributeGetNowaitResult<{
        percent: number;
        phase: "queued" | "running" | "done";
      }>
    >
  >;
}

void externalAttributeReads();
