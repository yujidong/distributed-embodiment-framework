/**
 * @vitest-environment node
 *
 * Logger sink tests: setLogSink replaces console.* output (server tee to a
 * rotating log file), level filtering is applied BEFORE the sink, and
 * setLogSink(null) restores the plain console behavior tests rely on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureLogger,
  createLogger,
  LoggerLevel,
  setLogSink,
  type LogSink,
} from './index';

afterEach(() => {
  setLogSink(null);
  configureLogger({ level: LoggerLevel.INFO, moduleLevels: {} });
  vi.restoreAllMocks();
});

describe('setLogSink', () => {
  it('routes emitted lines to the sink instead of console.*', () => {
    const lines: Array<{ level: string; message: string; args: unknown[] }> = [];
    const sink: LogSink = (level, message, args) => lines.push({ level, message, args });
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    setLogSink(sink);

    createLogger('TestModule').info('hello', { extra: 1 });

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].message).toContain('[TestModule]');
    expect(lines[0].message).toContain('[INFO]');
    expect(lines[0].message).toContain('hello');
    expect(lines[0].args).toEqual([{ extra: 1 }]);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('applies level filtering before the sink (filtered lines never reach it)', () => {
    const lines: string[] = [];
    setLogSink((_level, message) => lines.push(message));
    configureLogger({ level: LoggerLevel.WARN });

    const logger = createLogger('TestModule');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[WARN]');
    expect(lines[1]).toContain('[ERROR]');
  });

  it('honours per-module overrides before the sink', () => {
    const lines: string[] = [];
    setLogSink((_level, message) => lines.push(message));
    configureLogger({ moduleLevels: { Noisy: LoggerLevel.WARN } });

    createLogger('Noisy').info('suppressed');
    createLogger('Quiet').info('kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Quiet]');
  });

  it('setLogSink(null) restores console.* output', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setLogSink(() => undefined);
    setLogSink(null);

    createLogger('TestModule').warn('back to console');

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleSpy.mock.calls[0][0])).toContain('back to console');
  });
});
