import { z } from "zod";
import { defineStep, defineWorkflow } from "../workflow";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const SerializableStepArgs = z.object({
  destination: z.string(),
  passengerId: z.string(),
  requestedAt: z.coerce.date(),
});

const SerializableStepResult = z.object({
  confirmationId: z.string(),
  bookedAt: z.coerce.date(),
});

const bookSerializableFlight = defineStep({
  name: "bookSerializableFlight",
  args: SerializableStepArgs,
  result: SerializableStepResult,
  async execute(_ctx, args) {
    type _ExecuteArgsNoAny = Assert<IsAny<typeof args> extends false ? true : false>;
    type _ExecuteArgsAreDecoded = Assert<
      IsEqual<
        typeof args,
        {
          destination: string;
          passengerId: string;
          requestedAt: Date;
        }
      >
    >;

    return {
      confirmationId: `${args.destination}:${args.passengerId}`,
      bookedAt: new Date(),
    };
  },
});

defineStep({
  name: "oldShapeRejected",
  args: z.object({ id: z.string() }),
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
  // @ts-expect-error `schema` was renamed to `result`
  schema: z.object({ ok: z.boolean() }),
});

defineStep({
  name: "argsRequired",
  result: z.object({ ok: z.boolean() }),
  async execute() {
    return { ok: true };
  },
  // @ts-expect-error `args` is required so invocation input is persistable
});

export const serializableStepArgsAcceptanceWorkflow = defineWorkflow({
  name: "serializableStepArgsAcceptance",
  steps: { bookSerializableFlight },
  result: z.object({ confirmationId: z.string(), bookedAt: z.coerce.date() }),
  async execute(ctx) {
    const booking = await ctx.steps.bookSerializableFlight({
      destination: "Paris",
      passengerId: "p-123",
      requestedAt: "2027-01-01T00:00:00.000Z",
    });

    type _BookingNoAny = Assert<IsAny<typeof booking> extends false ? true : false>;
    type _BookingDecoded = Assert<
      IsEqual<typeof booking, { confirmationId: string; bookedAt: Date }>
    >;

    // @ts-expect-error positional step args are no longer accepted
    await ctx.steps.bookSerializableFlight("Paris", "p-123");

    // @ts-expect-error call sites accept encoded input, not arbitrary decoded-only values
    await ctx.steps.bookSerializableFlight({
      destination: "Paris",
      passengerId: "p-123",
      requestedAt: { not: "serializable" },
    });

    // @ts-expect-error missing required serialized step arg
    await ctx.steps.bookSerializableFlight({
      destination: "Paris",
      requestedAt: "2027-01-01T00:00:00.000Z",
    });

    return booking;
  },
});

type _DefinitionStoresArgsSchema = Assert<
  typeof bookSerializableFlight extends {
    readonly args: typeof SerializableStepArgs;
    readonly result: typeof SerializableStepResult;
  }
    ? true
    : false
>;
