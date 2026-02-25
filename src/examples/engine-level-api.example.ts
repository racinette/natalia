import type { WorkflowEngine } from "../engine";
import { campaignWorkflow } from "./campaign.example";
import { compensationHooksWorkflow } from "./compensation-hooks.example";
import { orderWorkflow } from "./order.example";

/**
 * Engine-level API showcase.
 *
 * Demonstrates how to manipulate workflows from the runtime side:
 * - engine lifecycle (`start`, `shutdown`, `runGarbageCollection`)
 * - workflow accessors (`start`, `execute`, `get`)
 * - handle APIs (`channels`, `streams`, `events`, `lifecycle`, `getResult`)
 * - operational controls (`sigterm`, `setRetention`)
 */
export async function engineLevelApiShowcase(
  engine: WorkflowEngine<{
    compensationHooks: typeof compensationHooksWorkflow;
    order: typeof orderWorkflow;
    campaign: typeof campaignWorkflow;
  }>,
): Promise<void> {
  await engine.start();

  // start + wait shortcut
  const quickOrder = await engine.workflows.order.execute({
    id: "order-quick-demo",
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
  await engine.workflows.campaign.execute({
    id: "campaign-with-metadata-demo",
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
  const handle = await engine.workflows.compensationHooks.start({
    id: "comp-hooks-demo",
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

  // lifecycle + user events
  await handle.lifecycle.started.wait({ signal: AbortSignal.timeout(15_000) });
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

  // get existing handle by id
  const sameHandle = engine.workflows.compensationHooks.get("comp-hooks-demo");

  // operational control
  await sameHandle.setRetention({ failed: 86400 * 14 });
  await sameHandle.sigterm();

  const finalResult = await sameHandle.getResult({
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

  await engine.runGarbageCollection(100);
  await engine.shutdown({ signal: AbortSignal.timeout(30_000) });
}
