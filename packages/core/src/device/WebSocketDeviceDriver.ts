/**
 * WebSocket Device Driver
 *
 * Implements real device connection via WebSocket protocol.
 * Supports real-time bidirectional communication with IoT devices.
 *
 * Usage:
 * ```typescript
 * const driver = new WebSocketDeviceDriver({
 *   url: 'wss://device.example.com/ws',
 *   apiKey: 'your-api-key',
 * });
 *
 * await driver.connect();
 *
 * const device = await driver.createDevice({
 *   id: 'realtime-sensor-01',
 *   name: 'Real-time Sensor',
 *   type: DeviceType.SENSOR,
 *   messageFormat: 'json',
 *   capabilities: [{ name: 'read-sensor', type: 'read' }],
 * });
 * ```
 */

import { BaseDeviceDriver, DriverType } from './DeviceDriver.js';
import type { IDevice, DeviceConfig, DeviceTypeInfo, DeviceExecutionResult, SemanticCapability } from './IDevice.js';
import { DeviceStatus, DeviceType } from '@active-collaboration/shared';
import type { DeviceCapability, DeviceLocation, DeviceState, ConnectionInfo } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * WebSocket connection options
 */
const logger = createLogger('WebSocketDeviceDriver');

export interface WebSocketConnectionOptions {
  /** WebSocket URL (e.g., wss://device.example.com/ws) */
  url: string;
  /** API key for authentication */
  apiKey?: string;
  /** Bearer token for authentication */
  bearerToken?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Connection timeout in milliseconds */
  connectTimeout?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect interval in milliseconds */
  reconnectInterval?: number;
  /** Max reconnect attempts */
  maxReconnectAttempts?: number;
  /** Ping interval in milliseconds (0 = disabled) */
  pingInterval?: number;
  /** Pong timeout in milliseconds */
  pongTimeout?: number;
}

/**
 * WebSocket device configuration
 */
export interface WebSocketDeviceConfig extends DeviceConfig {
  /** Message format */
  messageFormat?: 'json' | 'text' | 'binary';
  /** Message type field name */
  typeField?: string;
  /** Payload field name */
  payloadField?: string;
  /** Device ID field in messages */
  deviceIdField?: string;
  /** Command message type */
  commandType?: string;
  /** State message type */
  stateType?: string;
  /** Event message type */
  eventType?: string;
  /** Subscribe message to send on connect */
  subscribeMessage?: any;
  /** Heartbeat message to send periodically */
  heartbeatMessage?: any;
  /** Heartbeat interval in milliseconds */
  heartbeatInterval?: number;
}

/**
 * WebSocket message
 */
interface WebSocketMessage {
  type: string;
  payload?: any;
  timestamp?: string;
  deviceId?: string;
}

/**
 * WebSocket Device - Real device connected via WebSocket
 */
class WebSocketDevice implements IDevice {
  readonly id: string;
  readonly name: string;
  readonly type: DeviceType;
  readonly location: DeviceLocation;
  readonly capabilities: DeviceCapability[];
  readonly services: any[] = [];
  readonly metadata: Record<string, any>;
  readonly connectionInfo: ConnectionInfo;

