import type { Pool, PoolClient, Notification } from 'pg';
import { EventEmitter } from 'events';
import { sleep, createDeferred, type Deferred } from './utils';

// =============================================================================
// TYPES
// =============================================================================

export interface NotificationPayload {
  workflowId: string;
  payload: string;
  raw: string;
  channel: string;
}

export type NotificationChannel =
  | 'workflow_pending'
  | 'workflow_status'
  | 'channel'
  | 'event'
  | 'stream';

// =============================================================================
// NOTIFICATIONS MANAGER
// =============================================================================

/**
 * Manages PostgreSQL LISTEN/NOTIFY with polling fallback
 *
 * PG notifications are not 100% reliable - they can be dropped if:
 * - The server's notification queue fills up
 * - The connection is interrupted
 *
 * To handle this, we:
 * 1. Register callback before checking DB (to avoid race)
 * 2. Check DB immediately
 * 3. Wait for notification OR poll timeout
 * 4. On poll timeout, check DB again
 */
export class NotificationsManager extends EventEmitter {
  private listenClient: PoolClient | null = null;
  private isConnected = false;
  private isShuttingDown = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  // Polling intervals (fallback for dropped notifications)
  private readonly channelPollIntervalMs: number;
  private readonly eventPollIntervalMs: number;
  private readonly workflowPollIntervalMs: number;

  // Full channel names
  private readonly channels: string[];

  constructor(
    private readonly pool: Pool,
    private readonly schemaName: string,
    options?: {
      channelPollIntervalMs?: number;
      eventPollIntervalMs?: number;
      workflowPollIntervalMs?: number;
    },
  ) {
    super();
    this.setMaxListeners(1000); // Support many concurrent waiters

    this.channelPollIntervalMs = options?.channelPollIntervalMs ?? 1000;
    this.eventPollIntervalMs = options?.eventPollIntervalMs ?? 5000;
    this.workflowPollIntervalMs = options?.workflowPollIntervalMs ?? 1000;

    this.channels = [
      `${schemaName}_workflow_pending`,
      `${schemaName}_workflow_status`,
      `${schemaName}_channel`,
      `${schemaName}_event`,
      `${schemaName}_stream`,
    ];
  }

