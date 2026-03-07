import type { WorkflowClient } from "../types";
import { campaignWorkflow } from "./campaign.example";
import { compensationHooksWorkflow } from "./compensation-hooks.example";
import { orderWorkflow } from "./order.example";

/**
 * Client API showcase.
 *
 * Demonstrates client-facing workflow access:
 * - workflow accessors (`start`, `execute`, `get`)
 * - handle APIs (`channels`, `streams`, `events`, `execution`, `compensation`)
 * - operational controls (`sigterm`, `setRetention`)
 */
export async function clientApiShowcase(
  client: WorkflowClient<{
    compensationHooks: typeof compensationHooksWorkflow;
    order: typeof orderWorkflow;
    campaign: typeof campaignWorkflow;
  }>,
): Promise<void> {
  // start + wait shortcut
  const quickOrder = await client.workflows.order.execute({
    idempotencyKey: "order-quick-demo",
    seed: "order-quick-seed-v1",
    deadlineSeconds: 300,
    args: {
      destination: "Paris",
      checkIn: "2027-01-10",
      checkOut: "2027-01-14",
      customerId: "cust-123",
      customerEmail: "customer@example.com",
    },
  });

  if (!quickOrder.ok && quickOrder.status === "failed") {
    console.error("Order failed:", quickOrder.error.message);
  }

  // metadata is optional but strongly typed when schema is defined
  await client.workflows.campaign.execute({
    idempotencyKey: "campaign-with-metadata-demo",
    metadata: {
      tenantId: "tenant-acme",
      correlationId: "req-42",
    },
    args: {
      userId: "cust-123",
      candidates: ["user-a", "user-b", "user-c"],
    },
  });

  // start + handle manipulation
  const handle = await client.workflows.compensationHooks.start({
    idempotencyKey: "comp-hooks-demo",
    seed: "comp-hooks-seed-v1",
    deadlineSeconds: 600,
    args: {
      destination: "Paris",
      checkIn: "2027-02-01",
      checkOut: "2027-02-05",
      customerId: "cust-456",
      notificationEmail: "ops@example.com",
    },
    retention: {
      complete: 86400,
      failed: 86400 * 7,
      terminated: 86400,
    },
  });

  // channel sends
  await handle.channels.compAck.send({ type: "ack" });
  await handle.channels.operatorResolution.send({
    action: "confirm_resolved",
    note: "Operator verified manual rollback externally.",
  });

  // phase lifecycle + user events
  await handle.execution.lifecycle.started.wait({
    signal: AbortSignal.timeout(15_000),
  });
  await handle.events.compensationStarted.wait({
    signal: AbortSignal.timeout(120_000),
  });

  // stream reads: direct accessor async-iteration
  for await (const entry of handle.streams.compLog) {
    console.log("Stream accessor entry:", entry.msg);
    break;
  }

  // stream reads: iterator async-iteration
  const iter = handle.streams.compLog.iterator(0);
  for await (const entry of iter) {
    console.log("Stream iterator entry:", entry.msg);
    break;
  }

  // get existing handle by idempotency key
  const sameHandle = client.workflows.compensationHooks.get("comp-hooks-demo");

  // operational control
  await sameHandle.setRetention({ failed: 86400 * 14 });
  await sameHandle.sigterm();

  const finalResult = await sameHandle.execution.wait({
    signal: AbortSignal.timeout(180_000),
  });
  if (!finalResult.ok && finalResult.status === "failed") {
    console.error(
      "Compensation hooks workflow failed:",
      finalResult.error.message,
    );
  } else if (!finalResult.ok && finalResult.status === "terminated") {
    console.error(
      "Compensation hooks workflow terminated:",
      finalResult.reason,
    );
  }

  const compensationResult = await sameHandle.compensation.wait({
    signal: AbortSignal.timeout(180_000),
  });
  if (!compensationResult.ok && compensationResult.status === "failed") {
    console.error(
      "Compensation phase failed:",
      compensationResult.error.message,
    );
  } else if (
    !compensationResult.ok &&
    compensationResult.status === "terminated"
  ) {
    console.error("Compensation phase terminated:", compensationResult.reason);
  }
}

/**
 * @deprecated Use `clientApiShowcase`.
 */
export const engineLevelApiShowcase = clientApiShowcase;
