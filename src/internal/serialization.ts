// =============================================================================
// ERROR SERIALIZATION
// =============================================================================

/**
 * Serialized error structure for JSONB storage
 */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SerializedError;
}

/**
 * Serialize an error for storage in JSONB
 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };

    if (error.stack) {
      serialized.stack = error.stack;
    }

    if ('code' in error && typeof error.code === 'string') {
      serialized.code = error.code;
    }

    if (error.cause) {
      serialized.cause = serializeError(error.cause);
    }

    return serialized;
  }

  if (typeof error === 'string') {
    return {
      name: 'Error',
      message: error,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

/**
 * Custom error class that preserves serialized error data
 */
export class DeserializedError extends Error {
  readonly originalName: string;
  readonly code?: string;

  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = serialized.name;
    this.originalName = serialized.name;
    this.code = serialized.code;

    if (serialized.stack) {
      this.stack = serialized.stack;
    }

    if (serialized.cause) {
      this.cause = deserializeError(serialized.cause);
    }
  }
}

/**
 * Deserialize an error from JSONB storage
 */
export function deserializeError(serialized: SerializedError): Error {
  return new DeserializedError(serialized);
}
