/**
 * Exit codes — the CLI's contract with scripts and AI agents.
 *
 * - 0  success
 * - 1  runtime error (server unreachable, API error, unexpected failure)
 * - 2  usage error (bad flags, invalid document, unresolved references)
 * - 3  auth error (401 from the API, or an authed command while logged out)
 * - 4  not found (404 from the API, unknown id/name)
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error that carries the process exit code the CLI should return. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.ERROR,
    /** Extra detail lines printed after the message (validation issues, …). */
    readonly issues?: string[],
    /**
     * T58 (R6, u2-F-2-3): the server's RAW error body when this error came
     * from an API response — the `--json` stdout carrier emits it VERBATIM
     * (server pass-through), so scripts see the same code/details the REST
     * face serves instead of a CLI-side re-encoding.
     */
    readonly apiBody?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Usage error (exit 2). */
export function usageError(message: string, issues?: string[]): CliError {
  return new CliError(message, EXIT.USAGE, issues);
}
