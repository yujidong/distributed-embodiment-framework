/**
 * Dispatch — global flag handling, command routing, top-level error
 * mapping onto exit codes. `run()` is fully in-process and testable; the
 * only side effect not injected is the network.
 */

import { usageError, CliError, EXIT } from './errors.js';
import type { IO } from './io.js';
import { stat as statFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Output } from './output.js';
import { isValidProfileName } from './config.js';
import { makeCtx, type Ctx } from './ctx.js';
import { installStderrLogSink } from './log-sink.js';
import { COMMAND_HELP, GENERAL_HELP } from './help.js';
import { agentCommand } from './commands/agent.js';
import { agreementCommand } from './commands/agreement.js';
import { applyCommand } from './commands/apply.js';
import { authCommand } from './commands/auth.js';
import { blueprintCommand } from './commands/blueprint.js';
import { catalogCommand } from './commands/catalog.js';
import { deviceCommand } from './commands/device.js';
import { envCommand } from './commands/env.js';
import { flowCommand } from './commands/flow.js';
import { serviceCommand } from './commands/service.js';
import { simCommand } from './commands/sim.js';
import { scenarioCommand } from './commands/scenario.js';
import { scenarioTemplatesCommand } from './commands/scenario-templates.js';
import { importIfcCommand } from './commands/import-ifc.js';
import { importFloorplanCommand } from './commands/import-floorplan.js';
import { meCommand } from './commands/me.js';
import { notificationsCommand } from './commands/notifications.js';
import { adminCommand } from './commands/admin.js';
import { sandboxCommand } from './commands/sandbox.js';

interface Globals {
  server?: string;
  profile?: string;
  lang?: string;
  json: boolean;
  help: boolean;
  version: boolean;
}

type CommandHandler = (ctx: Ctx, sub: string | undefined, argv: string[]) => Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
  auth: authCommand,
  env: envCommand,
  device: deviceCommand,
  agent: agentCommand,
  catalog: catalogCommand,
  service: serviceCommand,
  flow: flowCommand,
  blueprint: blueprintCommand,
  agreement: agreementCommand,
  notifications: notificationsCommand,
  admin: adminCommand,
  me: meCommand,
  sim: simCommand,
  sandbox: sandboxCommand,
  scenario: scenarioCommand,
  'scenario-templates': scenarioTemplatesCommand,
};

/**
 * Entry: argv = process.argv.slice(2). Global flags may lead the line
 * (`eaf --json env list …`) or trail it (`eaf env list --json`); the
 * leading ones are stripped here, trailing ones are accepted by every
 * command's own parse and merged back in.
 */
