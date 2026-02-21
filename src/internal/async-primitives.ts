type ReleaseFn = () => void;

interface Waiter {
  done: boolean;
  resolve: (release?: ReleaseFn) => void;
}

export class AsyncLock {
  private locked = false;
  private queue: Waiter[] = [];

  /**
   * Acquire the lock (never aborts)
   */
  acquire(): Promise<ReleaseFn>;

  /**
   * Acquire the lock with AbortSignal
   * @returns release fn if acquired, undefined if aborted
   */
  acquire(signal: AbortSignal): Promise<ReleaseFn | undefined>;

  acquire(signal?: AbortSignal): Promise<ReleaseFn | undefined> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(undefined);
        return;
      }

      const release = this.createRelease();

      // Fast path
      if (!this.locked) {
        this.locked = true;
        resolve(release);
        return;
      }

      const onAbort = () => {
        if (waiter.done) return;
        waiter.done = true;

        const idx = this.queue.indexOf(waiter);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }

        resolve(undefined);
      };

      const waiter: Waiter = {
        done: false,
        resolve: (r) => {
          if (waiter.done) return;
          waiter.done = true;
          // Clean up abort listener to prevent memory leak
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /**
   * Try to acquire without waiting
   * Respects FIFO fairness - will not jump ahead of waiting acquirers
   */
  tryAcquire(): ReleaseFn | undefined {
    if (this.locked || this.queue.length > 0) return undefined;
    this.locked = true;
    return this.createRelease();
  }

  /**
   * Execute a function while holding the lock
   */
  async withLock<T>(
    fn: () => Promise<T> | T,
    signal?: AbortSignal
  ): Promise<T | undefined> {
    const release = signal ? await this.acquire(signal) : await this.acquire();
    if (!release) return undefined;

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Acquire with timeout
   */
  async acquireWithTimeout(timeoutMs: number): Promise<ReleaseFn | undefined> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await this.acquire(controller.signal);
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Execute with lock + timeout
   */
  async withLockTimeout<T>(
    fn: () => Promise<T> | T,
    timeoutMs: number
  ): Promise<T | undefined> {
    const release = await this.acquireWithTimeout(timeoutMs);
    if (!release) return undefined;

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Observability
   */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Number of waiters in queue (best-effort, may include recently aborted waiters)
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  // ──────────────────────────────
  // Internal mechanics
  // ──────────────────────────────

  private createRelease(): ReleaseFn {
    let released = false;

    return () => {
      if (released) return;
      released = true;

      // Process queue until we find a non-aborted waiter or queue is empty
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;

        // Skip if waiter was aborted before we could process it
        if (next.done) {
          continue;
        }

        const release = this.createRelease();
        next.resolve(release);
        return;
      }

      // No waiters left, unlock
      this.locked = false;
    };
  }
}

export async function sleep(
  ms: number,
  signal?: AbortSignal
): Promise<boolean> {
  return new Promise((resolve) => {
    const cb = () => resolve(false);
    signal?.addEventListener("abort", cb, { once: true });
    setTimeout(() => {
      signal?.removeEventListener("abort", cb);
      resolve(true);
    }, ms);
  });
}
