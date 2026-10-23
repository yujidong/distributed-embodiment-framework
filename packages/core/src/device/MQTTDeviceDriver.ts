/**
 * MQTT Device Driver
 *
 * Implements real device connection via MQTT protocol.
 * Supports MQTT 3.1.1 and 5.0 brokers.
 *
 * Usage:
 * ```typescript
 * const driver = new MQTTDeviceDriver({
 *   brokerUrl: 'mqtt://broker.example.com:1883',
 *   username: 'user',
 *   password: 'pass',
 *   clientId: 'ac-platform-client',
 * });
 *
 * await driver.connect();
 *
 * const device = await driver.createDevice({
 *   id: 'temp-sensor-01',
 *   name: 'Living Room Temperature',
 *   type: DeviceType.SENSOR,
 *   topicPrefix: 'home/livingroom/temperature',
 *   capabilities: [{ name: 'read-temperature', type: 'read' }],
 * });
 * ```
 */

import { BaseDeviceDriver, DriverType } from './DeviceDriver.js';
import type { IDevice, DeviceConfig, DeviceTypeInfo, DeviceExecutionResult, SemanticCapability } from './IDevice.js';
import { DeviceStatus, DeviceType } from '@active-collaboration/shared';
import type { DeviceCapability, DeviceLocation, DeviceState, ConnectionInfo } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * MQTT connection options
 */
const logger = createLogger('MQTTDeviceDriver');

export interface MQTTConnectionOptions {
  /** MQTT broker URL (e.g., mqtt://broker.example.com:1883) */
  brokerUrl: string;
  /** Username for authentication */
  username?: string;
  /** Password for authentication */
  password?: string;
  /** Client ID (auto-generated if not provided) */
  clientId?: string;
  /** Keep alive interval in seconds */
  keepalive?: number;
  /** Clean session flag */
  clean?: boolean;
  /** Auto-reconnect on disconnect */
  reconnect?: boolean;
  /** Reconnect interval in milliseconds */
  reconnectPeriod?: number;
  /** Connection timeout in milliseconds */
  connectTimeout?: number;
  /** Use TLS/SSL */
  secure?: boolean;
  /** CA certificate (for TLS) */
  ca?: Buffer | string;
  /** Client certificate (for TLS) */
  cert?: Buffer | string;
  /** Client key (for TLS) */
  key?: Buffer | string;
}

/**
 * MQTT device configuration (extends base DeviceConfig)
 */
export interface MQTTDeviceConfig extends DeviceConfig {
  /** MQTT topic prefix for this device */
  topicPrefix: string;
  /** Command topic suffix (default: 'command') */
  commandTopic?: string;
  /** State topic suffix (default: 'state') */
  stateTopic?: string;
  /** Event topic suffix (default: 'event') */
  eventTopic?: string;
  /** QoS level (0, 1, or 2) */
  qos?: 0 | 1 | 2;
  /** Retain messages */
  retain?: boolean;
  /** Message format */
  format?: 'json' | 'string' | 'binary';
  /** Command mapping (command name -> MQTT payload template) */
  commandMapping?: Record<string, any>;
}

/**
 * MQTT message handler
 */
interface MessageHandler {
  topic: string;
  callback: (topic: string, payload: Buffer) => void;
}

/**
 * MQTT Device - Real device connected via MQTT
 */
class MQTTDevice implements IDevice {
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
  private _config: MQTTDeviceConfig;
  private _mqttClient: any;
  private _topicPrefix: string;
  private _stateBuffer: any = {};
  private _stateHistory: any[] = [];
  private _messageHandlers: MessageHandler[] = [];

  constructor(config: MQTTDeviceConfig, mqttClient: any) {
    this.id = config.id || `mqtt-${Date.now()}`;
    this.name = config.name;
    this.type = config.type as DeviceType;
    this.location = config.location as DeviceLocation;
    this.capabilities = config.capabilities;
    this.metadata = config.metadata || {};
    this._config = config;
    this._mqttClient = mqttClient;
    this._topicPrefix = config.topicPrefix;

    this.connectionInfo = {
      protocol: 'mqtt',
      endpoint: `${config.topicPrefix}`,
    };

    this._state = {
      current: { status: DeviceStatus.OFFLINE, message: 'Initializing...' },
      history: [],
    };

    this._setupSubscriptions();
    logger.info(`[MQTTDevice:${this.id}] Created with topic prefix: ${this._topicPrefix}`);
  }