  /**
   * Start listening for notifications
   */
  async start(): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('NotificationsManager is shutting down');
    }
    await this.connect();
  }

  /**
   * Stop listening for notifications
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.listenClient) {
      try {
        // Unlisten from all channels
        for (const channel of this.channels) {
          await this.listenClient.query(`UNLISTEN ${channel}`);
        }
      } catch {
        // Ignore errors during shutdown
      }
      this.listenClient.release();
      this.listenClient = null;
    }

    this.isConnected = false;
    this.removeAllListeners();
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }

  // ===========================================================================
  // INTERNAL: Connection Management
  // ===========================================================================

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      this.listenClient = await this.pool.connect();

      // Subscribe to all channels
      for (const channel of this.channels) {
        await this.listenClient.query(`LISTEN ${channel}`);
      }

      // Set up notification handler
      this.listenClient.on('notification', this.handleNotification.bind(this));
      this.listenClient.on('error', this.handleConnectionError.bind(this));

      this.isConnected = true;
      this.emit('connected');
    } catch (err) {
      this.emit('error', err);
      this.scheduleReconnect();
    }
  }

  private handleNotification(msg: Notification): void {
    if (!msg.payload) return;

    // Parse payload: "workflowId::rest"
    const [workflowId, ...rest] = msg.payload.split('::');

    const payload: NotificationPayload = {
      workflowId,
      payload: rest.join('::'),
      raw: msg.payload,
      channel: msg.channel,
    };

    // Emit on the full channel name
    this.emit(msg.channel, payload);

    // Also emit on a normalized channel type for easier subscription
    const channelType = this.getChannelType(msg.channel);
    if (channelType) {
      this.emit(channelType, payload);
    }
  }

  private handleConnectionError(err: Error): void {
    this.emit('error', err);
    this.isConnected = false;

    if (this.listenClient) {
      this.listenClient.release();
      this.listenClient = null;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimeout) return;

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.connect();
      } catch {
        // Will retry via scheduleReconnect in connect()
      }
    }, 1000);
  }

  private getChannelType(channel: string): NotificationChannel | null {
    if (channel.endsWith('_workflow_pending')) return 'workflow_pending';
    if (channel.endsWith('_workflow_status')) return 'workflow_status';
    if (channel.endsWith('_channel')) return 'channel';
    if (channel.endsWith('_event')) return 'event';
    if (channel.endsWith('_stream')) return 'stream';
    return null;
  }

  private getPollInterval(channelType: NotificationChannel): number {
    switch (channelType) {
      case 'channel':
        return this.channelPollIntervalMs;
      case 'event':
        return this.eventPollIntervalMs;
      case 'workflow_pending':
      case 'workflow_status':
      case 'stream':
        return this.workflowPollIntervalMs;
    }
  }

  // ===========================================================================
  // PUBLIC: Wait for Notifications
  // ===========================================================================

  /**
   * Wait for a notification matching the predicate, with polling fallback
   *
   * Pattern:
   * 1. Register notification callback (before DB check to avoid race)
   * 2. Check DB immediately
   * 3. If found, return result
   * 4. Wait for notification OR poll timeout
   * 5. On notification or timeout, check DB again
   * 6. Repeat until found or overall timeout
   *
   * @param channelType - The type of channel to listen on
   * @param predicate - Function to filter notifications (receives payload)
   * @param checkDb - Function to check database (returns result or null)
   * @param timeoutMs - Overall timeout in milliseconds
   * @returns The result from checkDb, or null on timeout
   */
  async waitFor<T>(
    channelType: NotificationChannel,
    predicate: (payload: NotificationPayload) => boolean,
    checkDb: () => Promise<T | null>,
    timeoutMs: number,
  ): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = this.getPollInterval(channelType);
    const fullChannel = `${this.schemaName}_${channelType}`;

    // Track if we've resolved
    let resolved = false;
    let result: T | null = null;

    // Deferred for notification-based wakeup
    let wakeup: Deferred<void> | null = null;

    // Notification handler
    const onNotification = (payload: NotificationPayload) => {
      if (resolved) return;
      if (!predicate(payload)) return;

      // Wake up the poll loop
      wakeup?.resolve();
    };

    // Register listener BEFORE checking DB (critical for avoiding races)
    this.on(fullChannel, onNotification);

    try {
      while (!resolved) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break; // Timeout
        }

        // Check database
        result = await checkDb();
        if (result !== null) {
          resolved = true;
          break;
        }

        // Wait for notification or poll timeout
        const waitTime = Math.min(pollInterval, remaining);
        wakeup = createDeferred();

        const timeout = setTimeout(() => wakeup?.resolve(), waitTime);
        await wakeup.promise;
        clearTimeout(timeout);
      }

      return result;
    } finally {
      this.removeListener(fullChannel, onNotification);
    }
  }

  /**
   * Wait for any notification on a channel (simpler API for workflow pending)
   */
  async waitForAny(
    channelType: NotificationChannel,
    timeoutMs: number,
  ): Promise<NotificationPayload | null> {
    const deadline = Date.now() + timeoutMs;
    const fullChannel = `${this.schemaName}_${channelType}`;

    return new Promise((resolve) => {
      let resolved = false;
      let timeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        this.removeListener(fullChannel, onNotification);
      };

      const onNotification = (payload: NotificationPayload) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(payload);
      };

      const onTimeout = () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(null);
      };

      this.on(fullChannel, onNotification);

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        onTimeout();
      } else {
        timeout = setTimeout(onTimeout, remaining);
      }
    });
  }

  /**
   * Wait for a specific workflow to reach a status
   */
  async waitForWorkflowStatus(
    workflowId: string,
    statuses: string[],
    checkDb: () => Promise<string | null>,
    timeoutMs: number,
  ): Promise<string | null> {
    return this.waitFor(
      'workflow_status',
      (payload) => {
        if (payload.workflowId !== workflowId) return false;
        return statuses.includes(payload.payload);
      },
      checkDb,
      timeoutMs,
    );
  }

  /**
   * Wait for a channel message
   */
  async waitForChannelMessage<T>(
    workflowId: string,
    channelName: string,
    checkDb: () => Promise<T | null>,
    timeoutMs: number,
  ): Promise<T | null> {
    return this.waitFor(
      'channel',
      (payload) => {
        if (payload.workflowId !== workflowId) return false;
        return payload.payload === channelName;
      },
      checkDb,
      timeoutMs,
    );
  }

  /**
   * Wait for an event to be set
   */
  async waitForEvent(
    workflowId: string,
    eventName: string,
    checkDb: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> {
    const result = await this.waitFor(
      'event',
      (payload) => {
        if (payload.workflowId !== workflowId) return false;
        return payload.payload === eventName;
      },
      async () => {
        const isSet = await checkDb();
        return isSet ? true : null;
      },
      timeoutMs,
    );
    return result ?? false;
  }

  /**
   * Wait for a stream record at a specific offset
   */
  async waitForStreamRecord<T>(
    workflowId: string,
    streamName: string,
    offset: number,
    checkDb: () => Promise<T | null>,
    timeoutMs: number,
  ): Promise<T | null> {
    return this.waitFor(
      'stream',
      (payload) => {
        if (payload.workflowId !== workflowId) return false;
        const [name, offsetStr] = payload.payload.split('::');
        if (name !== streamName) return false;
        const recordOffset = parseInt(offsetStr, 10);
        // Notify on this or any later offset
        return recordOffset >= offset;
      },
      checkDb,
      timeoutMs,
    );
  }
}
