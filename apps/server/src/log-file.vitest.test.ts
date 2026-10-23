/**
 * @vitest-environment node
 *
 * RotatingFileStream tests (LOG_FILE rotation): writes beyond LOG_MAX_SIZE
 * rotate through the rename chain, LOG_MAX_FILES generations are kept, the
 * oldest is deleted, and no content is lost across rotations.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RotatingFileStream, TeeStream } from './log-file.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eaf-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RotatingFileStream', () => {
  it('writes to a single file while under the size limit', () => {
    const file = join(dir, 'app.log');
    const stream = new RotatingFileStream(file, { maxSize: 1000, maxFiles: 3 });
    stream.write('line one\n');
    stream.write('line two\n');
    stream.end();

    expect(readFileSync(file, 'utf8')).toBe('line one\nline two\n');
    expect(readdirSync(dir)).toEqual(['app.log']);
  });

  it('rotates when a write would exceed maxSize', () => {
    const file = join(dir, 'app.log');
    const stream = new RotatingFileStream(file, { maxSize: 20, maxFiles: 3 });
    stream.write('aaaaaaaaaa\n'); // 11 bytes
    stream.write('bbbbbbbbbb\n'); // 11 + 11 > 20 → rotates first
    stream.end();

    expect(readFileSync(file, 'utf8')).toBe('bbbbbbbbbb\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('aaaaaaaaaa\n');
  });

  it('keeps exactly maxFiles generations and deletes the oldest', () => {
    const file = join(dir, 'app.log');
    // 11-byte lines, 20-byte limit → every line after the first rotates.
    const stream = new RotatingFileStream(file, { maxSize: 20, maxFiles: 2 });
    for (const tag of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
      stream.write(`${tag}-padding\n`);
    }
    stream.end();

    const files = readdirSync(dir).sort();
    expect(files).toEqual(['app.log', 'app.log.1', 'app.log.2']);
    // Newest in app.log, one generation older per suffix; L1–L3 are gone.
    expect(readFileSync(file, 'utf8')).toBe('L6-padding\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('L5-padding\n');
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('L4-padding\n');
  });

  it('appends to an existing file and counts its size toward the limit', () => {
    const file = join(dir, 'app.log');
    writeFileSync(file, 'existing\n'); // 9 bytes
    const stream = new RotatingFileStream(file, { maxSize: 15, maxFiles: 1 });
    stream.write('new-line\n'); // 9 + 9 > 15 → rotate, existing content → .1
    stream.end();

    expect(readFileSync(`${file}.1`, 'utf8')).toBe('existing\n');
    expect(readFileSync(file, 'utf8')).toBe('new-line\n');
  });

  it('creates the parent directory when missing', () => {
    const file = join(dir, 'nested', 'logs', 'app.log');
    const stream = new RotatingFileStream(file, { maxSize: 100, maxFiles: 1 });
    stream.write('hello\n');
    stream.end();

    expect(readFileSync(file, 'utf8')).toBe('hello\n');
  });
});

describe('TeeStream', () => {
  it('fans every write out to all targets', () => {
    const received: string[] = [];
    const a = { write: (chunk: string | Buffer) => received.push(`a:${chunk}`) };
    const b = { write: (chunk: string | Buffer) => received.push(`b:${chunk}`) };
    const tee = new TeeStream([a, b]);
    tee.write('x\n');

    expect(received).toEqual(['a:x\n', 'b:x\n']);
  });

  it('a failing target never blocks the others', () => {
    const received: string[] = [];
    const bad = {
      write: () => {
        throw new Error('disk full');
      },
    };
    const good = { write: (chunk: string | Buffer) => received.push(String(chunk)) };
    const tee = new TeeStream([bad, good]);

    expect(() => tee.write('still logged\n')).not.toThrow();
    expect(received).toEqual(['still logged\n']);
  });
});