export async function run(argv: string[], io: IO, signal?: AbortSignal): Promise<number> {
  // T58 (R6, u2-F-2-3): detect --json BEFORE dispatch — a failing command
  // must still honor the machine-readable contract (stdout carries
  // {error:{…}}; scripts can parse the exit path), including failures that
  // happen during argv splitting. splitGlobals refines it below.
  let json = argv[0] === '--json';
  try {
    // DevLoop (--json contract): also install for in-process consumers
    // (tests) that import run() directly and never load main.ts.
    installStderrLogSink();
    const { globals, command, args } = splitGlobals(argv);
    json = globals.json || args.includes('--json');

    if (command === 'help') {
      io.stdout((args[0] && COMMAND_HELP[args[0]] ? COMMAND_HELP[args[0]] : GENERAL_HELP) + '\n');
      return EXIT.OK;
    }
    // T72 (R8 验收① / R9 复测协议): `eaf --version` — the ARTIFACT
    // FINGERPRINT. R8's "绿了但红了" round-trip was blamed on deployment skew
    // for a week because users had no way to record WHICH build answered;
    // every R9 acceptance step now starts by recording this line.
    if (globals.version && command === undefined) {
      io.stdout((await artifactFingerprint()) + '\n');
      return EXIT.OK;
    }
    if (globals.help && command === undefined) {
      io.stdout(GENERAL_HELP + '\n');
      return EXIT.OK;
    }
    if (command === undefined) {
      io.stderr(GENERAL_HELP + '\n');
      return EXIT.USAGE;
    }
    if (globals.help || args.includes('--help') || args.includes('-h')) {
      io.stdout((COMMAND_HELP[command] ?? GENERAL_HELP) + '\n');
      return EXIT.OK;
    }

    const out = new Output(io, json);
    const profile = resolveProfile(io, globals.profile ?? trailingFlag(args, '--profile'));
    const lang = globals.lang ?? trailingFlag(args, '--lang');
    const ctx = makeCtx(io, out, globals.server ?? trailingFlag(args, '--server'), signal, profile, lang);
    // Fix-18 (R7 F-17): global flags trailing the COMMAND GROUP
    // (`eaf notifications --profile chen list`) must not be mistaken for a
    // subcommand — strip them (values already recovered above) before the
    // handler matches its subcommand.
    const commandArgs = stripGlobalFlags(args);

    if (command === 'apply') {
      await applyCommand(ctx, commandArgs);
      return EXIT.OK;
    }
    if (command === 'import-ifc') {
      await importIfcCommand(ctx, commandArgs);
      return EXIT.OK;
    }
    if (command === 'import-floorplan') {
      await importFloorplanCommand(ctx, commandArgs);
      return EXIT.OK;
    }
    const handler = COMMANDS[command];
    if (!handler) {
      throw usageError(`unknown command "${command}" — run \`eaf help\` for the command list`);
    }
    await handler(ctx, commandArgs[0], commandArgs.slice(1));
    return EXIT.OK;
  } catch (error) {
    return reportError(io, error, json);
  }
}

/**
 * T72 (R8 验收① / R9 复测协议): the artifact fingerprint — WHICH build is
 * answering. R7/R8 both burned a round on "deployed artifact vs tested
 * artifact" suspicions; every acceptance capture now starts with
 * `eaf --version`. Carries: package version, the mtime of the LOADED entry
 * module (src under tsx dev, dist when built — the honest "which bytes"),
 * and the git revision when a checkout is present (packaged deploys omit it,
 * never a fabricated hash).
 */
async function artifactFingerprint(): Promise<string> {
  const parts: string[] = ['eaf'];
  try {
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    if (pkg.version !== undefined) parts.push(pkg.version);
  } catch {
    // no readable package.json — the remaining fields still identify the build
  }
  try {
    const entry = await statFile(fileURLToPath(import.meta.url));
    parts.push(`artifact ${entry.mtime.toISOString()}`);
  } catch {
    // non-filesystem runtime — omit
  }
  try {
    const { execFileSync } = await import('node:child_process');
    const here = fileURLToPath(new URL('..', import.meta.url));
    const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (rev.length > 0) parts.push(`git ${rev}`);
  } catch {
    // packaged deploy without .git — honestly omitted
  }
  return parts.join(' ');
}

/** Extract the value of `--flag` / `--flag=v` when given after the command. */
function trailingFlag(args: string[], flag: string): string | undefined {  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

/**
 * Fix-18 (R7 F-17): remove the global flags (and the values of `--server` /
 * `--profile` / `--lang`) from the post-command argument list. Every command's
 * own parse already tolerates them; stripping them HERE is what keeps a
 * trailing global flag from being read as a subcommand (`eaf notifications
 * --profile chen list`) — or tripping the strict parser (`eaf env list
 * --lang zh-CN`). Command-specific flags pass through untouched.
 */
function stripGlobalFlags(args: string[]): string[] {
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' || arg === '--help' || arg === '-h' || arg === '--version') continue;
    if (arg === '--server' || arg === '--profile' || arg === '--lang') {
      i++; // skip the flag's value
      continue;
    }
    if (arg.startsWith('--server=') || arg.startsWith('--profile=') || arg.startsWith('--lang=')) continue;
    stripped.push(arg);
  }
  return stripped;
}

/**
 * Profile resolution, highest precedence first: `--profile` flag →
 * EAF_PROFILE env → default (no profile). Names must be path-safe — the
 * profile becomes the session file name (`config-<name>.json`).
 */
