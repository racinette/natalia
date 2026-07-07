import type { OperatorSession } from "../types";
import type { MockSessionRaw } from "./mock-storage-driver";
import { createMockSessionRaw } from "./mock-storage-driver";

/** Stand-in session for type-regression tests (no real I/O). */
export function mockSession(
  origin: "engine" | "adopted" = "engine",
): OperatorSession<MockSessionRaw, typeof origin> {
  return {
    capabilities: { atomic: true, isolated: true },
    origin,
    raw: createMockSessionRaw(),
  };
}

/** Shared session binding for regression suites. */
export const session = mockSession();
