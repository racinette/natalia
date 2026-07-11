import { z } from "zod";

/**
 * Shared workflow identity fixtures for regression tests.
 *
 * Every `defineWorkflow` / `defineWorkflowHeader` must declare an `identity`
 * block. Pick the helper that matches the workflow's args/metadata shape.
 */

/** Ephemeral: caller supplies `identity` at start; no `deriveIdentity`. */
export const explicitKeyIdentity = {
  schema: z.object({ key: z.string() }),
  deriveIdempotencyKey: (id: { key: string }) => id.key,
} as const;

/** Identity derived from `args.orderId`. */
export const orderIdIdentity = {
  schema: z.object({ orderId: z.string() }),
  deriveIdentity: ({
    args,
  }: {
    args: { orderId: string };
    metadata: unknown;
  }) => ({ orderId: args.orderId }),
  deriveIdempotencyKey: (id: { orderId: string }) => `order:${id.orderId}`,
} as const;

/** Same as `orderIdIdentity` but with a caller-chosen key prefix. */
export function orderIdKeyPrefix(prefix: string) {
  return {
    schema: z.object({ orderId: z.string() }),
    deriveIdentity: ({
      args,
    }: {
      args: { orderId: string };
      metadata: unknown;
    }) => ({ orderId: args.orderId }),
    deriveIdempotencyKey: (id: { orderId: string }) => `${prefix}:${id.orderId}`,
  } as const;
}

/** Identity from `metadata.tenantId` + `args.orderId`. */
export const tenantOrderIdentity = {
  schema: z.object({ tenantId: z.string(), orderId: z.string() }),
  deriveIdentity: ({
    args,
    metadata,
  }: {
    args: { orderId: string };
    metadata: { tenantId: string };
  }) => ({
    tenantId: metadata.tenantId,
    orderId: args.orderId,
  }),
  deriveIdempotencyKey: (id: { tenantId: string; orderId: string }) =>
    `${id.tenantId}:order:${id.orderId}`,
} as const;

/** Identity derived from `args.id`. */
export const idArgIdentity = {
  schema: z.object({ id: z.string() }),
  deriveIdentity: ({
    args,
  }: {
    args: { id: string };
    metadata: unknown;
  }) => ({ id: args.id }),
  deriveIdempotencyKey: (id: { id: string }) => id.id,
} as const;

/** Identity derived from `args.amount`. */
export const amountIdentity = {
  schema: z.object({ amount: z.number() }),
  deriveIdentity: ({
    args,
  }: {
    args: { amount: number };
    metadata: unknown;
  }) => ({ amount: args.amount }),
  deriveIdempotencyKey: (id: { amount: number }) => `amount:${id.amount}`,
} as const;

/** Identity derived from `args.value`. */
export const valueArgIdentity = {
  schema: z.object({ value: z.number() }),
  deriveIdentity: ({
    args,
  }: {
    args: { value: number };
    metadata: unknown;
  }) => ({ value: args.value }),
  deriveIdempotencyKey: (id: { value: number }) => `v:${id.value}`,
} as const;

/** Identity derived from `args.seed`. */
export const seedArgIdentity = {
  schema: z.object({ seed: z.number() }),
  deriveIdentity: ({
    args,
  }: {
    args: { seed: number };
    metadata: unknown;
  }) => ({ seed: args.seed }),
  deriveIdempotencyKey: (id: { seed: number }) => `seed:${id.seed}`,
} as const;

/** Identity derived from `args.wid`. */
export const widArgIdentity = {
  schema: z.object({ wid: z.string() }),
  deriveIdentity: ({
    args,
  }: {
    args: { wid: string };
    metadata: unknown;
  }) => ({ wid: args.wid }),
  deriveIdempotencyKey: (id: { wid: string }) => id.wid,
} as const;

/** Identity derived from `args.flag`. */
export const flagArgIdentity = {
  schema: z.object({ flag: z.boolean() }),
  deriveIdentity: ({
    args,
  }: {
    args: { flag: boolean };
    metadata: unknown;
  }) => ({ flag: args.flag }),
  deriveIdempotencyKey: (id: { flag: boolean }) => (id.flag ? "flag-true" : "flag-false"),
} as const;

/** Identity derived from `args.token`. */
export const tokenArgIdentity = {
  schema: z.object({ token: z.string() }),
  deriveIdentity: ({
    args,
  }: {
    args: { token: string };
    metadata: unknown;
  }) => ({ token: args.token }),
  deriveIdempotencyKey: (id: { token: string }) => `token:${id.token}`,
} as const;

/** Identity derived from `args.orderId` + ISO `requestedAt` string. */
export const orderRequestedAtIdentity = {
  schema: z.object({ orderId: z.string(), requestedAt: z.string() }),
  deriveIdentity: ({
    args,
  }: {
    args: { orderId: string; requestedAt: Date };
    metadata: unknown;
  }) => ({
    orderId: args.orderId,
    requestedAt: args.requestedAt.toISOString(),
  }),
  deriveIdempotencyKey: (id: { orderId: string; requestedAt: string }) =>
    `order:${id.orderId}`,
} as const;
