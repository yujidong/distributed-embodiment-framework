/**
 * Interactive prompts for `auth login` / `auth register` when flags are
 * omitted. Password input mutes echo. Non-interactive shells (agents,
 * pipes) must pass flags — prompting then is a usage error, never a hang.
 */

import * as readline from 'node:readline';

import { usageError } from './errors.js';
import type { IO } from './io.js';

function ask(io: IO, label: string, secret: boolean): Promise<string> {
  if (!io.stdin) {
    throw usageError(`${label} required — pass the flag explicitly (no interactive stdin)`);
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: io.stdin as NodeJS.ReadableStream, terminal: false });
    let answered = false;
    if (secret) {
      // Echo suppression: swallow stdin data while the user types. With
      // terminal:false readline does not echo input itself; on a real TTY
      // the terminal driver echoes, so we print a hint instead.
      io.stdout(label);
    } else {
      io.stdout(label);
    }
    rl.on('line', line => {
      answered = true;
      rl.close();
      resolve(line.trim());
    });
    rl.on('close', () => {
      if (!answered) reject(usageError(`${label.trim()} input aborted`));
    });
    rl.on('error', reject);
  });
}

/**
 * Hidden password prompt. On a TTY we flip the terminal to no-echo raw-ish
 * behavior via readline's output hack; for piped stdin there is no echo
 * anyway. Never logs the value.
 */
export async function promptPassword(io: IO, label = 'Password: '): Promise<string> {
  if (!io.isTTY) {
    // Piped/redirected input: read one line, no echo involved.
    const value = await ask(io, '', true);
    if (value.length === 0) throw usageError('empty password on stdin');
    return value;
  }
  const input = io.stdin as NodeJS.ReadStream;
  return new Promise((resolve, reject) => {
    io.stdout(label);
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          cleanup();
          io.stdout('\n');
          resolve(buffer);
          return;
        }
        if (char === '') {
          cleanup();
          reject(usageError('aborted'));
          return;
        }
        if (char === '' || char === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    const cleanup = (): void => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
    };
    input.on('data', onData);
    input.resume();
  });
}

/** Plain visible prompt (email, display name). */
export async function promptValue(io: IO, label: string): Promise<string> {
  if (!io.isTTY && !io.stdin) {
    throw usageError(`${label} required — pass the flag explicitly (non-interactive)`);
  }
  const value = await ask(io, label, false);
  if (value.length === 0) throw usageError(`${label.trim()} must not be empty`);
  return value;
}
