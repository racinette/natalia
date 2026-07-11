// Acceptance tests — mandatory workflow identity block and start/get semantics.
//
// These assertions target the NEW identity model. They must fail typecheck until
// the implementation lands in workflow-headers, helpers, engine, and call-builders.

import { z } from "zod";
import { createTestWorkflowClient } from "./test-client";
import { session } from "./test-session";
import {
  explicitKeyIdentity,
  orderIdIdentity,
  orderRequestedAtIdentity,
  tenantOrderIdentity,
} from "./test-identity";
import { defineWorkflow, defineWorkflowHeader, defineStep } from "../workflow";
import type {
  HasDeriveIdentity,
  InferWorkflowIdentityInput,
  InferWorkflowIdentityOutput,
} from "../types/helpers";
import type { ExternalWorkflowAccessor } from "../types/context/call-builders";
import type { WorkflowClientAccessor } from "../types/engine";
import type { Assert, IsEqual } from "./type-assertions";

// =============================================================================
// 1. Mandatory identity block on defineWorkflow / defineWorkflowHeader
// =============================================================================

type _DefineWorkflowRequiresIdentity = Assert<
  Parameters<typeof defineWorkflow>[0] extends { identity: unknown } ? true : false
>;
type _DefineWorkflowHeaderRequiresIdentity = Assert<
  Parameters<typeof defineWorkflowHeader>[0] extends { identity: unknown } ? true : false
>;

const derivedIdentityHeader = defineWorkflowHeader({
  name: "derivedIdentityHeader",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: orderIdIdentity,
});

const _explicitIdentityWorkflow = defineWorkflow({
  name: "explicitIdentityWorkflow",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: explicitKeyIdentity,
  async execute() {
    return { ok: true };
  },
});

