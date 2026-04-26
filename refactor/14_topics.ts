import { z } from "zod";
import {
  defineTopic,
  defineWorkflow,
  UnrecoverableError,
} from "../workflow";
import { createWorkflowClient } from "../client";
import type {
  NonEmptyReadonlyArray,
  TopicConsumeErrorEvent,
  TopicRecord,
  TopicRecordFilter,
  Unsubscribe,
} from "../types";

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const auditTopic = defineTopic({
  name: "auditTopicAcceptance",
  record: z.object({
    type: z.enum(["booking.confirmed", "booking.cancelled"]),
    orderId: z.string(),
    amount: z.number().optional(),
  }),
  metadata: z.object({ tenantId: z.string(), source: z.string() }),
  retentionSeconds: 86400,
});

export const topicsAcceptanceWorkflow = defineWorkflow({
  name: "topicsAcceptance",
  topics: { audit: auditTopic },
  result: z.object({ ok: z.boolean() }),
  async execute(ctx) {
    ctx.topics.audit.publish(
      { type: "booking.confirmed", orderId: "o-1", amount: 100 },
      { metadata: { tenantId: "tenant-1", source: "workflow" } },
    );

    // @ts-expect-error publish is a buffered synchronous operation
    await ctx.topics.audit.publish(
      { type: "booking.cancelled", orderId: "o-2" },
      { metadata: { tenantId: "tenant-1", source: "workflow" } },
    );

    // @ts-expect-error payload is schema-checked
    ctx.topics.audit.publish({ type: "unknown", orderId: "o-3" });
    // @ts-expect-error metadata is schema-checked
    ctx.topics.audit.publish(
      { type: "booking.confirmed", orderId: "o-4" },
      { metadata: { tenantId: 123 } },
    );

    return { ok: true };
  },
});

const client = createWorkflowClient({ topicsAcceptance: topicsAcceptanceWorkflow });

const filter: TopicRecordFilter<
  z.output<typeof auditTopic.record>,
  z.output<typeof auditTopic.metadata>
> = (q) =>
  q.and(
    q.meta.tenantId.eq("tenant-1"),
    q.payload.type.eq("booking.confirmed"),
    q.payload.amount.gte(100),
  );

const unregister = client.registerTopicConsumer(
  auditTopic,
  "analytics",
  async (_ctx, record) => {
    type _RecordNoAny = Assert<IsAny<typeof record> extends false ? true : false>;
    type _Record = Assert<
      typeof record extends TopicRecord<
        {
          type: "booking.confirmed" | "booking.cancelled";
          orderId: string;
          amount?: number;
        },
        { tenantId: string; source: string }
      >
        ? true
        : false
    >;

    if (record.payload.type === "booking.cancelled") {
      throw new UnrecoverableError("cancelled bookings are ignored");
    }
  },
  {
    neverExpire: true,
    filter,
    retryPolicy: { timeoutSeconds: 10, maxAttempts: 5, intervalSeconds: 1 },
    onConsumeError: {
      callback: async (_ctx, event) => {
        type _NeverExpireEvent = Assert<
          IsEqual<typeof event["type"], "attemptsExhausted">
        >;
        // @ts-expect-error offsetExpired is impossible when neverExpire is true
        if (event.type === "offsetExpired") return "skip";
        return "halt";
      },
    },
  },
);

client.registerTopicConsumer(auditTopic, "normal", async () => undefined, {
  onConsumeError: {
    callback: async (_ctx, event) => {
      type _NormalEvent = Assert<
        IsEqual<typeof event["type"], "attemptsExhausted" | "offsetExpired">
      >;
      return event.type === "offsetExpired" ? "skip" : "halt";
    },
  },
});

const unregisterBatch = client.registerBatchTopicConsumer(
  auditTopic,
  "warehouse",
  async (_ctx, records) => {
    type _Records = Assert<
      typeof records extends NonEmptyReadonlyArray<
        TopicRecord<
          {
            type: "booking.confirmed" | "booking.cancelled";
            orderId: string;
            amount?: number;
          },
          { tenantId: string; source: string }
        >
      >
        ? true
        : false
    >;
    const first = records[0];
    type _FirstIsRecord = Assert<typeof first extends TopicRecord<any, any> ? true : false>;
  },
  {
    batch: { maxRecords: 500, intervalSeconds: 10, minRecords: 50 },
    filter,
    onConsumeError: {
      callback: async (_ctx, event) => {
        type _BatchEvent = Assert<
          typeof event extends TopicConsumeErrorEvent<any, any> ? true : false
        >;
        return "halt";
      },
    },
  },
);

type _Unregister = Assert<IsEqual<typeof unregister, Unsubscribe>>;
type _BatchUnregister = Assert<
  IsEqual<typeof unregisterBatch, Unsubscribe>
>;
