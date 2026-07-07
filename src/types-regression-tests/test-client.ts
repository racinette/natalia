import { createWorkflowClient } from "../client";
import type { AnyPublicWorkflowHeader, WorkflowClient } from "../types";
import { MockStorageDriver, testDriver } from "./mock-storage-driver";

/** Construct a typed client for regression tests (requires explicit test driver). */
export function createTestWorkflowClient<
  TWfs extends Record<string, AnyPublicWorkflowHeader>,
>(
  workflows: TWfs,
  driver: MockStorageDriver = testDriver,
): WorkflowClient<TWfs, MockStorageDriver> {
  return createWorkflowClient(workflows, driver);
}
