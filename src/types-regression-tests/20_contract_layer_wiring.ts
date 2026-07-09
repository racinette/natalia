/**
 * Acceptance anchors for contract-layer wiring:
 * - step interface → `.implement()` → workflow `.implement()` chain (no `any` bridge)
 * - request/queue maps use `RequestDefinition` / `QueueDefinition` directly (no *Interface aliases)
 * - child accessors always require workflow args (including `undefined` for `z.undefined()`)
 */
import { z } from "zod";
import {
  defineStep,
  defineStepInterface,
  defineWorkflowHeader,
} from "../workflow";
import type {
  StepInterface,
} from "../types";
import type { Assert, IsEqual } from "./type-assertions";

type IsAny<T> = 0 extends 1 & T ? true : false;

type ImplementedCompensationSlot<S> =
  S extends { readonly compensation: infer C } ? C : never;

// =============================================================================
// Step interface → implement: compensation slot must not be `any`
// =============================================================================

const layerInnerStep = defineStep({
  name: "layerInnerStep",
  args: z.object({ n: z.number() }),
  result: z.object({ ok: z.boolean() }),
  async execute(args) {
    return { ok: args.n > 0 };
  },
});

const layerCompStepIface = defineStepInterface({
  name: "layerCompStep",
  args: z.object({ token: z.string() }),
  result: z.object({ paid: z.boolean() }),
  compensation: {
    channels: { cUndo: z.number() },
    steps: { layerInnerStep },
  },
});

const layerCompStep = layerCompStepIface.implement({
  async execute() {
    return { paid: true };
  },
  compensation: {
    steps: { layerInnerStep },
    async undo(ctx) {
      void ctx.channels.cUndo;
      void ctx.steps.layerInnerStep;
      return undefined;
    },
  },
});

type _LayerCompSlotNotAny = Assert<
  IsEqual<IsAny<ImplementedCompensationSlot<typeof layerCompStep>>, false>
>;

type _LayerCompHasUndo = Assert<
  typeof layerCompStep extends {
    readonly compensation: { readonly undo: (...args: never[]) => unknown };
  }
    ? true
    : false
>;

type _LayerUndoSeesInterfaceChannel = Assert<
  IsEqual<
    NonNullable<(typeof layerCompStep)["compensation"]>["channels"],
    NonNullable<(typeof layerCompStepIface)["compensation"]>["channels"]
  >
>;

// =============================================================================
// Workflow interface → implement: step map accepts `.implement()` outputs
// =============================================================================

const layerChildHeader = defineWorkflowHeader({
  name: "layerChild",
  args: z.object({ seed: z.number() }),
  result: z.string(),
});

const layerChildWf = layerChildHeader.extend({}).implement({
  async execute() {
    return "ok";
  },
});

const layerMainHeader = defineWorkflowHeader({
  name: "layerMain",
  args: z.object({ wid: z.string() }),
  result: z.number(),
});

const layerMainIface = layerMainHeader.extend({
  steps: { withComp: layerCompStepIface },
  childWorkflows: { child: layerChildWf },
});

void layerMainIface.implement({
  steps: {
    withComp: layerCompStep,
  },
  async execute(ctx) {
    void ctx.steps.withComp({ token: "t" });
    void ctx.childWorkflows.child({ seed: 1 });
    return ctx.args.wid.length;
  },
});

// =============================================================================
// Request/queue contract aliases removed from public surface
// =============================================================================

// @ts-expect-error RequestInterface is not part of the public type surface
import type { RequestInterface as _RemovedRequestInterface } from "../types";
// @ts-expect-error QueueInterface is not part of the public type surface
import type { QueueInterface as _RemovedQueueInterface } from "../types";

// =============================================================================
// Child accessor: `z.undefined()` args still require an explicit argument
// =============================================================================

const layerNoopChildHeader = defineWorkflowHeader({
  name: "layerNoopChild",
  args: z.undefined(),
  result: z.void(),
});

const layerNoopChildWf = layerNoopChildHeader.extend({}).implement({
  async execute() {},
});

const layerNoopParentHeader = defineWorkflowHeader({
  name: "layerNoopParent",
  args: z.undefined(),
  result: z.void(),
});

const layerNoopParent = layerNoopParentHeader.extend({
  childWorkflows: { noop: layerNoopChildWf },
}).implement({
  async execute(ctx) {
    void ctx.childWorkflows.noop(undefined);
    // @ts-expect-error child workflows always take args — pass `undefined` when schema is z.undefined()
    void ctx.childWorkflows.noop();
  },
});

void layerNoopParent;

// =============================================================================
// StepDefinition structurally completes StepInterface after implement
// =============================================================================

type _StepDefExtendsIface = Assert<
  typeof layerCompStep extends StepInterface<
    "layerCompStep",
    typeof layerCompStepIface.args,
    typeof layerCompStepIface.result,
    NonNullable<(typeof layerCompStepIface)["compensation"]>
  >
    ? true
    : false
>;
