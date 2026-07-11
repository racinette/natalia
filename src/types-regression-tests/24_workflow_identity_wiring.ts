/**
 * Identity generic wiring — structural guards against `any` / `unknown` / bound
 * erosion through the authoring chain and client surfaces.
 *
 * Complements `23_workflow_identity.ts` (behavioral start/get semantics) with
 * `IsAny`, anti-`unknown`, and `IsEqual` anchors on inferred identity shapes.
 */
import { z } from "zod";
import {
  defineWorkflow,
  defineWorkflowHeader,
  defineWorkflowInterface,
} from "../workflow";
import type { ExternalWorkflowStartOptions } from "../types/context/call-builders";
import type { AnyWorkflowHeader, AnyWorkflowReference } from "../types/definitions/workflow-headers";
import type { WorkflowGetArgs, WorkflowStartOptions } from "../types/engine";
import type { JsonInputObject } from "../types/json-input";
import type {
  HasDeriveIdentity,
  InferWorkflowIdentity,
  InferWorkflowIdentityInput,
  InferWorkflowIdentityOutput,
  InferWorkflowResult,
} from "../types/helpers";
import { createTestWorkflowClient } from "./test-client";
import type { Assert, IsEqual } from "./type-assertions";
import {
  explicitKeyIdentity,
  orderIdIdentity,
  tenantOrderIdentity,
} from "./test-identity";

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = unknown extends T ? (T extends unknown ? true : false) : false;

type DeriveKeyIdentityParam<W> = InferWorkflowIdentity<W> extends {
  readonly deriveIdempotencyKey: (identity: infer I) => string;
}
  ? I
  : never;

type ClientStartIdentity<W extends AnyWorkflowHeader> =
  HasDeriveIdentity<W> extends true ? never : WorkflowStartOptions<W>["identity"];

type ClientGetIdentity<W extends AnyWorkflowHeader> = WorkflowGetArgs<W>[0];

type ExternalStartIdentity<W extends AnyWorkflowReference> =
  HasDeriveIdentity<W> extends true ? never : ExternalWorkflowStartOptions<W>["identity"];

// =============================================================================
// 1. Direct defineWorkflow — identity inference must not erode
// =============================================================================

const _directExplicitWf = defineWorkflow({
  name: "wiringDirectExplicit",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: explicitKeyIdentity,
  async execute() {
    return { ok: true };
  },
});

const _directDerivedWf = defineWorkflow({
  name: "wiringDirectDerived",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: orderIdIdentity,
  async execute() {
    return { ok: true };
  },
});

type _DirectExplicitHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _directExplicitWf>, false>
>;
type _DirectDerivedHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _directDerivedWf>, true>
>;
type _DirectExplicitOutputNotAny = Assert<
  IsEqual<IsAny<InferWorkflowIdentityOutput<typeof _directExplicitWf>>, false>
>;
type _DirectExplicitOutputNotUnknown = Assert<
  IsEqual<IsUnknown<InferWorkflowIdentityOutput<typeof _directExplicitWf>>, false>
>;
type _DirectExplicitOutputNotWideJson = Assert<
  IsEqual<
    InferWorkflowIdentityOutput<typeof _directExplicitWf>,
    JsonInputObject
  > extends false
    ? true
    : false
>;
type _DirectExplicitOutputShape = Assert<
  IsEqual<InferWorkflowIdentityOutput<typeof _directExplicitWf>, { key: string }>
>;
type _DirectDerivedOutputShape = Assert<
  IsEqual<InferWorkflowIdentityOutput<typeof _directDerivedWf>, { orderId: string }>
>;
type _DirectExplicitDeriveKeyParam = Assert<
  IsEqual<DeriveKeyIdentityParam<typeof _directExplicitWf>, { key: string }>
>;
type _DirectExplicitDeriveKeyParamNotAny = Assert<
  IsEqual<IsAny<DeriveKeyIdentityParam<typeof _directExplicitWf>>, false>
>;
type _DirectExplicitStartIdentityNotAny = Assert<
  IsEqual<IsAny<ClientStartIdentity<typeof _directExplicitWf>>, false>
>;
type _DirectExplicitStartIdentityShape = Assert<
  IsEqual<ClientStartIdentity<typeof _directExplicitWf>, { key: string }>
