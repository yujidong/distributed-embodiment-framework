/**
 * Time Manager
 *
 * Manages simulated time for accelerated testing
 */

import type { TimeConfig } from '../devices/types.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Time manager for simulated time
 */
const logger = createLogger('TimeManager');

export class TimeManager {
  private timeScale: number;
  private startTime: Date;
  private simTime: Date;
  private isRunning: boolean = false;
  private intervalHandle?: NodeJS.Timeout;

  constructor(config: TimeConfig = {}) {
    this.timeScale = config.timeScale || 1;
    this.startTime = config.startTime || new Date();
    this.simTime = new Date(this.startTime);

    logger.info(`Initialized with timeScale: ${this.timeScale}x`);
  }

  /**
   * Start time simulation
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Already running');
      return;
    }

    this.isRunning = true;
    const tickRate = 100; // Update every 100ms of real time

    this.intervalHandle = setInterval(() => {
      const realDelta = tickRate;
      const simDelta = realDelta * this.timeScale;
      this.simTime = new Date(this.simTime.getTime() + simDelta);
    }, tickRate);

    logger.info('Started');
  }

  /**
   * Stop time simulation
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('Not running');
      return;
    }

    this.isRunning = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    logger.info('Stopped');
  }

  /**
   * Get current simulated time
   * @returns Current simulated time
   */
  getCurrentTime(): Date {
    return new Date(this.simTime);
  }

  /**
   * Get elapsed simulated time since start
   * @returns Elapsed time in milliseconds
   */
  getElapsedSimTime(): number {
    return this.simTime.getTime() - this.startTime.getTime();
  }

  /**
   * Get elapsed real time since start
   * @returns Elapsed time in milliseconds
   */
  getElapsedRealTime(): number {
    return Date.now() - this.startTime.getTime();
  }

  /**
   * Set time scale
   * @param scale - New time scale (1 = real time, 10 = 10x speed)
   */
  setTimeScale(scale: number): void {
    logger.info(`Time scale changed: ${this.timeScale}x -> ${scale}x`);
    this.timeScale = scale;
  }

  /**
   * Get current time scale
   * @returns Current time scale
   */
  getTimeScale(): number {
    return this.timeScale;
  }

  /**
   * Reset time to start
   */
  reset(): void {
    logger.info('Resetting time');
    this.simTime = new Date(this.startTime);
  }

  /**
   * Jump to a specific simulated time
   * @param targetTime - Target time
   */
  jumpTo(targetTime: Date): void {
    logger.info(`Jumping to: ${targetTime.toISOString()}`);
    this.simTime = new Date(targetTime);
  }

  /**
   * Dispose time manager
   */
  dispose(): void {
    this.stop();
    logger.info('Disposed');
  }
}

// Export singleton instance (optional)
export const timeManager = new TimeManager();
