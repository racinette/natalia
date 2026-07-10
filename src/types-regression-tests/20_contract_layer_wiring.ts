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
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type {
  InferWorkflowMetadata,
  InferWorkflowResult,
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
  async execute(ctx) {
    return { ok: ctx.args.n > 0 };
  },
});

const layerCompStepIface = defineStepInterface({
  name: "layerCompStep",
  args: z.object({ token: z.string() }),
  result: z.object({ paid: z.boolean() }),
  compensation: {
    result: z.void(),
    channels: { cUndo: z.number() },
    steps: { layerInnerStep },
  },
});

const layerCompStep = layerCompStepIface.implement({
  async execute() {
    return { paid: true };
  },
  compensation: {
    result: z.void(),
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
    readonly compensation: {
      readonly undo: (...args: never[]) => unknown;
    };
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
  metadata: z.undefined(),
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
  metadata: z.undefined(),
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
    void ctx.childWorkflows.child({ seed: 1 }, { metadata: undefined });
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
  metadata: z.undefined(),
  result: z.void(),
});

const layerNoopChildWf = layerNoopChildHeader.extend({}).implement({
  async execute() {},
});

const layerNoopParentHeader = defineWorkflowHeader({
  name: "layerNoopParent",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
});

const layerNoopParent = layerNoopParentHeader.extend({
  childWorkflows: { noop: layerNoopChildWf },
}).implement({
  async execute(ctx) {
    void ctx.childWorkflows.noop(undefined, { metadata: undefined });
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

// =============================================================================
// Workflow header: metadata and result schemas are required (explicit z.undefined / z.void)
// =============================================================================

// @ts-expect-error metadata schema is required on every workflow header
defineWorkflowHeader({
  name: "layerMissingMetadata",
  args: z.undefined(),
  result: z.void(),
});

// @ts-expect-error result schema is required on every workflow header
defineWorkflowHeader({
  name: "layerMissingResult",
  args: z.undefined(),
  metadata: z.undefined(),
});

const _layerExplicitContractHeader = defineWorkflowHeader({
  name: "layerExplicitContract",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
});

type _NoMetadataIsUndefined = Assert<
  IsEqual<InferWorkflowMetadata<typeof _layerExplicitContractHeader>, undefined>
>;
type _NoResultIsVoid = Assert<
  IsEqual<InferWorkflowResult<typeof _layerExplicitContractHeader>, void>
>;

// @ts-expect-error metadata schema is required on defineWorkflow
defineWorkflow({
  name: "layerMissingMetadataWf",
  args: z.undefined(),
  result: z.void(),
  async execute() {},
});