>;
type _DirectExplicitGetNotAny = Assert<
  IsEqual<IsAny<ClientGetIdentity<typeof _directExplicitWf>>, false>
>;
type _DirectExplicitGetShape = Assert<
  IsEqual<ClientGetIdentity<typeof _directExplicitWf>, { key: string }>
>;

// =============================================================================
// 2. defineWorkflowHeader → extend → implement — the cast-sensitive chain
// =============================================================================

const objectMetaIdentity = {
  schema: z.object({ id: z.string(), tenantId: z.string() }),
  deriveIdentity: ({
    args,
    metadata,
  }: {
    args: { id: string };
    metadata: { tenantId: string };
  }) => ({
    id: args.id,
    tenantId: metadata.tenantId,
  }),
  deriveIdempotencyKey: (id: { id: string; tenantId: string }) =>
    `${id.tenantId}:${id.id}`,
} as const;

const _explicitHeader = defineWorkflowHeader({
  name: "wiringChainExplicit",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: explicitKeyIdentity,
});

const _explicitChainWf = _explicitHeader.extend({}).implement({
  async execute() {
    return { ok: true };
  },
});

const _derivedHeader = defineWorkflowHeader({
  name: "wiringChainDerived",
  args: z.object({ orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  identity: tenantOrderIdentity,
});

const _derivedChainWf = _derivedHeader
  .extend({
    streams: { log: z.object({ line: z.string() }) },
  })
  .implement({
    async execute() {
      return { ok: true };
    },
  });

const _objectMetaChainWf = defineWorkflowHeader({
  name: "wiringChainObjectMeta",
  args: z.object({ id: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.void(),
  identity: objectMetaIdentity,
})
  .extend({})
  .implement({
    async execute() {},
  });

type _ChainExplicitHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _explicitChainWf>, false>
>;
type _ChainDerivedHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _derivedChainWf>, true>
>;
type _ChainObjectMetaHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _objectMetaChainWf>, true>
>;
type _ChainExplicitOutputNotAny = Assert<
  IsEqual<IsAny<InferWorkflowIdentityOutput<typeof _explicitChainWf>>, false>
>;
type _ChainExplicitOutputShape = Assert<
  IsEqual<InferWorkflowIdentityOutput<typeof _explicitChainWf>, { key: string }>
>;
type _ChainDerivedOutputNotUnknown = Assert<
  IsEqual<IsUnknown<InferWorkflowIdentityOutput<typeof _derivedChainWf>>, false>
>;
type _ChainDerivedOutputShape = Assert<
  IsEqual<
    InferWorkflowIdentityOutput<typeof _derivedChainWf>,
    { tenantId: string; orderId: string }
  >
>;
type _ChainObjectMetaOutputShape = Assert<
  IsEqual<
    InferWorkflowIdentityOutput<typeof _objectMetaChainWf>,
    { id: string; tenantId: string }
  >
>;
type _ChainExplicitStartIdentity = Assert<
  IsEqual<ClientStartIdentity<typeof _explicitChainWf>, { key: string }>
>;
type _ChainDerivedInputNotAny = Assert<
  IsEqual<IsAny<InferWorkflowIdentityInput<typeof _derivedChainWf>>, false>
>;
type _ChainDerivedInputShape = Assert<
  IsEqual<
    InferWorkflowIdentityInput<typeof _derivedChainWf>,
    { tenantId: string; orderId: string }
  >
>;

// =============================================================================
// 3. defineWorkflowInterface → implement — second cast-sensitive bridge
// =============================================================================

const _ifaceExplicit = defineWorkflowInterface({
  name: "wiringIfaceExplicit",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: explicitKeyIdentity,
});

const _ifaceExplicitWf = _ifaceExplicit.implement({
  async execute() {
    return { ok: true };
  },
});

const _ifaceDerived = defineWorkflowInterface({
  name: "wiringIfaceDerived",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: orderIdIdentity,
});

const _ifaceDerivedWf = _ifaceDerived.implement({
  async execute() {
    return { ok: true };
  },
});

type _IfaceExplicitOutputNotAny = Assert<
  IsEqual<IsAny<InferWorkflowIdentityOutput<typeof _ifaceExplicitWf>>, false>
>;
type _IfaceExplicitOutputShape = Assert<
  IsEqual<InferWorkflowIdentityOutput<typeof _ifaceExplicitWf>, { key: string }>
>;
type _IfaceDerivedOutputShape = Assert<
  IsEqual<InferWorkflowIdentityOutput<typeof _ifaceDerivedWf>, { orderId: string }>
>;
type _IfaceExplicitHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _ifaceExplicitWf>, false>
>;
type _IfaceDerivedHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _ifaceDerivedWf>, true>
>;
type _IfaceExplicitStartIdentity = Assert<
  IsEqual<ClientStartIdentity<typeof _ifaceExplicitWf>, { key: string }>
>;

// =============================================================================
// 4. Graph edges — header references keep per-target identity typing
// =============================================================================

declare const _extDerivedStartIdentity: ExternalStartIdentity<typeof _derivedHeader>;
type _ExtDerivedStartNotAny = Assert<IsEqual<IsAny<typeof _extDerivedStartIdentity>, false>>;
void _extDerivedStartIdentity;

declare const _extExplicitStartIdentity: ExternalStartIdentity<typeof _explicitHeader>;
type _ExtExplicitStartShape = Assert<
  IsEqual<typeof _extExplicitStartIdentity, { key: string }>
>;
void _extExplicitStartIdentity;

type _ExtDerivedGetNotUnknown = Assert<
  IsEqual<IsUnknown<InferWorkflowIdentityOutput<typeof _derivedHeader>>, false>
>;
type _ExtDerivedGetShape = Assert<
  IsEqual<
    InferWorkflowIdentityOutput<typeof _derivedHeader>,
    { tenantId: string; orderId: string }
  >
>;
type _ExtExplicitGetShape = Assert<
  IsEqual<InferWorkflowIdentityOutput<typeof _explicitHeader>, { key: string }>
>;

const _externalParentWf = defineWorkflow({
  name: "wiringExternalParent",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  identity: explicitKeyIdentity,
  externalWorkflows: {
    derived: _derivedHeader,
    explicit: _explicitHeader,
  },
  async execute() {},
});
void _externalParentWf;

// =============================================================================
// 5. createTestWorkflowClient — map values must not widen client accessors
// =============================================================================

const _wiringClient = createTestWorkflowClient({
  explicit: _explicitChainWf,
  derived: _derivedChainWf,
});

type _ClientExplicitStartShape = Assert<
  IsEqual<ClientStartIdentity<typeof _explicitChainWf>, { key: string }>
>;
type _ClientDerivedStartIdentityAbsent = Assert<
  IsEqual<ClientStartIdentity<typeof _derivedChainWf>, never>
>;
type _ClientExplicitGetShape = Assert<
  IsEqual<ClientGetIdentity<typeof _explicitChainWf>, { key: string }>
>;
type _ClientDerivedGetShape = Assert<
  IsEqual<
    ClientGetIdentity<typeof _derivedChainWf>,
    { tenantId: string; orderId: string }
  >
>;
void _wiringClient;

// =============================================================================
// 6. Pre-implement interface — TIdentity must survive extend without implement
// =============================================================================

const _derivedIfaceOnly = _derivedHeader.extend({
  streams: { log: z.object({ line: z.string() }) },
});

type _IfaceOnlyHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _derivedIfaceOnly>, true>
>;
type _IfaceOnlyOutputNotUnknown = Assert<
  IsEqual<IsUnknown<InferWorkflowIdentityOutput<typeof _derivedIfaceOnly>>, false>
>;
type _IfaceOnlyOutputShape = Assert<
  IsEqual<
    InferWorkflowIdentityOutput<typeof _derivedIfaceOnly>,
    { tenantId: string; orderId: string }
  >
>;

// =============================================================================
// 7. Child graph edges — header references keep result + identity helpers specific
// =============================================================================

const _childParentWf = defineWorkflow({
  name: "wiringChildParent",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  identity: explicitKeyIdentity,
  childWorkflows: { child: _derivedHeader },
  async execute() {},
});
void _childParentWf;

type _ChildHeaderResultNotAny = Assert<
  IsEqual<IsAny<InferWorkflowResult<typeof _derivedHeader>>, false>
>;
type _ChildHeaderIdentityOutput = Assert<
  IsEqual<
    InferWorkflowIdentityOutput<typeof _derivedHeader>,
    { tenantId: string; orderId: string }
  >
>;
