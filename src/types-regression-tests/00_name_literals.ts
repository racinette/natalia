import { z } from "zod";
import {
  defineQueue,
  defineRequest,
  defineStep,
  defineTopic,
  defineWorkflow,
  defineWorkflowHeader,
} from "../workflow";
import type { AttachedChildWorkflowId, CompensationId } from "../types";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// NAME LITERALS PRESERVED ACROSS ALL `define*` FACTORIES
//
// Every `define*` factory captures `name` as a `TName extends string` literal
// and stores it on the resulting definition / header. This matters because:
//
//   1. Branded id types (`AttachedChildWorkflowId<W>`, `CompensationId<TStep>`)
//      use the definition / header as a phantom. If two structurally identical
//      definitions differ only in `name`, the brand must remain
//      type-distinguishable. Without `TName` capture, the `name: string`
//      structural shape erases the literal and the brands collapse.
//
//   2. Future client APIs may dispatch on the literal name (e.g.
//      `client.workflows.<name>` keyed by definition name).
//
//   3. Operators reading `definition.name` get a literal type, not a wide
//      `string`, useful for narrowing in switch statements over registered
//      definitions.
// =============================================================================

// =============================================================================
// 1. defineWorkflowHeader preserves the name literal.
// =============================================================================

const _fooHeader = defineWorkflowHeader({
  name: "foo",
  args: z.object({ id: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
});

type _FooHeaderName = Assert<IsEqual<typeof _fooHeader.name, "foo">>;

const _barHeader = defineWorkflowHeader({
  name: "bar",
  args: z.object({ id: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
});

type _BarHeaderName = Assert<IsEqual<typeof _barHeader.name, "bar">>;

// Two structurally identical headers (same args/result/channels/etc.) must
// still be type-distinguishable because their names differ.
type _HeadersAreDistinguishable = Assert<
  IsEqual<typeof _fooHeader, typeof _barHeader> extends false ? true : false
>;

// AttachedChildWorkflowId brands derived from these headers must not be
// interchangeable.
declare const _fooAttachedId: AttachedChildWorkflowId<typeof _fooHeader>;
declare const _barAttachedId: AttachedChildWorkflowId<typeof _barHeader>;
type _AttachedBrandSeparation = Assert<
  IsEqual<typeof _fooAttachedId, typeof _barAttachedId> extends false ? true : false
>;

// =============================================================================
// 2. defineWorkflow preserves the name literal.
// =============================================================================

const _fooWorkflow = defineWorkflow({
  name: "fooWorkflow",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

type _FooWorkflowName = Assert<IsEqual<typeof _fooWorkflow.name, "fooWorkflow">>;

const _barWorkflow = defineWorkflow({
  name: "barWorkflow",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

type _BarWorkflowName = Assert<IsEqual<typeof _barWorkflow.name, "barWorkflow">>;
type _WorkflowsAreDistinguishable = Assert<
  IsEqual<typeof _fooWorkflow, typeof _barWorkflow> extends false ? true : false
>;

// =============================================================================
// 3. defineStep preserves the name literal.
// =============================================================================

const _stepFoo = defineStep({
  name: "stepFoo",
  args: z.object({ id: z.string() }),
  result: z.void(),
  async execute() {},
});

type _StepFooName = Assert<IsEqual<typeof _stepFoo.name, "stepFoo">>;

const _stepBar = defineStep({
  name: "stepBar",
  args: z.object({ id: z.string() }),
  result: z.void(),
  async execute() {},
});

type _StepBarName = Assert<IsEqual<typeof _stepBar.name, "stepBar">>;
type _StepsAreDistinguishable = Assert<
  IsEqual<typeof _stepFoo, typeof _stepBar> extends false ? true : false
>;

// CompensationId<TStep> brand separation depends on TName capture.
const _compensableFoo = defineStep({
  name: "compensableFoo",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(), async undo(_ctx) {} },
  async execute() {
    return { ok: true };
  },
});

const _compensableBar = defineStep({
  name: "compensableBar",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: {
    result: z.void(), async undo(_ctx) {} },
  async execute() {
    return { ok: true };
  },
});

declare const _fooCompId: CompensationId<typeof _compensableFoo>;
declare const _barCompId: CompensationId<typeof _compensableBar>;
type _CompensationBrandSeparation = Assert<
  IsEqual<typeof _fooCompId, typeof _barCompId> extends false ? true : false
>;

// =============================================================================
// 4. defineRequest preserves the name literal.
// =============================================================================

const _requestFoo = defineRequest({
  name: "requestFoo",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

type _RequestFooName = Assert<IsEqual<typeof _requestFoo.name, "requestFoo">>;

const _requestBar = defineRequest({
  name: "requestBar",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

type _RequestBarName = Assert<IsEqual<typeof _requestBar.name, "requestBar">>;

// =============================================================================
// 5. defineQueue preserves the name literal.
// =============================================================================

const _queueFoo = defineQueue({
  name: "queueFoo",
  message: z.object({ id: z.string() }),
});

type _QueueFooName = Assert<IsEqual<typeof _queueFoo.name, "queueFoo">>;

// =============================================================================
// 6. defineTopic preserves the name literal.
// =============================================================================

const _topicFoo = defineTopic({
  name: "topicFoo",
  record: z.object({ id: z.string() }),
});

type _TopicFooName = Assert<IsEqual<typeof _topicFoo.name, "topicFoo">>;

// =============================================================================
// 7. NEGATIVE: a wide `string` name is allowed (default TName = string) but
//    produces a wide name; useful for cases where the name is dynamic.
// =============================================================================

declare const dynamicName: string;
const _dynamicWorkflow = defineWorkflow({
  name: dynamicName,
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  async execute() {},
});
type _DynamicWorkflowName = Assert<IsEqual<typeof _dynamicWorkflow.name, string>>;
