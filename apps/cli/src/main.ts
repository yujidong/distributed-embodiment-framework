#!/usr/bin/env node
/**
 * eaf binary entry — thin wrapper around run() (cli.ts) so the whole CLI is
 * exercisable in-process from tests. Ctrl+C aborts long-running commands
 * (sim watch) through an AbortSignal instead of a hard exit.
 */

import { installStderrLogSink } from './log-sink.js';
// Must execute before cli.js's import chain: core's singletons log at
// import time, and those lines must not land on stdout (the --json
// contract promises stdout = command output only).
installStderrLogSink();

import { run } from './cli.js';
import { defaultIO } from './io.js';

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

const code = await run(process.argv.slice(2), defaultIO(), abort.signal);

// A SIGINT arriving after a clean exit should still kill the process with
// the conventional code (128 + SIGINT = 130); otherwise use run()'s verdict.
if (abort.signal.aborted && code === 0) {
  process.exitCode = 130;
} else {
  process.exitCode = code;
}
