/**
 * Acceptance tests — workflow topic publish + compensation undo attribute surface.
 *
 * ## Definition of Done
 *
 * ### A. Workflow body — `ctx.topics` (mirrors queues)
 * - `defineWorkflow` and `header.extend().implement()` accept a `topics` map.
 * - `ctx.topics.<declared>.publish(record, { metadata })` returns `void` with typed
 *   record/metadata inputs.
 * - Undeclared topic keys and invalid payload shapes are rejected at compile time.
 * - Workflow body cannot publish to topics declared only on a compensation block.
 *
 * ### B. Compensation undo — per-instance `ctx.attributes`
 * - `ctx.attributes.<declared>.set(value)` on compensation block attributes (set-only).
 * - Undeclared attribute keys and invalid values are rejected at compile time.
 * - Compensation undo cannot set workflow-level attributes; workflow body cannot set
 *   compensation block attributes.
 *
 * ### C. Compensation undo — topics/queues (already shipped; isolation only here)
 * - Compensation `undo` keeps typed access to declared `topics` and `queues`.
 * - Workflow body cannot publish to compensation-only topics.
 *
 * ### Out of scope (this tranche)
 * - `client.registerTopicConsumer` / batch consumers / engine publish runtime.
 *
 * Implementation must not land until this file fails typecheck at the expected sites.
 */

import { z } from "zod";
import {
  defineStep,
  defineTopic,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type { Assert, IsEqual } from "./type-assertions";
import { explicitKeyIdentity, orderIdIdentity } from "./test-identity";

// =============================================================================
// Shared topic fixtures
// =============================================================================

const workflowAuditTopic = defineTopic({
  name: "topicsRegressionAudit",
  record: z.object({ type: z.string(), orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
});

const compensationUndoTopic = defineTopic({
  name: "topicsRegressionCompUndo",
  record: z.object({ event: z.string() }),
  metadata: z.object({ source: z.string() }),
});

// =============================================================================
// A. Workflow body — publish from `execute`
// =============================================================================

const _topicsDirectWf = defineWorkflow({
  name: "topicsPublishDirect",
  args: z.object({ orderId: z.string(), tenantId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: orderIdIdentity,
  topics: { audit: workflowAuditTopic },
  async execute(ctx) {
    const _published = ctx.topics.audit.publish(
      { type: "order.started", orderId: ctx.args.orderId },
      { metadata: { tenantId: ctx.args.tenantId } },
    );
    type _PublishVoid = Assert<IsEqual<typeof _published, void>>;

    // @ts-expect-error undeclared topic key on workflow body
    ctx.topics.unknown.publish({ event: "x" }, { metadata: { source: "bad" } });

    // @ts-expect-error record shape must match topic schema
    ctx.topics.audit.publish({ type: 123, orderId: ctx.args.orderId }, { metadata: { tenantId: ctx.args.tenantId } });

    return { ok: true };
  },
});

const _topicsHeader = defineWorkflowHeader({
  name: "topicsPublishChain",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: orderIdIdentity,
});

const _topicsChainWf = _topicsHeader
  .extend({
    topics: { audit: workflowAuditTopic },
  })
  .implement({
    async execute(ctx) {
      ctx.topics.audit.publish(
        { type: "order.started", orderId: ctx.args.orderId },
        { metadata: { tenantId: "t-chain" } },
      );
      return { ok: true };
    },
  });

// =============================================================================
// B + C. Isolation — workflow topics vs compensation topics/attributes
// =============================================================================

const WorkflowProgress = z.object({ phase: z.string() });
const CompensationProgress = z.object({ percent: z.number() });

const _isolationStep = defineStep({
  name: "topicsIsolationStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
    attributes: { undoProgress: CompensationProgress },
    topics: { undo: compensationUndoTopic },
    async undo(ctx) {
      ctx.attributes.undoProgress.set({ percent: 100 });
      ctx.topics.undo.publish(
        { event: "undo.done" },
        { metadata: { source: "compensation" } },
      );

      // @ts-expect-error compensation undo cannot see workflow-only attributes
      ctx.attributes.workflowProgress.set({ phase: "done" });

      // @ts-expect-error compensation undo cannot publish workflow-only topics
      ctx.topics.audit.publish(
        { type: "x", orderId: "o" },
        { metadata: { tenantId: "t" } },
      );

      // @ts-expect-error invalid compensation attribute value
      ctx.attributes.undoProgress.set({ percent: "full" });

      return undefined;
    },
  },
  async execute() {
    return { ok: true };
  },
});

const _isolationWf = defineWorkflow({
  name: "topicsIsolationWorkflow",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  identity: explicitKeyIdentity,
  attributes: { workflowProgress: WorkflowProgress },
  topics: { audit: workflowAuditTopic },
  steps: { iso: _isolationStep },
  async execute(ctx) {
    ctx.attributes.workflowProgress.set({ phase: "running" });
    ctx.topics.audit.publish(
      { type: "wf.start", orderId: "o-1" },
      { metadata: { tenantId: "t-1" } },
    );

    // @ts-expect-error workflow body cannot set compensation block attributes
    ctx.attributes.undoProgress.set({ percent: 1 });

    // @ts-expect-error workflow body cannot publish compensation-only topics
    ctx.topics.undo.publish({ event: "x" }, { metadata: { source: "wf" } });

    await ctx.steps.iso({ id: "s-1" });
  },
});

void _topicsDirectWf;
void _topicsChainWf;
void _isolationWf;
