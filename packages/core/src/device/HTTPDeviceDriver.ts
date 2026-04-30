/**
 * HTTP Device Driver
 *
 * Implements real device connection via HTTP/REST API.
 * Supports common IoT device REST APIs and custom endpoints.
 *
 * Usage:
 * ```typescript
 * const driver = new HTTPDeviceDriver({
 *   baseUrl: 'https://api.device.example.com',
 *   apiKey: 'your-api-key',
 *   timeout: 5000,
 * });
 *
 * const device = await driver.createDevice({
 *   id: 'smart-light-01',
 *   name: 'Living Room Light',
 *   type: DeviceType.ACTUATOR,
 *   endpoints: {
 *     state: '/devices/light-01/state',
 *     command: '/devices/light-01/command',
 *   },
 *   capabilities: [{ name: 'turn-on', type: 'write' }],
 * });
 * ```
 */

import { BaseDeviceDriver, DriverType } from './DeviceDriver.js';
import type { IDevice, DeviceConfig, DeviceTypeInfo, DeviceExecutionResult, SemanticCapability } from './IDevice.js';
import { DeviceStatus, DeviceType } from '@active-collaboration/shared';
import type { DeviceCapability, DeviceLocation, DeviceState, ConnectionInfo } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * HTTP connection options
 */
const logger = createLogger('HTTPDeviceDriver');

export interface HTTPConnectionOptions {
  /** Base URL for the API */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** Bearer token for authentication */
  bearerToken?: string;
  /** Basic auth credentials */
  basicAuth?: {
    username: string;
    password: string;
  };
  /** Custom headers */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Retry count on failure */
  retryCount?: number;
  /** Retry delay in milliseconds */
  retryDelay?: number;
  /** Use HTTPS (default: true) */
  secure?: boolean;
  /** Validate SSL certificate */
  validateCertificate?: boolean;
}

/**
 * HTTP device endpoints configuration
 */
export interface HTTPDeviceEndpoints {
  /** Endpoint to get device state */
  state?: string;
  /** Endpoint to send commands */
  command?: string;
  /** Endpoint for events/webhooks */
  events?: string;
  /** Endpoint for device info */
  info?: string;
  /** Endpoint for health check */
  health?: string;
  /** Custom endpoints */
  custom?: Record<string, string>;
}

/**
 * HTTP device configuration (extends base DeviceConfig)
 */
export interface HTTPDeviceConfig extends DeviceConfig {
  /** API endpoints for this device */
  endpoints: HTTPDeviceEndpoints;
  /** Poll interval for state updates (0 = no polling) */
  pollInterval?: number;
  /** Command HTTP method */
  commandMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** State HTTP method */
  stateMethod?: 'GET' | 'POST';
  /** Request body format */
  bodyFormat?: 'json' | 'form' | 'raw';
  /** Response data path (e.g., 'data.state') */
  responsePath?: string;
  /** Command payload template */
  commandTemplate?: Record<string, any>;
}

/**
 * HTTP Device - Real device connected via HTTP/REST API
 */
class HTTPDevice implements IDevice {
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
  private _config: HTTPDeviceConfig;
  private _connectionOptions: HTTPConnectionOptions;
  private _stateBuffer: any = {};
  private _stateHistory: any[] = [];
  private _pollTimer: NodeJS.Timeout | null = null;
  private _errorCount: number = 0;

  constructor(config: HTTPDeviceConfig, connectionOptions: HTTPConnectionOptions) {
    this.id = config.id || `http-${Date.now()}`;
    this.name = config.name;
    this.type = config.type as DeviceType;
    this.location = config.location as DeviceLocation;
    this.capabilities = config.capabilities;
    this.metadata = config.metadata || {};
    this._config = config;
    this._connectionOptions = connectionOptions;

    this.connectionInfo = {
      protocol: 'http',
      endpoint: config.endpoints.state || config.endpoints.info || 'unknown',
    };

    this._state = {
      current: { status: DeviceStatus.OFFLINE, message: 'Initializing...' },
      history: [],
    };

    // Start polling if configured
    if (config.pollInterval && config.pollInterval > 0) {
      this._startPolling();
    }

    // Initial state fetch
    this._fetchState().catch(err => {
      logger.error(`[HTTPDevice:${this.id}] Initial state fetch failed:`, err);
    });

    logger.info(`[HTTPDevice:${this.id}] Created with base URL: ${connectionOptions.baseUrl}`);
  }

