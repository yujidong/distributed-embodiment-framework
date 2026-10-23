/**
 * `eaf auth` — register / login / whoami / set-name / logout.
 *
 * Login persists {server, token} in ~/.eaf/config.json (0600) — or
 * config-<profile>.json with `--profile` / $EAF_PROFILE. The token is
 * never printed — whoami resolves it against /api/auth/me instead.
 */

import { ApiClient } from '../client.js';
import { clearSession, saveSession } from '../config.js';
import { usageError } from '../errors.js';
import type { Ctx } from '../ctx.js';
import { parse, rejectExtraPositionals, requirePositional, stringFlag } from '../args.js';
import { promptPassword, promptValue } from '../prompt.js';

const USAGE_LOGIN = 'eaf auth login [--email <e>] [--password <p>]';
// --name kept as a backwards-compatible alias of --display-name (API field).
const USAGE_REGISTER =
  'eaf auth register --email <e> --password <p> (--display-name <displayName> | --name <displayName>) [--invite-code <code>]';
const USAGE_SET_NAME = 'eaf auth set-name <displayName>';

interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export async function authCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'login':
      return login(ctx, argv);
    case 'register':
      return register(ctx, argv);
    case 'whoami':
      return whoami(ctx, argv);
    case 'set-name':
      return setName(ctx, argv);
    case 'logout':
      return logout(ctx, argv);
    default:
      throw usageError(`unknown auth subcommand "${sub ?? ''}" (expected login|register|whoami|set-name|logout)`);
  }
}

async function login(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { email: { type: 'string' }, password: { type: 'string' } }, USAGE_LOGIN);
  rejectExtraPositionals(positionals, USAGE_LOGIN);
  const email = stringFlag(flags, 'email') ?? (await promptValue(ctx.io, 'Email: '));
  const password = stringFlag(flags, 'password') ?? (await promptPassword(ctx.io));
  await doLogin(ctx, email, password, `logged in`);
}

async function register(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
      'display-name': { type: 'string' },
      'invite-code': { type: 'string' },
    },
    USAGE_REGISTER,
  );
  rejectExtraPositionals(positionals, USAGE_REGISTER);
  const email = stringFlag(flags, 'email') ?? (await promptValue(ctx.io, 'Email: '));
  const password = stringFlag(flags, 'password') ?? (await promptPassword(ctx.io));
  // Fix-18 (R7 F-04): --display-name names the API field (displayName);
  // --name stays as the compatible alias.
  const name = stringFlag(flags, 'display-name') ?? stringFlag(flags, 'name') ??
    (await promptValue(ctx.io, 'Display name: '));
  // Alpha capacity gating (EAF_INVITE_ONLY): required only when the server
  // runs invite-only; the server's 403 INVITE_REQUIRED teaches that case.
  const inviteCode = stringFlag(flags, 'invite-code');

  const client = new ApiClient(ctx.server);
  const user = (await client.post('/api/auth/register', {
    email,
    password,
    displayName: name,
    ...(inviteCode !== undefined ? { inviteCode } : {}),
  })) as PublicUser;
  ctx.out.info(`registered ${user.displayName} <${user.email}> — logging in`);
  await doLogin(ctx, email, password, 'registered + logged in');
}

/** Login + persist session + resolve the user for display. */
async function doLogin(ctx: Ctx, email: string, password: string, verb: string): Promise<void> {
  const client = new ApiClient(ctx.server);
  const { token } = (await client.post('/api/auth/login', { email, password })) as { token: string };
  saveSession(ctx.io, ctx.server, token, ctx.profile);
  const me = (await client.withToken(token).get('/api/auth/me')) as PublicUser;
  if (ctx.json) {
    // NEVER the token.
    ctx.out.data({
      id: me.id,
      email: me.email,
      displayName: me.displayName,
      server: ctx.server,
      profile: ctx.profile ?? null,
    });
  } else {
    const profile = ctx.profile ? ` (profile ${ctx.profile})` : '';
    ctx.out.line(`${verb} as ${me.displayName} <${me.email}> on ${ctx.server}${profile}`);
  }
}

async function whoami(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, 'eaf auth whoami');
  rejectExtraPositionals(positionals, 'eaf auth whoami');
  const me = (await ctx.authedClient().get('/api/auth/me')) as PublicUser;
  if (ctx.json) {
    ctx.out.data({ ...me, server: ctx.server, profile: ctx.profile ?? null });
  } else {
    ctx.out.line(
      `${me.displayName} <${me.email}> (${me.id}) on ${ctx.server} (profile ${ctx.profile ?? '(default)'})`,
    );
  }
}

/** Rename the current account (PATCH /api/me, Fix-13). */
async function setName(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_SET_NAME);
  const name = requirePositional(positionals, 'displayName', USAGE_SET_NAME);
  const me = (await ctx.authedClient().patch('/api/me', { displayName: name })) as PublicUser;
  if (ctx.json) {
    ctx.out.data({ ...me, server: ctx.server, profile: ctx.profile ?? null });
  } else {
    ctx.out.line(`display name changed to ${me.displayName} <${me.email}>`);
  }
}

async function logout(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, 'eaf auth logout');
  rejectExtraPositionals(positionals, 'eaf auth logout');
  try {
    await ctx.openClient().post('/api/auth/logout');
  } catch {
    // Best effort: local session is cleared regardless.
  }
  clearSession(ctx.io, ctx.profile);
  if (ctx.json) ctx.out.data({ loggedOut: true, server: ctx.server, profile: ctx.profile ?? null });
  else {
    const profile = ctx.profile ? ` (profile ${ctx.profile})` : '';
    ctx.out.line(`logged out (session on ${ctx.server} cleared)${profile}`);
  }
}
