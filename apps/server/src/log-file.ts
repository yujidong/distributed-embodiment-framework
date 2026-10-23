/**
 * Rotating file destination for server logs (LOG_FILE) — zero dependencies.
 *
 * RotatingFileStream appends to `filePath`; once a write would push the file
 * past `maxSize` bytes, the file rotates through a rename chain
 * (app.log → app.log.1 → … → app.log.N, the oldest deleted) and a fresh file
 * is opened. Writes go through `fs.writeSync` on a kept-open fd: logging must
 * never lose or interleave lines around a rotation the way an async
 * createWriteStream close/reopen can, and pino writes synchronously anyway.
 *
 * TeeStream fans every write out to several destinations (process.stdout +
 * the rotating file) — it satisfies the minimal `{ write }` shape pino
 * accepts as a custom destination stream, so the Fastify logger tees with no
 * extra dependency.
 */

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RotatingFileStreamOptions {
  /** Rotation threshold in bytes (LOG_MAX_SIZE, default 10MB upstream). */
  maxSize: number;
  /** Rotated generations to keep (LOG_MAX_FILES): app.log.1 … app.log.N. */
  maxFiles: number;
}

/** Minimal writable-destination shape shared by both stream classes. */
export interface LogDestination {
  write(chunk: string | Buffer): unknown;
}

export class RotatingFileStream implements LogDestination {
  private fd: number;
  private currentSize = 0;

  constructor(
    private readonly filePath: string,
    private readonly options: RotatingFileStreamOptions,
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.currentSize = existsSync(filePath) ? statSync(filePath).size : 0;
    this.fd = openSync(filePath, 'a');
  }

  write(chunk: string | Buffer): void {
    const size = Buffer.byteLength(chunk);
    // Rotate BEFORE the write that would overflow, so no generation ever
    // exceeds maxSize by more than one already-pending line.
    if (this.currentSize > 0 && this.currentSize + size > this.options.maxSize) {
      this.rotate();
    }
    if (typeof chunk === 'string') {
      writeSync(this.fd, chunk);
    } else {
      writeSync(this.fd, chunk);
    }
    this.currentSize += size;
  }

  /** app.log.(N-1) → app.log.N, …, app.log → app.log.1; oldest dropped. */
  private rotate(): void {
    closeSync(this.fd);
    const oldest = `${this.filePath}.${this.options.maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.options.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.filePath}.${i + 1}`);
    }
    renameSync(this.filePath, `${this.filePath}.1`);
    this.fd = openSync(this.filePath, 'a');
    this.currentSize = 0;
  }

  /** Flush + close the underlying fd (server shutdown). */
  end(): void {
    closeSync(this.fd);
  }
}

/**
 * Fan-out destination: every chunk goes to each target in order. A failing
 * file target must not break stdout logging, and vice versa.
 */
export class TeeStream implements LogDestination {
  constructor(private readonly targets: LogDestination[]) {}

  write(chunk: string | Buffer): void {
    for (const target of this.targets) {
      try {
        target.write(chunk);
      } catch {
        // A dead destination (e.g. full disk) never takes the others down.
      }
    }
  }
}