  private _buildUrl(endpoint: string): string {
    const base = this._connectionOptions.baseUrl.replace(/\/$/, '');
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${base}${path}`;
  }

  private _buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...this._connectionOptions.headers,
    };

    if (this._connectionOptions.apiKey) {
      headers['X-API-Key'] = this._connectionOptions.apiKey;
    }

    if (this._connectionOptions.bearerToken) {
      headers['Authorization'] = `Bearer ${this._connectionOptions.bearerToken}`;
    }

    if (this._connectionOptions.basicAuth) {
      const credentials = Buffer.from(
        `${this._connectionOptions.basicAuth.username}:${this._connectionOptions.basicAuth.password}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }

    return headers;
  }

  private async _fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
    const timeout = this._connectionOptions.timeout || 5000;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        if (attempt === retries - 1) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, this._connectionOptions.retryDelay || 1000));
      }
    }

    throw new Error('Max retries exceeded');
  }

  private async _fetchState(): Promise<void> {
    if (!this._config.endpoints.state) {
      return;
    }

    try {
      const url = this._buildUrl(this._config.endpoints.state);
      const method = this._config.stateMethod || 'GET';

      const response = await this._fetchWithRetry(url, {
        method,
        headers: this._buildHeaders(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let data = await response.json();

      // Extract data from response path if specified
      if (this._config.responsePath) {
        const paths = this._config.responsePath.split('.');
        for (const path of paths) {
          data = data?.[path];
        }
      }

      // Update state
      this._stateBuffer = { ...this._stateBuffer, ...data };
      this._lastHeartbeat = new Date();
      this._status = DeviceStatus.ONLINE;
      this._errorCount = 0;

      // Update state history
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

      logger.info(`[HTTPDevice:${this.id}] State updated:`, data);
    } catch (error) {
      this._errorCount++;
      logger.error(`[HTTPDevice:${this.id}] Failed to fetch state:`, error);

      if (this._errorCount > 3) {
        this._status = DeviceStatus.OFFLINE;
      }
    }
  }

  private _startPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
    }

    this._pollTimer = setInterval(() => {
      this._fetchState().catch(err => {
        logger.error(`[HTTPDevice:${this.id}] Polling error:`, err);
      });
    }, this._config.pollInterval);

    logger.info(`[HTTPDevice:${this.id}] Started polling every ${this._config.pollInterval}ms`);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
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
    if (!this._config.endpoints.command) {
      return {
        success: false,
        error: 'No command endpoint configured',
        timestamp: new Date(),
      };
    }

    try {
      const url = this._buildUrl(this._config.endpoints.command);
      const method = this._config.commandMethod || 'POST';

      // Build request body
      let body: string;
      if (this._config.commandTemplate) {
        const payload = { ...this._config.commandTemplate };
        payload.command = commandName;
        if (params) {
          Object.assign(payload, params);
        }
        body = JSON.stringify(payload);
      } else {
        body = JSON.stringify({
          command: commandName,
          params: params || {},
          timestamp: new Date().toISOString(),
        });
      }

      const response = await this._fetchWithRetry(url, {
        method,
        headers: this._buildHeaders(),
        body,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      logger.info(`[HTTPDevice:${this.id}] Command "${commandName}" executed successfully`);

      // Refresh state after command
      if (this._config.pollInterval === 0) {
        await this._fetchState();
      }

      return {
        success: true,
        result,
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error(`[HTTPDevice:${this.id}] Command execution failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  getSemanticDescription(): string {
    return `${this.name} (HTTP Device - ${this.type}): Connected via HTTP API at ${this._connectionOptions.baseUrl}. ` +
      `Capabilities: ${this.capabilities.map(c => c.name).join(', ')}. ` +
      `Status: ${this._status}.`;
  }

  getSemanticCapabilities(): SemanticCapability[] {
    return this.capabilities.map(cap => ({
      name: cap.name,
      description: `HTTP device capability: ${cap.name}. Executed via ${this._config.endpoints.command || 'API'}`,
      parameters: cap.parameters?.map(p => ({
        name: p.name,
        type: (p.type === 'array' ? 'object' : p.type) as 'number' | 'string' | 'boolean' | 'object',
        required: p.required ?? true,
        description: p.description,
      })),
    }));
  }

  isAvailable(): boolean {
    return this._status === DeviceStatus.ONLINE;
  }

  getHealth(): { status: 'healthy' | 'degraded' | 'offline'; lastResponse?: number; errorCount: number } {
    const timeSinceHeartbeat = Date.now() - this._lastHeartbeat.getTime();
    const isStale = timeSinceHeartbeat > (this._config.pollInterval || 60000) * 2;

    return {
      status: this._status === DeviceStatus.ONLINE
        ? (isStale ? 'degraded' : 'healthy')
        : 'offline',
      lastResponse: this._lastHeartbeat.getTime(),
      errorCount: this._errorCount,
    };
  }

  /**
   * Make a custom HTTP request
   */
  async request(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET',
    body?: any
  ): Promise<any> {
    const url = this._buildUrl(endpoint);

    const response = await this._fetchWithRetry(url, {
      method,
      headers: this._buildHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this._stopPolling();
  }
}

/**
 * HTTP Device Driver
 *
 * Provides real device connectivity via HTTP/REST API.
 */
export class HTTPDeviceDriver extends BaseDeviceDriver {
  private _options: HTTPConnectionOptions;
  private _devices: Map<string, HTTPDevice> = new Map();

  constructor(options: HTTPConnectionOptions) {
    super(DriverType.REAL);
    this._options = {
      timeout: 5000,
      retryCount: 3,
      retryDelay: 1000,
      secure: true,
      validateCertificate: true,
      ...options,
    };
    logger.info(`Initialized with base URL: ${this._options.baseUrl}`);
  }

  /**
   * Connect/verify connection (HTTP is stateless, so just verify endpoint)
   */
  async connect(): Promise<void> {
    try {
      const response = await fetch(this._options.baseUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(this._options.timeout || 5000),
      });

      if (response.ok || response.status === 404) {
        // 404 is OK - means server is responding
        this._connected = true;
        logger.info(`Connection verified to ${this._options.baseUrl}`);
      } else {
        logger.warn(`Server returned ${response.status}`);
        this._connected = true; // Still allow operations
      }
    } catch (error) {
      logger.warn(`Connection check failed:`, error);
      // Still allow operations - server might be temporarily unavailable
      this._connected = true;
    }
  }

  /**
   * Disconnect (cleanup resources)
   */
  async disconnect(): Promise<void> {
    for (const device of this._devices.values()) {
      device.destroy();
    }
    this._devices.clear();
    this._connected = false;
    logger.info(`Disconnected`);
  }

  /**
   * Create a device from configuration
   */
  async createDevice(config: HTTPDeviceConfig): Promise<IDevice> {
    logger.info(`Creating device: ${config.name}`);

    const device = new HTTPDevice(config, this._options);
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
        description: 'HTTP sensor device - polls state from REST endpoint',
        defaultCapabilities: ['read-state'],
      },
      {
        type: DeviceType.ACTUATOR,
        category: 'actuator',
        description: 'HTTP actuator device - sends commands via REST endpoint',
        defaultCapabilities: ['execute-command'],
      },
      {
        type: DeviceType.CONTROLLER,
        category: 'controller',
        description: 'HTTP controller device - both polls state and sends commands',
        defaultCapabilities: ['read-state', 'execute-command'],
      },
    ];
  }

  /**
   * Make a raw HTTP request
   */
  async request(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET',
    body?: any
  ): Promise<any> {
    const url = `${this._options.baseUrl.replace(/\/$/, '')}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._options.headers,
    };

    if (this._options.apiKey) {
      headers['X-API-Key'] = this._options.apiKey;
    }
    if (this._options.bearerToken) {
      headers['Authorization'] = `Bearer ${this._options.bearerToken}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get device by ID
   */
  getDevice(deviceId: string): HTTPDevice | undefined {
    return this._devices.get(deviceId);
  }

  /**
   * Get all devices
   */
  getAllDevices(): HTTPDevice[] {
    return Array.from(this._devices.values());
  }
}
