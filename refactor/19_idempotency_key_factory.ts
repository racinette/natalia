import { z } from "zod";
import { createWorkflowClient } from "../client";
import { defineWorkflow, defineWorkflowHeader } from "../workflow";
import type { StartWorkflowOptions } from "../types";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const WorkflowArgs = z.object({
  orderId: z.string(),
  requestedAt: z.coerce.date(),
});

const withFactoryWorkflow = defineWorkflow({
  name: "withFactoryWorkflow",
  args: WorkflowArgs,
  idempotencyKeyFactory(args) {
    type _FactoryArgsDecoded = Assert<
      IsEqual<typeof args, { orderId: string; requestedAt: Date }>
    >;
    return `order:${args.orderId}`;
  },
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

const withoutFactoryWorkflow = defineWorkflow({
  name: "withoutFactoryWorkflow",
  args: WorkflowArgs,
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
});

const withFactoryHeader = defineWorkflowHeader({
  name: "withFactoryChild",
  args: WorkflowArgs,
  result: z.object({ ok: z.boolean() }),
  idempotencyKeyFactory(args) {
    return `child:${args.orderId}`;
  },
});

const withoutFactoryHeader = defineWorkflowHeader({
  name: "withoutFactoryChild",
  args: WorkflowArgs,
  result: z.object({ ok: z.boolean() }),
});

const parentWorkflow = defineWorkflow({
  name: "idempotencyParent",
  childWorkflows: {
    withFactory: withFactoryHeader,
    withoutFactory: withoutFactoryHeader,
  },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    await ctx.childWorkflows.withFactory({
      args: { orderId: "o-1", requestedAt: "2027-01-01T00:00:00.000Z" },
    });

    await ctx.childWorkflows.withFactory({
      idempotencyKey: "explicit-child",
      args: { orderId: "o-2", requestedAt: "2027-01-01T00:00:00.000Z" },
    });

    // @ts-expect-error child without factory requires idempotencyKey
    await ctx.childWorkflows.withoutFactory({
      args: { orderId: "o-3", requestedAt: "2027-01-01T00:00:00.000Z" },
    });

    await ctx.childWorkflows.withoutFactory({
      idempotencyKey: "required-child",
      args: { orderId: "o-4", requestedAt: "2027-01-01T00:00:00.000Z" },
    });

    ctx.childWorkflows.withFactory.startDetached({
      args: { orderId: "o-5", requestedAt: "2027-01-01T00:00:00.000Z" },
    });

    // @ts-expect-error detached child without factory requires idempotencyKey
    ctx.childWorkflows.withoutFactory.startDetached({
      args: { orderId: "o-6", requestedAt: "2027-01-01T00:00:00.000Z" },
    });

    return { ok: true };
  },
});

const client = createWorkflowClient({
  withFactory: withFactoryWorkflow,
  withoutFactory: withoutFactoryWorkflow,
  parent: parentWorkflow,
});

async function startWorkflows(): Promise<void> {
  await client.workflows.withFactory.start({
    args: { orderId: "o-1", requestedAt: "2027-01-01T00:00:00.000Z" },
  });

  await client.workflows.withFactory.start({
    idempotencyKey: "explicit-root",
    args: { orderId: "o-2", requestedAt: "2027-01-01T00:00:00.000Z" },
  });

  // @ts-expect-error workflow without factory requires idempotencyKey
  await client.workflows.withoutFactory.start({
    args: { orderId: "o-3", requestedAt: "2027-01-01T00:00:00.000Z" },
  });

  await client.workflows.withoutFactory.start({
    idempotencyKey: "required-root",
    args: { orderId: "o-4", requestedAt: "2027-01-01T00:00:00.000Z" },
  });
}

type _WithFactoryOptions = Assert<
  StartWorkflowOptions<{ orderId: string; requestedAt: string }, true> extends {
    args: { orderId: string; requestedAt: string };
    idempotencyKey?: string;
  }
    ? true
    : false
>;

type _WithoutFactoryOptions = Assert<
  StartWorkflowOptions<{ orderId: string; requestedAt: string }, false> extends {
    args: { orderId: string; requestedAt: string };
    idempotencyKey: string;
  }
    ? true
    : false
>;

void startWorkflows;