const _derivedIdentityWorkflow = defineWorkflow({
  name: "derivedIdentityWorkflow",
  args: z.object({ orderId: z.string(), requestedAt: z.coerce.date() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: orderRequestedAtIdentity,
  async execute() {
    return { ok: true };
  },
});

const _tenantDerivedWorkflow = defineWorkflow({
  name: "tenantDerivedWorkflow",
  args: z.object({ orderId: z.string() }),
  metadata: z.object({ tenantId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  identity: tenantOrderIdentity,
  async execute() {
    return { ok: true };
  },
});

// =============================================================================
// 2. HasDeriveIdentity discriminates on deriveIdentity presence
// =============================================================================

type _ExplicitHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _explicitIdentityWorkflow>, false>
>;
type _DerivedHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof _derivedIdentityWorkflow>, true>
>;
type _HeaderDerivedHasDerive = Assert<
  IsEqual<HasDeriveIdentity<typeof derivedIdentityHeader>, true>
>;

// =============================================================================
// 3. InferWorkflowIdentity* helpers surface schema input/output
// =============================================================================

type _ExplicitIdentityOutput = Assert<
  IsEqual<InferWorkflowIdentityOutput<typeof _explicitIdentityWorkflow>, { key: string }>
>;
type _DerivedIdentityInput = Assert<
  IsEqual<
    InferWorkflowIdentityInput<typeof _derivedIdentityWorkflow>,
    { orderId: string; requestedAt: string }
  >
>;
type _TenantIdentityOutput = Assert<
  IsEqual<
    InferWorkflowIdentityOutput<typeof _tenantDerivedWorkflow>,
    { tenantId: string; orderId: string }
  >
>;

// =============================================================================
// 4. Client start — conditional identity field; idempotencyKey forbidden
// =============================================================================

declare const explicitClient: WorkflowClientAccessor<typeof _explicitIdentityWorkflow>;
declare const derivedClient: WorkflowClientAccessor<typeof _derivedIdentityWorkflow>;
declare const tenantClient: WorkflowClientAccessor<typeof _tenantDerivedWorkflow>;

async function clientStartAssertions(): Promise<void> {
  // explicit identity at start when no deriveIdentity
  await explicitClient.start(session, {
    identity: { key: "run-1" },
    args: undefined,
    metadata: undefined,
  });

  // @ts-expect-error identity required when workflow has no deriveIdentity
  await explicitClient.start(session, {
    args: undefined,
    metadata: undefined,
  });

  await explicitClient.start(session, {
    identity: { key: "run-2" },
    args: undefined,
    metadata: undefined,
    // @ts-expect-error idempotencyKey is not a start option under the identity model
    idempotencyKey: "legacy-key",
  });

  await explicitClient.start(session, {
    args: undefined,
    metadata: undefined,
    // @ts-expect-error identity.key must be a string
    identity: { key: 123 },
  });

  await explicitClient.start(session, {
    args: undefined,
    metadata: undefined,
    // @ts-expect-error identity must match the declared schema shape
    identity: { orderId: "wrong-field" },
  });

  // deriveIdentity present => args + metadata only
  await derivedClient.start(session, {
    args: { orderId: "o-1", requestedAt: "2027-01-01T00:00:00.000Z" },
    metadata: undefined,
  });

  await derivedClient.start(session, {
    // @ts-expect-error identity must not be passed when deriveIdentity is declared
    identity: { orderId: "o-1", requestedAt: "2027-01-01T00:00:00.000Z" },
    args: { orderId: "o-1", requestedAt: "2027-01-01T00:00:00.000Z" },
    metadata: undefined,
  });

  await tenantClient.start(session, {
    args: { orderId: "o-2" },
    metadata: { tenantId: "t-1" },
  });
}
void clientStartAssertions;

// =============================================================================
// 5. Client .get — identity object only (not string key, not raw args)
// =============================================================================

async function clientGetAssertions(): Promise<void> {
  explicitClient.get({ key: "run-1" });
  derivedClient.get({ orderId: "o-1", requestedAt: "2027-01-01T00:00:00.000Z" });
  tenantClient.get({ tenantId: "t-1", orderId: "o-2" });

  // @ts-expect-error lookup is by identity schema, not idempotency key string
  explicitClient.get("run-1");
  // @ts-expect-error lookup is by identity schema, not idempotency key string
  derivedClient.get("order:o-1");

  // malformed identity shapes — wrong field or wrong value type
  // @ts-expect-error get requires the declared identity schema shape
  explicitClient.get({ orderId: "x" });
  // @ts-expect-error identity.key must be a string
  explicitClient.get({ key: 123 });
}
void clientGetAssertions;

async function clientExecuteAssertions(): Promise<void> {
  await explicitClient.execute(session, {
    identity: { key: "run-exec-1" },
    args: undefined,
    metadata: undefined,
  });

  // @ts-expect-error identity required when workflow has no deriveIdentity
  await explicitClient.execute(session, {
    args: undefined,
    metadata: undefined,
  });

  await derivedClient.execute(session, {
    args: { orderId: "o-exec", requestedAt: "2027-01-01T00:00:00.000Z" },
    metadata: undefined,
  });

  await derivedClient.execute(session, {
    args: { orderId: "o-exec-2", requestedAt: "2027-01-01T00:00:00.000Z" },
    metadata: undefined,
    // @ts-expect-error identity must not be passed when deriveIdentity is declared
    identity: { orderId: "o-exec-2", requestedAt: "2027-01-01T00:00:00.000Z" },
  });

  await explicitClient.execute(session, {
    identity: { key: "run-exec-2" },
    args: undefined,
    metadata: undefined,
    // @ts-expect-error idempotencyKey is not a start/execute option under the identity model
    idempotencyKey: "legacy-exec-key",
  });
}
void clientExecuteAssertions;

// =============================================================================
// 6. External workflow start/get parity
// =============================================================================

const explicitExternalChildHeader = defineWorkflowHeader({
  name: "externalExplicitChild",
  args: z.object({ orderId: z.string() }),
  metadata: z.undefined(),
  result: z.void(),
  identity: {
    schema: z.object({ orderId: z.string() }),
    deriveIdempotencyKey: (id: { orderId: string }) => `ext:${id.orderId}`,
  },
});

const externalParent = defineWorkflow({
  name: "externalIdentityParent",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  identity: explicitKeyIdentity,
  externalWorkflows: {
    derived: derivedIdentityHeader,
    explicit: explicitExternalChildHeader,
  },
  async execute(ctx) {
    ctx.externalWorkflows.derived.start(
      { orderId: "o-ext" },
      { metadata: undefined },
    );

    ctx.externalWorkflows.explicit.start(
      { orderId: "o-ext-2" },
      { identity: { orderId: "o-ext-2" }, metadata: undefined },
    );

    ctx.externalWorkflows.derived.start(
      { orderId: "o-bad" },
      {
        metadata: undefined,
        // @ts-expect-error external start forbids idempotencyKey
        idempotencyKey: "legacy",
      },
    );

    // @ts-expect-error explicit external child requires identity in start options
    ctx.externalWorkflows.explicit.start({ orderId: "o-missing" }, { metadata: undefined });
  },
});

void externalParent;

declare const extDerived: ExternalWorkflowAccessor<typeof derivedIdentityHeader>;
declare const extExplicit: ExternalWorkflowAccessor<typeof explicitExternalChildHeader>;

extDerived.get({ orderId: "o-ext" });
extExplicit.get({ orderId: "o-ext-2" });

// @ts-expect-error external get is by identity, not string key
extDerived.get("order:o-ext");

// =============================================================================
// 7. End-to-end client wiring with createTestWorkflowClient
// =============================================================================

const withDeriveHeader = defineWorkflowHeader({
  name: "withDeriveChild",
  args: z.object({ orderId: z.string(), requestedAt: z.coerce.date() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: orderRequestedAtIdentity,
});

const withoutDeriveHeader = defineWorkflowHeader({
  name: "withoutDeriveChild",
  args: z.object({ orderId: z.string(), requestedAt: z.coerce.date() }),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: {
    schema: z.object({ orderId: z.string(), requestedAt: z.string() }),
    deriveIdempotencyKey: (id: { orderId: string; requestedAt: string }) =>
      `manual:${id.orderId}`,
  },
});

const identityParentWorkflow = defineWorkflow({
  name: "identityParent",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.object({ ok: z.boolean() }),
  identity: explicitKeyIdentity,
  externalWorkflows: {
    withDerive: withDeriveHeader,
    withoutDerive: withoutDeriveHeader,
  },
  async execute(ctx) {
    ctx.externalWorkflows.withDerive.start(
      { orderId: "o-2", requestedAt: "2027-01-01T00:00:00.000Z" },
      { metadata: undefined },
    );

    ctx.externalWorkflows.withoutDerive.start(
      { orderId: "o-4", requestedAt: "2027-01-01T00:00:00.000Z" },
      {
        identity: {
          orderId: "o-4",
          requestedAt: "2027-01-01T00:00:00.000Z",
        },
        metadata: undefined,
      },
    );

    return { ok: true };
  },
});

const identityClient = createTestWorkflowClient({
  withDerive: defineWorkflow({
    name: "withDeriveWorkflow",
    args: z.object({ orderId: z.string(), requestedAt: z.coerce.date() }),
    metadata: z.undefined(),
    result: z.object({ ok: z.boolean() }),
    identity: orderRequestedAtIdentity,
    async execute() {
      return { ok: true };
    },
  }),
  withoutDerive: defineWorkflow({
    name: "withoutDeriveWorkflow",
    args: z.object({ orderId: z.string(), requestedAt: z.coerce.date() }),
    metadata: z.undefined(),
    result: z.object({ ok: z.boolean() }),
    identity: {
      schema: z.object({ orderId: z.string(), requestedAt: z.string() }),
      deriveIdempotencyKey: (id: { orderId: string; requestedAt: string }) =>
        `manual:${id.orderId}`,
    },
    async execute() {
      return { ok: true };
    },
  }),
  parent: identityParentWorkflow,
});

async function e2eClientStart(): Promise<void> {
  await identityClient.workflows.withDerive.start(session, {
    metadata: undefined,
    args: { orderId: "o-1", requestedAt: "2027-01-01T00:00:00.000Z" },
  });

  await identityClient.workflows.withDerive.start(session, {
    metadata: undefined,
    // @ts-expect-error idempotencyKey forbidden on client start
    idempotencyKey: "explicit-root",
    args: { orderId: "o-2", requestedAt: "2027-01-01T00:00:00.000Z" },
  });

  // @ts-expect-error identity required when no deriveIdentity
  await identityClient.workflows.withoutDerive.start(session, {
    metadata: undefined,
    args: { orderId: "o-3", requestedAt: "2027-01-01T00:00:00.000Z" },
  });

  await identityClient.workflows.withoutDerive.start(session, {
    metadata: undefined,
    identity: {
      orderId: "o-4",
      requestedAt: "2027-01-01T00:00:00.000Z",
    },
    args: { orderId: "o-4", requestedAt: "2027-01-01T00:00:00.000Z" },
  });
}
void e2eClientStart;

// =============================================================================
// 8. Remaining user-facing entry points
// =============================================================================

const _lockedExtendHeader = defineWorkflowHeader({
  name: "lockedExtendIdentity",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  identity: explicitKeyIdentity,
});

// @ts-expect-error identity is header-locked — cannot override in extend()
void _lockedExtendHeader.extend({ identity: explicitKeyIdentity });

const _compUndoExtHeader = defineWorkflowHeader({
  name: "compUndoExtPartner",
  args: z.undefined(),
  metadata: z.undefined(),
  result: z.void(),
  identity: explicitKeyIdentity,
});

const _compUndoIdentityStep = defineStep({
  name: "compUndoIdentityStep",
  args: z.object({ token: z.string() }),
  result: z.void(),
  compensation: {
    result: z.void(),
    externalWorkflows: { ext: _compUndoExtHeader },
    async undo(ctx) {
      await ctx.externalWorkflows.ext.start(undefined, {
        metadata: undefined,
        identity: { key: "comp-ext-1" },
      });
      ctx.externalWorkflows.ext.get({ key: "comp-ext-1" });

      // @ts-expect-error explicit external start requires identity when no deriveIdentity
      await ctx.externalWorkflows.ext.start(undefined, { metadata: undefined });

      // @ts-expect-error external get is by identity object, not string key
      ctx.externalWorkflows.ext.get("comp-ext-1");

      return undefined;
    },
  },
  async execute() {
    return undefined;
  },
});
void _compUndoIdentityStep;
