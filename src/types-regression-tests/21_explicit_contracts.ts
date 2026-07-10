/**
 * Explicit contract acceptance — invocation options and compensation result
 * schemas must be present at call sites / declarations (no omission fallbacks).
 *
 * Each `@ts-expect-error` row must fail typecheck until the corresponding fix lands.
 */
import { z } from "zod";
import {
  defineRequest,
  defineStep,
  defineStepInterface,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import { createTestWorkflowClient } from "./test-client";
import { session } from "./test-session";
import type { WorkflowHeader, WorkflowReference } from "../types";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// Phase 1 — start / child / external invocation: explicit args & metadata
// =============================================================================

const explicitStartHeader = defineWorkflowHeader({
  name: "explicitStartWf",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
});

const explicitStartWf = explicitStartHeader.extend({}).implement({
  async execute() {},
});

const _explicitStartClient = createTestWorkflowClient({
  explicitStart: explicitStartWf,
});

async function _explicitStartInvocation(client: typeof _explicitStartClient) {
  await client.workflows.explicitStart.start(session, {
    args: undefined,
    metadata: undefined,
    idempotencyKey: "k1",
  });

  // @ts-expect-error args must be explicit undefined when workflow args schema is z.undefined()
  await client.workflows.explicitStart.start(session, {
    metadata: undefined,
    idempotencyKey: "k2",
  });

  // @ts-expect-error metadata must be explicit undefined when metadata schema is z.undefined()
  await client.workflows.explicitStart.start(session, {
    args: undefined,
    idempotencyKey: "k3",
  });
}

const explicitObjectMetaHeader = defineWorkflowHeader({
  name: "explicitObjectMetaWf",
  args: z.object({ id: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.void(),
});

const explicitObjectMetaWf = explicitObjectMetaHeader.extend({}).implement({
  async execute() {},
});

const _explicitObjectMetaClient = createTestWorkflowClient({
  explicitObjectMeta: explicitObjectMetaWf,
});

async function _explicitObjectMetaStart(client: typeof _explicitObjectMetaClient) {
  await client.workflows.explicitObjectMeta.start(session, {
    args: { id: "a1" },
    metadata: { tenantId: "t1" },
    idempotencyKey: "k4",
  });

  // @ts-expect-error metadata is required when workflow declares an object metadata schema
  await client.workflows.explicitObjectMeta.start(session, {
    args: { id: "a2" },
    idempotencyKey: "k5",
  });
}

const explicitChildParent = defineWorkflow({
  name: "explicitChildParent",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  childWorkflows: { child: explicitStartHeader },
  async execute(ctx) {
    await ctx.childWorkflows.child(undefined, {
      metadata: undefined,
    });

    // @ts-expect-error child start metadata must be explicit undefined when schema is z.undefined()
    await ctx.childWorkflows.child(undefined, {});

    // @ts-expect-error child workflow calls require a start-options bag with explicit metadata
    await ctx.childWorkflows.child(undefined);
  },
});

void explicitChildParent;

async function _explicitExternalStart() {
  const parent = defineWorkflow({
    name: "explicitExternalParent",
    args: z.undefined(),
    metadata: z.undefined(),
    result: z.void(),
    externalWorkflows: { ext: explicitStartHeader },
    async execute(ctx) {
      await ctx.externalWorkflows.ext.start(undefined, {
        metadata: undefined,
        idempotencyKey: "ext-1",
      });

      // @ts-expect-error external start metadata must be explicit undefined when schema is z.undefined()
      await ctx.externalWorkflows.ext.start(undefined, {
        idempotencyKey: "ext-2",
      });
    },
  });
  void parent;
}

// =============================================================================
// Phase 2 — compensation result schema required (steps + requests)
// =============================================================================

defineStep({
  name: "explicitCompStepMissingResult",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  // @ts-expect-error step compensation must declare an explicit result schema
  compensation: {
    async undo(_ctx) {
      return undefined;
    },
  },
  async execute() {
    return { ok: true };
  },
});

defineStep({
  name: "explicitCompStepVoidResult",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
    async undo(_ctx) {
      return undefined;
    },
  },
  async execute() {
    return { ok: true };
  },
});

defineStepInterface({
  name: "explicitCompIfaceMissingResult",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  // @ts-expect-error step interface compensation must declare an explicit result schema
  compensation: {
    channels: { c: z.number() },
  },
});

defineStepInterface({
  name: "explicitCompIfaceVoidResult",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
    channels: { c: z.number() },
  },
});

defineRequest({
  name: "explicitReqCompTrue",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
  // @ts-expect-error request compensation must declare result — bare `true` is not allowed
  compensation: true,
});

defineRequest({
  name: "explicitReqCompErrorsOnly",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
  // @ts-expect-error request compensation must declare an explicit result schema
  compensation: {
    errors: { NeedsOperator: true },
  },
});

defineRequest({
  name: "explicitReqCompVoidResult",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
  },
});

// =============================================================================
// Phase 3 — header hierarchy (WorkflowReference ⊂ WorkflowHeader via shared core)
// =============================================================================

type _WorkflowReferenceIsPublicSlice = Assert<
  WorkflowReference extends Pick<
    WorkflowHeader,
    "name" | "args" | "metadata" | "result" | "channels" | "errors" | "idempotencyKeyFactory"
  >
    ? true
    : false
>;

type _ReferenceMissingHeaderOnlyFields = Assert<
  "streams" extends keyof WorkflowReference ? false : true
>;

type _HeaderHasStreamsSlot = Assert<
  "streams" extends keyof WorkflowHeader ? true : false
>;

type _SharedCoreMetadata = Assert<
  IsEqual<
    WorkflowReference["metadata"],
    Pick<WorkflowHeader, "name" | "args" | "metadata" | "result">["metadata"]
  >
>;