  private _setupSubscriptions(): void {
    if (!this._mqttClient || !this._mqttClient.connected) {
      logger.info(`[MQTTDevice:${this.id}] MQTT client not connected, will subscribe when available`);
      return;
    }

    const stateTopic = `${this._topicPrefix}/${this._config.stateTopic || 'state'}`;
    const eventTopic = `${this._topicPrefix}/${this._config.eventTopic || 'event'}`;

    // Subscribe to state updates
    this._mqttClient.subscribe(stateTopic, { qos: this._config.qos || 1 }, (err: Error | null) => {
      if (err) {
        logger.error(`[MQTTDevice:${this.id}] Failed to subscribe to ${stateTopic}:`, err);
      } else {
        logger.info(`[MQTTDevice:${this.id}] Subscribed to ${stateTopic}`);
        this._status = DeviceStatus.ONLINE;
      }
    });

    // Subscribe to events
    this._mqttClient.subscribe(eventTopic, { qos: this._config.qos || 1 }, (err: Error | null) => {
      if (err) {
        logger.error(`[MQTTDevice:${this.id}] Failed to subscribe to ${eventTopic}:`, err);
      } else {
        logger.info(`[MQTTDevice:${this.id}] Subscribed to ${eventTopic}`);
      }
    });

    // Set up message handler
    this._mqttClient.on('message', (topic: string, payload: Buffer) => {
      this._handleMessage(topic, payload);
    });
  }

