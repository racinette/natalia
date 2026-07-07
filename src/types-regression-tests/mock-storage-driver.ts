import type {
  OperatorSession,
  SessionCapabilities,
  StorageDriver,
} from "../types/session";

declare const mockSessionRawBrand: unique symbol;

/** Opaque raw handle for type-regression tests only. */
export interface MockSessionRaw {
  readonly [mockSessionRawBrand]: true;
}

const defaultCapabilities: SessionCapabilities = {
  atomic: true,
  isolated: true,
};

/** Create a fresh mock raw handle (e.g. for {@link MockStorageDriver.adoptSession}). */
export function createMockSessionRaw(): MockSessionRaw {
  return { [mockSessionRawBrand]: true } as MockSessionRaw;
}

/** Reference {@link StorageDriver} for type-regression tests. Does not perform real I/O. */
export class MockStorageDriver implements StorageDriver<MockSessionRaw> {
  async session<R>(
    fn: (session: OperatorSession<MockSessionRaw, "engine">) => Promise<R>,
  ): Promise<R> {
    return fn({
      capabilities: defaultCapabilities,
      origin: "engine",
      raw: createMockSessionRaw(),
    });
  }

  adoptSession(raw: MockSessionRaw): OperatorSession<MockSessionRaw, "adopted"> {
    return {
      capabilities: defaultCapabilities,
      origin: "adopted",
      raw,
    };
  }
}

/** Shared instance for regression suites that construct a client. */
export const testDriver = new MockStorageDriver();
