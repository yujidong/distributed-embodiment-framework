/**
 * DevLoop (CLI --json contract): route every shared-logger line to stderr.
 *
 * The help text promises `--json` = "pretty JSON on stdout, logs on stderr",
 * but the library logger defaults to console.info/console.debug, which land
 * on STDOUT — `eaf apply -f world.yaml --json | jq` died on the three
 * import-time singleton lines ("EnvironmentRegistry Initialized", …) that
 * core emits before any command runs. Importing this module installs a
 * global sink ONCE, before cli.js's import chain fires those logs.
 *
 * main.ts must keep this as its FIRST import (module side-effect order is
 * declaration order); run() also calls installStderrLogSink() defensively
 * for in-process consumers (tests) that never load main.ts.
 */

import { setLogSink } from '@active-collaboration/shared';

let installed = false;

export function installStderrLogSink(): void {
  if (installed) return;
  installed = true;
  setLogSink((level, message, args) => {
    // Prefix keeps the stream greppable; process.stderr.write never throws
    // on EPIPE for pipes closed early (jq exiting), unlike console.error.
    const line = args.length > 0
      ? `${message} ${args.map(a => formatArg(a)).join(' ')}\n`
      : `${message}\n`;
    process.stderr.write(line);
  });
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// Install as a MODULE SIDE EFFECT: module bodies run in import-declaration
// order, so main.ts listing './log-sink.js' first means this executes before
// cli.js's import chain fires its import-time singleton logs. A body-level
// call in main.ts would be too late — all static imports evaluate before
// any importer's body runs.
installStderrLogSink();
