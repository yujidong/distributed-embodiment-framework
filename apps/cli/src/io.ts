/**
 * IO abstraction — every stream and environment touch goes through here so
 * `run()` stays fully testable in-process (tests inject captured streams and
 * a temp EAF_HOME instead of spawning the binary).
 */

import { homedir } from 'node:os';

export interface IO {
  /** Environment variables (EAF_SERVER, EAF_HOME, …). */
  env: Record<string, string | undefined>;
  /** Working directory for resolving relative file paths (-f, -o). */
  cwd: string;
  /** User home — config lives at $EAF_HOME or <home>/.eaf. */
  homeDir: string;
  /** True on an interactive terminal (enables prompts). */
  isTTY: boolean;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  /** Input for interactive prompts (login/register). */
  stdin?: NodeJS.ReadableStream;
}

/** The real process-backed IO used by the shipped binary. */
export function defaultIO(): IO {
  return {
    env: process.env,
    cwd: process.cwd(),
    homeDir: homedir(),
    isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    stdout: chunk => process.stdout.write(chunk),
    stderr: chunk => process.stderr.write(chunk),
    stdin: process.stdin,
  };
}
