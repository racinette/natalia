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

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

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

const fooHeader = defineWorkflowHeader({
  name: "foo",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
});

type _FooHeaderName = Assert<IsEqual<typeof fooHeader.name, "foo">>;

const barHeader = defineWorkflowHeader({
  name: "bar",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
});

type _BarHeaderName = Assert<IsEqual<typeof barHeader.name, "bar">>;

// Two structurally identical headers (same args/result/channels/etc.) must
// still be type-distinguishable because their names differ.
type _HeadersAreDistinguishable = Assert<
  IsEqual<typeof fooHeader, typeof barHeader> extends false ? true : false
>;

// AttachedChildWorkflowId brands derived from these headers must not be
// interchangeable.
declare const fooAttachedId: AttachedChildWorkflowId<typeof fooHeader>;
declare const barAttachedId: AttachedChildWorkflowId<typeof barHeader>;
type _AttachedBrandSeparation = Assert<
  IsEqual<typeof fooAttachedId, typeof barAttachedId> extends false ? true : false
>;

// =============================================================================
// 2. defineWorkflow preserves the name literal.
// =============================================================================

const fooWorkflow = defineWorkflow({
  name: "fooWorkflow",
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

type _FooWorkflowName = Assert<IsEqual<typeof fooWorkflow.name, "fooWorkflow">>;

const barWorkflow = defineWorkflow({
  name: "barWorkflow",
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

type _BarWorkflowName = Assert<IsEqual<typeof barWorkflow.name, "barWorkflow">>;
type _WorkflowsAreDistinguishable = Assert<
  IsEqual<typeof fooWorkflow, typeof barWorkflow> extends false ? true : false
>;

// =============================================================================
// 3. defineStep preserves the name literal.
// =============================================================================

const stepFoo = defineStep({
  name: "stepFoo",
  args: z.object({ id: z.string() }),
  result: z.void(),
  async execute() {},
});

type _StepFooName = Assert<IsEqual<typeof stepFoo.name, "stepFoo">>;

const stepBar = defineStep({
  name: "stepBar",
  args: z.object({ id: z.string() }),
  result: z.void(),
  async execute() {},
});

type _StepBarName = Assert<IsEqual<typeof stepBar.name, "stepBar">>;
type _StepsAreDistinguishable = Assert<
  IsEqual<typeof stepFoo, typeof stepBar> extends false ? true : false
>;

// CompensationId<TStep> brand separation depends on TName capture.
const compensableFoo = defineStep({
  name: "compensableFoo",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: { async undo() {} },
  async execute() {
    return { ok: true };
  },
});

const compensableBar = defineStep({
  name: "compensableBar",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  compensation: { async undo() {} },
  async execute() {
    return { ok: true };
  },
});

declare const fooCompId: CompensationId<typeof compensableFoo>;
declare const barCompId: CompensationId<typeof compensableBar>;
type _CompensationBrandSeparation = Assert<
  IsEqual<typeof fooCompId, typeof barCompId> extends false ? true : false
>;

// =============================================================================
// 4. defineRequest preserves the name literal.
// =============================================================================

const requestFoo = defineRequest({
  name: "requestFoo",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

type _RequestFooName = Assert<IsEqual<typeof requestFoo.name, "requestFoo">>;

const requestBar = defineRequest({
  name: "requestBar",
  payload: z.object({ id: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

type _RequestBarName = Assert<IsEqual<typeof requestBar.name, "requestBar">>;

// =============================================================================
// 5. defineQueue preserves the name literal.
// =============================================================================

const queueFoo = defineQueue({
  name: "queueFoo",
  message: z.object({ id: z.string() }),
});

type _QueueFooName = Assert<IsEqual<typeof queueFoo.name, "queueFoo">>;

// =============================================================================
// 6. defineTopic preserves the name literal.
// =============================================================================

const topicFoo = defineTopic({
  name: "topicFoo",
  record: z.object({ id: z.string() }),
});

type _TopicFooName = Assert<IsEqual<typeof topicFoo.name, "topicFoo">>;

// =============================================================================
// 7. NEGATIVE: a wide `string` name is allowed (default TName = string) but
//    produces a wide name; useful for cases where the name is dynamic.
// =============================================================================

declare const dynamicName: string;
const dynamicWorkflow = defineWorkflow({
  name: dynamicName,
  result: z.void(),
  async execute() {},
});
type _DynamicWorkflowName = Assert<IsEqual<typeof dynamicWorkflow.name, string>>;