  private _handleMessage(topic: string, payload: Buffer): void {
    try {
      const format = this._config.format || 'json';
      let data: any;

      if (format === 'json') {
        data = JSON.parse(payload.toString());
      } else if (format === 'string') {
        data = payload.toString();
      } else {
        data = payload;
      }

      // Update state buffer
      this._stateBuffer = { ...this._stateBuffer, ...data };
      this._lastHeartbeat = new Date();

      // Add to history (keep last 100 entries)
      this._stateHistory.push({
        timestamp: new Date().toISOString(),
        topic,
        data,
      });
      if (this._stateHistory.length > 100) {
        this._stateHistory.shift();
      }

      // Update device state
      this._state = {
        current: {
          status: DeviceStatus.ONLINE,
          ...this._stateBuffer,
        },
        history: this._stateHistory.slice(-10),
      };

      logger.info(`[MQTTDevice:${this.id}] Received message on ${topic}:`, data);
    } catch (error) {
      logger.error(`[MQTTDevice:${this.id}] Failed to parse message:`, error);
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
    const commandTopic = `${this._topicPrefix}/${this._config.commandTopic || 'command'}`;

    try {
      // Build command payload
      let payload: any;

      if (this._config.commandMapping && this._config.commandMapping[commandName]) {
        // Use custom command mapping
        payload = this._config.commandMapping[commandName];
        if (params) {
          // Replace placeholders with actual values
          const payloadStr = JSON.stringify(payload);
          Object.keys(params).forEach(key => {
            payloadStr.replace(`{{${key}}}`, params[key]);
          });
          payload = JSON.parse(payloadStr);
        }
      } else {
        // Default command format
        payload = {
          command: commandName,
          params: params || {},
          timestamp: new Date().toISOString(),
        };
      }

      const payloadStr = this._config.format === 'json'
        ? JSON.stringify(payload)
        : String(payload);

      // Publish command
      return new Promise((resolve) => {
        this._mqttClient.publish(
          commandTopic,
          payloadStr,
          { qos: this._config.qos || 1, retain: this._config.retain || false },
          (err: Error | null) => {
            if (err) {
              logger.error(`[MQTTDevice:${this.id}] Failed to publish command:`, err);
              resolve({
                success: false,
                error: `Failed to publish command: ${err.message}`,
                timestamp: new Date(),
              });
            } else {
              logger.info(`[MQTTDevice:${this.id}] Command "${commandName}" published to ${commandTopic}`);
              resolve({
                success: true,
                result: { command: commandName, params, published: true },
                timestamp: new Date(),
              });
            }
          }
        );
      });
    } catch (error) {
      logger.error(`[MQTTDevice:${this.id}] Command execution failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };
    }
  }

  getSemanticDescription(): string {
    return `${this.name} (MQTT Device - ${this.type}): Connected via MQTT at ${this._topicPrefix}. ` +
      `Capabilities: ${this.capabilities.map(c => c.name).join(', ')}. ` +
      `Status: ${this._status}.`;
  }

  getSemanticCapabilities(): SemanticCapability[] {
    return this.capabilities.map(cap => ({
      name: cap.name,
      description: `MQTT device capability: ${cap.name}. Executed via topic ${this._topicPrefix}/command`,
      parameters: cap.parameters?.map(p => ({
        name: p.name,
        type: (p.type === 'array' ? 'object' : p.type) as 'number' | 'string' | 'boolean' | 'object',
        required: p.required ?? true,
        description: p.description,
      })),
    }));
  }

  isAvailable(): boolean {
    return this._status === DeviceStatus.ONLINE && this._mqttClient?.connected;
  }

  getHealth(): { status: 'healthy' | 'degraded' | 'offline'; lastResponse?: number; errorCount: number } {
    const timeSinceHeartbeat = Date.now() - this._lastHeartbeat.getTime();
    const isStale = timeSinceHeartbeat > 60000; // 1 minute

    return {
      status: this._mqttClient?.connected
        ? (isStale ? 'degraded' : 'healthy')
        : 'offline',
      lastResponse: this._lastHeartbeat.getTime(),
      errorCount: 0,
    };
  }

  /**
   * Publish a raw message to a custom topic
   */
  async publish(topic: string, payload: any, options?: { qos?: 0 | 1 | 2; retain?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      const fullTopic = `${this._topicPrefix}/${topic}`;
      const payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

      this._mqttClient.publish(
        fullTopic,
        payloadStr,
        { qos: options?.qos || 1, retain: options?.retain || false },
        (err: Error | null) => {
          if (err) {
            logger.error(`[MQTTDevice:${this.id}] Publish failed:`, err);
            resolve(false);
          } else {
            resolve(true);
          }
        }
      );
    });
  }
}

/**
 * MQTT Device Driver
 *
 * Provides real device connectivity via MQTT protocol.
 */
export class MQTTDeviceDriver extends BaseDeviceDriver {
  private _options: MQTTConnectionOptions;
  private _mqttClient: any = null;
  private _mqtt: any = null;
  private _devices: Map<string, MQTTDevice> = new Map();
  private _reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: MQTTConnectionOptions) {
    super(DriverType.REAL);
    this._options = {
      clientId: `ac-mqtt-${Date.now()}`,
      keepalive: 60,
      clean: true,
      reconnect: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      ...options,
    };
    logger.info(`Initialized for broker: ${this._options.brokerUrl}`);
  }

  /**
   * Connect to the MQTT broker
   */
  async connect(): Promise<void> {
    try {
      // Dynamic import of mqtt library
      this._mqtt = await import('mqtt');

      logger.info(`Connecting to ${this._options.brokerUrl}...`);

      return new Promise((resolve, reject) => {
        this._mqttClient = this._mqtt.connect(this._options.brokerUrl, {
          clientId: this._options.clientId,
          username: this._options.username,
          password: this._options.password,
          keepalive: this._options.keepalive,
          clean: this._options.clean,
          reconnectPeriod: this._options.reconnect ? this._options.reconnectPeriod : 0,
          connectTimeout: this._options.connectTimeout,
          ca: this._options.ca,
          cert: this._options.cert,
          key: this._options.key,
        });

        this._mqttClient.on('connect', () => {
          logger.info(`Connected to ${this._options.brokerUrl}`);
          this._connected = true;
          this._setupEventHandlers();
          resolve();
        });

        this._mqttClient.on('error', (err: Error) => {
          logger.error(`Connection error:`, err);
          if (!this._connected) {
            reject(err);
          }
        });

        this._mqttClient.on('disconnect', () => {
          logger.info(`Disconnected from broker`);
          this._connected = false;
        });

        this._mqttClient.on('offline', () => {
          logger.info(`Client offline`);
          this._connected = false;
        });

        this._mqttClient.on('reconnect', () => {
          logger.info(`Reconnecting...`);
        });
      });
    } catch (error) {
      logger.error(`Failed to load mqtt library:`, error);
      throw new Error('MQTT library not installed. Run: npm install mqtt');
    }
  }

  private _setupEventHandlers(): void {
    if (!this._mqttClient) return;

    this._mqttClient.on('message', (topic: string, payload: Buffer) => {
      // Route messages to appropriate device handlers
      const device = this._findDeviceByTopic(topic);
      if (device) {
        // Message will be handled by device's own handler
      } else {
        logger.info(`Received message for unknown topic: ${topic}`);
      }
    });
  }

  private _findDeviceByTopic(topic: string): MQTTDevice | undefined {
    for (const device of this._devices.values()) {
      if (topic.startsWith(device.connectionInfo.endpoint)) {
        return device;
      }
    }
    return undefined;
  }

  /**
   * Disconnect from the MQTT broker
   */
  async disconnect(): Promise<void> {
    if (this._mqttClient) {
      logger.info(`Disconnecting from ${this._options.brokerUrl}...`);

      // Unsubscribe from all topics
      for (const device of this._devices.values()) {
        const stateTopic = `${device.connectionInfo.endpoint}/state`;
        const eventTopic = `${device.connectionInfo.endpoint}/event`;
        this._mqttClient.unsubscribe(stateTopic);
        this._mqttClient.unsubscribe(eventTopic);
      }

      this._mqttClient.end();
      this._mqttClient = null;
      this._connected = false;
      this._devices.clear();
    }
  }

  /**
   * Create a device from configuration
   */
  async createDevice(config: MQTTDeviceConfig): Promise<IDevice> {
    if (!this._connected || !this._mqttClient) {
      throw new Error('MQTT driver not connected. Call connect() first.');
    }

    logger.info(`Creating device: ${config.name} (${config.topicPrefix})`);

    const device = new MQTTDevice(config, this._mqttClient);
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
        description: 'MQTT sensor device - reads values from state topic',
        defaultCapabilities: ['read-state'],
      },
      {
        type: DeviceType.ACTUATOR,
        category: 'actuator',
        description: 'MQTT actuator device - sends commands via command topic',
        defaultCapabilities: ['execute-command'],
      },
      {
        type: DeviceType.CONTROLLER,
        category: 'controller',
        description: 'MQTT controller device - both reads state and sends commands',
        defaultCapabilities: ['read-state', 'execute-command'],
      },
    ];
  }

  /**
   * Subscribe to a topic
   */
  async subscribe(topic: string, qos: 0 | 1 | 2 = 1): Promise<void> {
    if (!this._mqttClient) {
      throw new Error('MQTT client not connected');
    }

    return new Promise((resolve, reject) => {
      this._mqttClient.subscribe(topic, { qos }, (err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          logger.info(`Subscribed to ${topic}`);
          resolve();
        }
      });
    });
  }

  /**
   * Publish to a topic
   */
  async publish(topic: string, payload: any, qos: 0 | 1 | 2 = 1, retain = false): Promise<void> {
    if (!this._mqttClient) {
      throw new Error('MQTT client not connected');
    }

    return new Promise((resolve, reject) => {
      const payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);

      this._mqttClient.publish(topic, payloadStr, { qos, retain }, (err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          logger.info(`Published to ${topic}`);
          resolve();
        }
      });
    });
  }

  /**
   * Get device by ID
   */
  getDevice(deviceId: string): MQTTDevice | undefined {
    return this._devices.get(deviceId);
  }

  /**
   * Get all devices
   */
  getAllDevices(): MQTTDevice[] {
    return Array.from(this._devices.values());
  }
}
