import { z } from "zod";
import { defineRequest, defineStep, defineWorkflow } from "../workflow";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// FIXTURES
// =============================================================================

const undoStep = defineStep({
  name: "ctxIsoUndoStep",
  args: z.object({ id: z.string() }),
  result: z.object({ undone: z.boolean() }),
  async execute() {
    return { undone: true };
  },
});

const undoRequest = defineRequest({
  name: "ctxIsoUndoRequest",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

// A compensable step — cannot itself be a dependency of another compensation
// block. Verified below.
const compensableForOther = defineStep({
  name: "ctxIsoCompensableForOther",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
    async undo(_ctx) {},
  },
  async execute() {
    return { ok: true };
  },
});

const compensableRequestForOther = defineRequest({
  name: "ctxIsoCompensableRequestForOther",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
  compensation: { result: z.void() },
});

// =============================================================================
// COMPENSATION CONTEXT — sees ONLY declared dependencies; has no `ctx.errors`.
// =============================================================================

const compensableStep = defineStep({
  name: "ctxIsoCompensableStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
    steps: { undoStep },
    requests: { undoRequest },
    async undo(ctx) {
      type _UndoArgs = Assert<IsEqual<typeof ctx.args, { id: string }>>;

      // Declared dependencies are reachable.
      await ctx.steps.undoStep({ id: ctx.args.id });
      await ctx.requests.undoRequest({ id: ctx.args.id });

      // The workflow body's steps / requests are NOT visible here.
      // @ts-expect-error compensation undo only sees its own declared dependencies
      void ctx.steps.workflowOnlyStep;
      // @ts-expect-error compensation undo only sees its own declared dependencies
      void ctx.requests.workflowOnlyRequest;

      // No `ctx.errors` on the compensation context.
      // @ts-expect-error compensation undo has no ctx.errors
      void ctx.errors;
    },
  },
  async execute() {
    return { ok: true };
  },
});

// =============================================================================
// DEFINITION-TIME DEPENDENCY FILTERING
//
// Compensation block dependencies must not themselves be compensable (no
// recursive compensation chains). Child workflows are exempt — each child
// owns its own compensation lifecycle.
// =============================================================================

// @ts-expect-error compensation steps cannot themselves be compensable
defineStep({
  name: "ctxIsoForbidsCompensableStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
    steps: { compensableForOther },
    async undo(_ctx) {},
  },
  async execute() {
    return { ok: true };
  },
});

// @ts-expect-error compensation requests cannot themselves be compensable
defineStep({
  name: "ctxIsoForbidsCompensableRequest",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(),
    requests: { compensableRequestForOther },
    async undo(_ctx) {},
  },
  async execute() {
    return { ok: true };
  },
});

// =============================================================================
// WORKFLOW BODY — sees the workflow's declared steps, requests, and
// childWorkflows; sees the workflow's declared `errors`.
// =============================================================================

const workflowOnlyStep = defineStep({
  name: "ctxIsoWorkflowOnlyStep",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

const workflowOnlyRequest = defineRequest({
  name: "ctxIsoWorkflowOnlyRequest",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

export const contextIsolationAcceptanceWorkflow = defineWorkflow({
  name: "contextIsolationAcceptance",
  args: z.undefined(),
  metadata: z.undefined(),
  steps: { compensableStep, workflowOnlyStep },
  requests: { workflowOnlyRequest },
  errors: {
    WorkflowOnly: z.object({ id: z.string() }),
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    // Declared steps / requests are reachable.
    await ctx.steps.compensableStep({ id: "1" });
    await ctx.steps.workflowOnlyStep({ id: "2" });
    await ctx.requests.workflowOnlyRequest({ id: "3" });

    // The workflow's declared errors are reachable on `ctx.errors`.
    const _err = ctx.errors.WorkflowOnly("err", { id: "4" });
    void _err;

    // Undeclared codes are rejected.
    // @ts-expect-error workflow body cannot reference an unknown error code
    ctx.errors.UndeclaredOnCompensation("not visible");

    // Removed surfaces stay removed.
    // @ts-expect-error global mutable workflow state was removed
    void ctx.state;
    // @ts-expect-error general LIFO compensation registration was removed
    void ctx.addCompensation;

    return { ok: true };
  },
});