  private _status: DeviceStatus = DeviceStatus.OFFLINE;
  private _state: DeviceState;
  private _lastHeartbeat: Date = new Date();
  private _config: WebSocketDeviceConfig;
  private _wsClient: any;
  private _stateBuffer: any = {};
  private _stateHistory: any[] = [];
  private _heartbeatTimer: NodeJS.Timeout | null = null;
  private _errorCount: number = 0;
  private _pendingCommands: Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }> = new Map();

  constructor(config: WebSocketDeviceConfig, wsClient: any) {
    this.id = config.id || `ws-${Date.now()}`;
    this.name = config.name;
    this.type = config.type as DeviceType;
    this.location = config.location as DeviceLocation;
    this.capabilities = config.capabilities;
    this.metadata = config.metadata || {};
    this._config = config;
    this._wsClient = wsClient;

    this.connectionInfo = {
      protocol: 'websocket',
      endpoint: 'ws-connection',
    };

    this._state = {
      current: { status: DeviceStatus.OFFLINE, message: 'Initializing...' },
      history: [],
    };

    this._setupMessageHandler();
    this._sendSubscribeMessage();
    this._startHeartbeat();

    logger.info(`[WebSocketDevice:${this.id}] Created`);
  }

  private _setupMessageHandler(): void {
    if (!this._wsClient) return;

    this._wsClient.on('message', (data: Buffer) => {
      this._handleMessage(data);
    });
  }

  private _handleMessage(data: Buffer): void {
    try {
      const format = this._config.messageFormat || 'json';
      let message: any;

      if (format === 'json') {
        message = JSON.parse(data.toString());
      } else if (format === 'text') {
        message = { type: 'text', payload: data.toString() };
      } else {
        message = { type: 'binary', payload: data };
      }

      const typeField = this._config.typeField || 'type';
      const payloadField = this._config.payloadField || 'payload';
      const deviceIdField = this._config.deviceIdField || 'deviceId';

      const messageType = message[typeField] || message.type;
      const messagePayload = message[payloadField] || message.payload;
      const messageDeviceId = message[deviceIdField] || message.deviceId;

      // Check if message is for this device
      if (messageDeviceId && messageDeviceId !== this.id) {
        return;
      }

      // Handle different message types
      const stateType = this._config.stateType || 'state';
      const eventType = this._config.eventType || 'event';
      const commandType = this._config.commandType || 'command_response';

      if (messageType === stateType) {
        this._updateState(messagePayload);
      } else if (messageType === eventType) {
        this._handleEvent(messagePayload);
      } else if (messageType === commandType || messageType === 'response') {
        this._handleCommandResponse(messagePayload);
      } else {
        // Unknown message type, treat as state update
        this._updateState(messagePayload);
      }

      this._lastHeartbeat = new Date();
      this._status = DeviceStatus.ONLINE;

    } catch (error) {
      logger.error(`[WebSocketDevice:${this.id}] Failed to parse message:`, error);
    }
  }

  private _updateState(data: any): void {
    this._stateBuffer = { ...this._stateBuffer, ...data };

    this._stateHistory.push({
      timestamp: new Date().toISOString(),
      data,
    });
    if (this._stateHistory.length > 100) {
      this._stateHistory.shift();
    }

    this._state = {
      current: {
        status: DeviceStatus.ONLINE,
        ...this._stateBuffer,
      },
      history: this._stateHistory.slice(-10),
    };

    logger.info(`[WebSocketDevice:${this.id}] State updated:`, data);
  }

  private _handleEvent(data: any): void {
    logger.info(`[WebSocketDevice:${this.id}] Event received:`, data);
    // Events are logged but don't change state directly
  }

  private _handleCommandResponse(data: any): void {
    const commandId = data.commandId || data.id;
    if (commandId && this._pendingCommands.has(commandId)) {
      const pending = this._pendingCommands.get(commandId)!;
      clearTimeout(pending.timeout);
      this._pendingCommands.delete(commandId);

      if (data.success || data.status === 'success') {
        pending.resolve(data);
      } else {
        pending.reject(new Error(data.error || data.message || 'Command failed'));
      }
    }
  }

  private _sendSubscribeMessage(): void {
    if (this._config.subscribeMessage && this._wsClient) {
      const message = typeof this._config.subscribeMessage === 'object'
        ? JSON.stringify(this._config.subscribeMessage)
        : String(this._config.subscribeMessage);

      this._wsClient.send(message);
      logger.info(`[WebSocketDevice:${this.id}] Sent subscribe message`);
    }
  }

  private _startHeartbeat(): void {
    if (!this._config.heartbeatMessage || !this._config.heartbeatInterval) {
      return;
    }

    this._heartbeatTimer = setInterval(() => {
      if (this._wsClient && this._wsClient.readyState === 1) { // WebSocket.OPEN
        const message = typeof this._config.heartbeatMessage === 'object'
          ? JSON.stringify(this._config.heartbeatMessage)
          : String(this._config.heartbeatMessage);

        this._wsClient.send(message);
      }
    }, this._config.heartbeatInterval);

    logger.info(`[WebSocketDevice:${this.id}] Started heartbeat every ${this._config.heartbeatInterval}ms`);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  get status(): DeviceStatus {
    return this._status;
  }

  get lastHeartbeat(): Date {
    return this._lastHeartbeat;
  }

  getState(): DeviceState {
    return this._state;
  }

  async executeCommand(commandName: string, params?: any): Promise<DeviceExecutionResult> {
    if (!this._wsClient || this._wsClient.readyState !== 1) {
      return {
        success: false,
        error: 'WebSocket not connected',
        timestamp: new Date(),
      };
    }

    try {
      const commandId = `${commandName}-${Date.now()}`;

      const message: any = {
        type: this._config.commandType || 'command',
        commandId,
        command: commandName,
        params: params || {},
        timestamp: new Date().toISOString(),
        deviceId: this.id,
      };

      // Create promise for response
      const responsePromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._pendingCommands.delete(commandId);
          reject(new Error('Command timeout'));
        }, 10000); // 10 second timeout

        this._pendingCommands.set(commandId, { resolve, reject, timeout });
      });

      // Send command
      const messageStr = JSON.stringify(message);
      this._wsClient.send(messageStr);

      logger.info(`[WebSocketDevice:${this.id}] Command "${commandName}" sent`);

      // Wait for response
      const response = await responsePromise;

      return {
        success: true,
        result: response,
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error(`[WebSocketDevice:${this.id}] Command failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  getSemanticDescription(): string {
    return `${this.name} (WebSocket Device - ${this.type}): Real-time connected via WebSocket. ` +
      `Capabilities: ${this.capabilities.map(c => c.name).join(', ')}. ` +
      `Status: ${this._status}.`;
  }

  getSemanticCapabilities(): SemanticCapability[] {
    return this.capabilities.map(cap => ({
      name: cap.name,
      description: `WebSocket device capability: ${cap.name}. Real-time execution via WebSocket.`,
      parameters: cap.parameters?.map(p => ({
        name: p.name,
        type: (p.type === 'array' ? 'object' : p.type) as 'number' | 'string' | 'boolean' | 'object',
        required: p.required ?? true,
        description: p.description,
      })),
    }));
  }

  isAvailable(): boolean {
    return this._status === DeviceStatus.ONLINE && this._wsClient?.readyState === 1;
  }

  getHealth(): { status: 'healthy' | 'degraded' | 'offline'; lastResponse?: number; errorCount: number } {
    const timeSinceHeartbeat = Date.now() - this._lastHeartbeat.getTime();
    const isStale = timeSinceHeartbeat > 30000; // 30 seconds

    return {
      status: this.isAvailable()
        ? (isStale ? 'degraded' : 'healthy')
        : 'offline',
      lastResponse: this._lastHeartbeat.getTime(),
      errorCount: this._errorCount,
    };
  }

  /**
   * Send raw message
   */
  async send(message: any): Promise<boolean> {
    if (!this._wsClient || this._wsClient.readyState !== 1) {
      return false;
    }

    try {
      const messageStr = typeof message === 'object' ? JSON.stringify(message) : String(message);
      this._wsClient.send(messageStr);
      return true;
    } catch (error) {
      logger.error(`[WebSocketDevice:${this.id}] Send failed:`, error);
      return false;
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this._stopHeartbeat();
    this._pendingCommands.forEach(pending => {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Device destroyed'));
    });
    this._pendingCommands.clear();
  }
}

/**
 * WebSocket Device Driver
 *
 * Provides real device connectivity via WebSocket protocol.
 */
export class WebSocketDeviceDriver extends BaseDeviceDriver {
  private _options: WebSocketConnectionOptions;
  private _ws: any = null;
  private _WebSocket: any = null;
  private _devices: Map<string, WebSocketDevice> = new Map();
  private _reconnectAttempts: number = 0;
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _pingTimer: NodeJS.Timeout | null = null;

  constructor(options: WebSocketConnectionOptions) {
    super(DriverType.REAL);
    this._options = {
      connectTimeout: 10000,
      autoReconnect: true,
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      pingInterval: 30000,
      pongTimeout: 5000,
      ...options,
    };
    logger.info(`Initialized for URL: ${this._options.url}`);
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    try {
      // Dynamic import of ws library
      this._WebSocket = (await import('ws')).default || (await import('ws'));

      logger.info(`Connecting to ${this._options.url}...`);

      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
          ...this._options.headers,
        };

        if (this._options.apiKey) {
          headers['X-API-Key'] = this._options.apiKey;
        }
        if (this._options.bearerToken) {
          headers['Authorization'] = `Bearer ${this._options.bearerToken}`;
        }

        this._ws = new this._WebSocket(this._options.url, { headers });

        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
          this._ws.terminate();
        }, this._options.connectTimeout);

        this._ws.on('open', () => {
          clearTimeout(timeout);
          logger.info(`Connected to ${this._options.url}`);
          this._connected = true;
          this._reconnectAttempts = 0;
          this._setupEventHandlers();
          this._startPing();
          resolve();
        });

        this._ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          logger.error(`Connection error:`, err);
          if (!this._connected) {
            reject(err);
          }
        });

        this._ws.on('close', () => {
          logger.info(`Connection closed`);
          this._connected = false;
          this._stopPing();
          this._handleReconnect();
        });
      });
    } catch (error) {
      logger.error(`Failed to load ws library:`, error);
      throw new Error('WebSocket library not installed. Run: npm install ws');
    }
  }

  private _setupEventHandlers(): void {
    if (!this._ws) return;

    this._ws.on('message', (data: Buffer) => {
      // Route messages to devices
      try {
        const message = JSON.parse(data.toString());
        const deviceId = message.deviceId || message.id;

        if (deviceId && this._devices.has(deviceId)) {
          // Message will be handled by device
        } else {
          // Broadcast to all devices
          for (const device of this._devices.values()) {
            // Device will filter by ID if needed
          }
        }
      } catch (error) {
        logger.error(`Failed to parse message:`, error);
      }
    });

    this._ws.on('pong', () => {
      logger.info(`Received pong`);
    });
  }

  private _handleReconnect(): void {
    if (!this._options.autoReconnect) {
      return;
    }

    if (this._reconnectAttempts >= (this._options.maxReconnectAttempts || 10)) {
      logger.error(`Max reconnect attempts reached`);
      return;
    }

    this._reconnectAttempts++;
    logger.info(`Reconnecting in ${this._options.reconnectInterval}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(() => {
      this.connect().catch(err => {
        logger.error(`Reconnect failed:`, err);
      });
    }, this._options.reconnectInterval);
  }

  private _startPing(): void {
    if (!this._options.pingInterval || this._options.pingInterval === 0) {
      return;
    }

    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) {
        this._ws.ping();
      }
    }, this._options.pingInterval);
  }

  private _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  async disconnect(): Promise<void> {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._stopPing();

    for (const device of this._devices.values()) {
      device.destroy();
    }
    this._devices.clear();

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._connected = false;
    logger.info(`Disconnected`);
  }

  /**
   * Create a device from configuration
   */
  async createDevice(config: WebSocketDeviceConfig): Promise<IDevice> {
    if (!this._connected || !this._ws) {
      throw new Error('WebSocket driver not connected. Call connect() first.');
    }

    logger.info(`Creating device: ${config.name}`);

    const device = new WebSocketDevice(config, this._ws);
    this._devices.set(device.id, device);

    return device;
  }

  /**
   * Get supported device types
   */
  getSupportedTypes(): DeviceTypeInfo[] {
    return [
      {
        type: DeviceType.SENSOR,
        category: 'sensor',
        description: 'WebSocket sensor device - receives real-time state updates',
        defaultCapabilities: ['read-state'],
      },
      {
        type: DeviceType.ACTUATOR,
        category: 'actuator',
        description: 'WebSocket actuator device - sends commands in real-time',
        defaultCapabilities: ['execute-command'],
      },
      {
        type: DeviceType.CONTROLLER,
        category: 'controller',
        description: 'WebSocket controller device - bidirectional real-time communication',
        defaultCapabilities: ['read-state', 'execute-command'],
      },
    ];
  }

  /**
   * Send raw message
   */
  async send(message: any): Promise<void> {
    if (!this._ws || this._ws.readyState !== 1) {
      throw new Error('WebSocket not connected');
    }

    const messageStr = typeof message === 'object' ? JSON.stringify(message) : String(message);
    this._ws.send(messageStr);
  }

  /**
   * Get device by ID
   */
  getDevice(deviceId: string): WebSocketDevice | undefined {
    return this._devices.get(deviceId);
  }

  /**
   * Get all devices
   */
  getAllDevices(): WebSocketDevice[] {
    return Array.from(this._devices.values());
  }
}