function resolveProfile(io: IO, flagProfile: string | undefined): string | undefined {
  const envProfile = io.env.EAF_PROFILE;
  const profile = flagProfile ?? (envProfile && envProfile.length > 0 ? envProfile : undefined);
  if (profile !== undefined && !isValidProfileName(profile)) {
    throw usageError(
      `invalid profile name ${JSON.stringify(profile)} — use only letters, digits, "-" and "_"`,
    );
  }
  return profile;
}

function splitGlobals(argv: string[]): { globals: Globals; command?: string; args: string[] } {
  const globals: Globals = { json: false, help: false, version: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--json') {
      globals.json = true;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      globals.help = true;
      i++;
    } else if (arg === '--version') {
      globals.version = true;
      i++;
    } else if (arg === '--server') {
      if (i + 1 >= argv.length) throw usageError('--server requires a value');
      globals.server = argv[i + 1];
      i += 2;
    } else if (arg.startsWith('--server=')) {
      globals.server = arg.slice('--server='.length);
      i++;
    } else if (arg === '--profile') {
      if (i + 1 >= argv.length) throw usageError('--profile requires a value');
      globals.profile = argv[i + 1];
      i += 2;
    } else if (arg.startsWith('--profile=')) {
      globals.profile = arg.slice('--profile='.length);
      i++;
    } else if (arg === '--lang') {
      if (i + 1 >= argv.length) throw usageError('--lang requires a value');
      globals.lang = argv[i + 1];
      i += 2;
    } else if (arg.startsWith('--lang=')) {
      globals.lang = arg.slice('--lang='.length);
      i++;
    } else if (arg.startsWith('-')) {
      throw usageError(`unknown global flag "${arg}" (global flags must precede the command)`);
    } else {
      break;
    }
  }
  return { globals, command: argv[i], args: argv.slice(i + (argv[i] !== undefined ? 1 : 0)) };
}

/**
 * T58 (R6, u2-F-2-3): the error exit is three-channel honest. In --json mode
 * STDOUT carries the structured carrier — the server's RAW error body
 * verbatim when the failure came from the API (code + details identical to
 * the REST face), or a synthesized `{error:{code,message}}` for CLI-local
 * failures (stable CLI_* codes) — while STDERR keeps the human line (both
 * faces coexist; scripts parse stdout, humans read stderr). Human mode is
 * untouched.
 *
 * Exported (T129): a pure function over (io, error, json) so the human
 * render faces of server error envelopes (e.g. the consumption-lane 503s —
 * R102: the human line must carry the failure reason and the pointer, never
 * less than --json) are fixture-testable without a live server.
 */
export function reportError(io: IO, error: unknown, json: boolean): number {
  const exitCode = error instanceof CliError
    ? error.exitCode
    : EXIT.ERROR;
  if (json) {
    let carrier: unknown;
    if (error instanceof CliError && error.apiBody !== undefined) {
      carrier = error.apiBody; // server pass-through, verbatim
    } else {
      const code =
        error instanceof CliError
          ? error.exitCode === EXIT.USAGE
            ? 'CLI_USAGE'
            : error.exitCode === EXIT.AUTH
              ? 'CLI_AUTH'
              : error.exitCode === EXIT.NOT_FOUND
                ? 'CLI_NOT_FOUND'
                : 'CLI_ERROR'
          : 'CLI_UNEXPECTED';
      const message = error instanceof Error ? error.message : String(error);
      carrier = {
        error: {
          code,
          message,
          ...(error instanceof CliError && error.issues !== undefined ? { issues: error.issues } : {}),
        },
      };
    }
    io.stdout(JSON.stringify(carrier, null, 2) + '\n');
  }
  if (error instanceof CliError) {
    io.stderr(`error: ${error.message}\n`);
    for (const issue of error.issues ?? []) {
      io.stderr(`  - ${issue}\n`);
    }
    return exitCode;
  }
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  io.stderr(`error: unexpected failure: ${message}\n`);
  return exitCode;
}
