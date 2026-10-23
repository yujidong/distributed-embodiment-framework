/**
 * `eaf device` — device instances: list / get / add (catalog instantiate or
 * raw) / rm.
 */

import {
  csvFlag,
  jsonFlag,
  parse,
  requirePositional,
  requireString,
  stringFlag,
} from '../args.js';
import {
  getWithIdPrefix,
  type Ctx,
  type EnvDetail,
  type EnvDevice,
  type EnvProposal,
  type IdRosterEntry,
} from '../ctx.js';
import { isEnvProposal, proposalAppliedSummary } from '../ctx.js';
import { usageError } from '../errors.js';
import { t } from '../i18n/index.js';

const USAGE_LIST = 'eaf device list --env <id|name>';
const USAGE_GET = 'eaf device get <deviceId>';
const USAGE_ADD =
  'eaf device add --env <id|name> --zone <zoneId> [--name <n>] [--at "lng,lat"|"x,y"] ' +
  '(--model <catalogId> | --type <t> --capabilities a,b[,c] [--brand <b>] [--binding sim://…|hass://<entity>])';
const USAGE_UPDATE =
  'eaf device update <deviceId> [--name <n>] [--type <t>] [--brand <b>] [--capabilities a,b[,c]] ' +
  '[--zone <zoneId>] [--at "lng,lat"|"x,y"] [--initial-state <json>] [--binding sim://…|hass://<entity>]';
const USAGE_RM = 'eaf device rm <deviceId>';

export async function deviceCommand(ctx: Ctx, sub: string | undefined, argv: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      return listDevices(ctx, argv);
    case 'get':
      return getDevice(ctx, argv);
    case 'add':
      return addDevice(ctx, argv);
    case 'update':
      return updateDevice(ctx, argv);
    case 'rm':
      return removeDevice(ctx, argv);
    default:
      throw usageError(`unknown device subcommand "${sub ?? ''}" (expected list|get|add|update|rm)`);
  }
}

async function listDevices(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(argv, { env: { type: 'string' } }, USAGE_LIST);
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_LIST}`);
  const envRef = requireString(flags, 'env', USAGE_LIST);
  const detail = await ctx.resolveEnv(envRef);
  if (ctx.json) {
    ctx.out.data(detail.devices);
    return;
  }
  ctx.out.table(
    detail.devices.map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      brand: device.brand ?? '-',
      zone: device.zoneId,
      commands: device.commands?.join(',') ?? '-',
    })),
    ['id', 'name', 'type', 'brand', 'zone', 'commands'],
  );
}

/**
 * T88 (R12, u2-F1): the visible device roster for short-prefix resolution —
 * every environment the caller can read (the env detail carries its device
 * array; the same walk `agent get` uses). Best-effort.
 */
function deviceRoster(ctx: Ctx): () => Promise<ReadonlyArray<IdRosterEntry>> {
  return async () => {
    const entries: IdRosterEntry[] = [];
    for (const env of await ctx.listEnvs()) {
      try {
        const detail = (await ctx.openClient().get(
          `/api/environments/${encodeURIComponent(env.id)}`,
        )) as EnvDetail;
        for (const device of detail.devices) entries.push({ id: device.id, name: device.name });
      } catch {
        // unreadable env — skipped (best-effort roster)
      }
    }
    return entries;
  };
}

/**
 * `eaf device get <deviceId>` (T-038): one device's full detail (GET
 * /api/devices/:id) — the server's privacy projection applies, so the
 * fields a stranger sees are the redacted view. T88: <deviceId> accepts a
 * short prefix, resolved against the visible roster on 404.
 */
async function getDevice(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_GET);
  const id = requirePositional(positionals, 'deviceId', USAGE_GET);
  const device = (await getWithIdPrefix(ctx, {
    kind: 'device',
    ref: id,
    get: full => ctx.openClient().get(`/api/devices/${encodeURIComponent(full)}`),
    roster: deviceRoster(ctx),
    listHint: 'eaf device list --env <id|name>',
  })) as EnvDevice & {
    state?: Record<string, unknown> | null;
  };
  if (ctx.json) {
    ctx.out.data(device);
    return;
  }
  ctx.out.line(`device ${device.id} "${device.name}" (${device.type}${device.brand !== null ? `, ${device.brand}` : ''})`);
  ctx.out.line(`  env=${device.envId} zone=${device.zoneId} owner=${device.owner.displayName}`);
  ctx.out.line(`  capabilities: ${device.capabilities.join(', ') || '-'}`);
  if (device.commands !== undefined) ctx.out.line(`  commands: ${device.commands.join(', ') || '-'}`);
  if (device.position !== null) ctx.out.line(`  position: ${JSON.stringify(device.position)}`);
  if (device.state !== undefined && device.state !== null) {
    ctx.out.line(`  state: ${JSON.stringify(device.state)}`);
  }
}

/** `--at "a,b"` → geo envs: {lat: b, lng: a} ("lng,lat"); grid: {x: a, y: b} ("x,y"). */
function parseAt(raw: string, mapType: string): Record<string, number> {
  const parts = raw.split(',').map(part => Number(part.trim()));
  if (parts.length !== 2 || parts.some(value => !Number.isFinite(value))) {
    throw usageError(`--at must be two comma-separated numbers ("lng,lat" for geo, "x,y" for grid), got ${JSON.stringify(raw)}`);
  }
  if (mapType === 'geo') return { lng: parts[0], lat: parts[1] };
  return { x: parts[0], y: parts[1] };
}

async function addDevice(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      env: { type: 'string' },
      zone: { type: 'string' },
      name: { type: 'string' },
      at: { type: 'string' },
      model: { type: 'string' },
      type: { type: 'string' },
      brand: { type: 'string' },
      capabilities: { type: 'string' },
      'initial-state': { type: 'string' },
      binding: { type: 'string' },
    },
    USAGE_ADD,
  );
  if (positionals.length > 0) throw usageError(`unexpected arguments: ${positionals.join(' ')}\nusage: ${USAGE_ADD}`);
  const envRef = requireString(flags, 'env', USAGE_ADD);
  const zoneId = requireString(flags, 'zone', USAGE_ADD);
  const detail = await ctx.resolveEnv(envRef);
  const position = stringFlag(flags, 'at') !== undefined ? parseAt(stringFlag(flags, 'at')!, detail.mapType) : undefined;
  const model = stringFlag(flags, 'model');
  const binding = stringFlag(flags, 'binding');
  const client = ctx.authedClient();

  let device: EnvDevice | EnvProposal;
  if (model !== undefined) {
    device = (await client.post(`/api/environments/${encodeURIComponent(detail.id)}/devices:instantiate`, {
      modelId: model,
      ...(stringFlag(flags, 'name') !== undefined ? { name: stringFlag(flags, 'name') } : {}),
      zoneId,
      ...(position ? { position } : {}),
    })) as EnvDevice;
  } else {
    const type = requireString(flags, 'type', USAGE_ADD);
    const capabilities = csvFlag(flags, 'capabilities');
    if (!capabilities || capabilities.length === 0) {
      throw usageError(`missing required flag --capabilities (comma-separated)\nusage: ${USAGE_ADD}`);
    }
    device = (await client.post(`/api/environments/${encodeURIComponent(detail.id)}/devices`, {
      name: requireString(flags, 'name', USAGE_ADD),
      type,
      ...(stringFlag(flags, 'brand') !== undefined ? { brand: stringFlag(flags, 'brand') } : {}),
      capabilities,
      zoneId,
      ...(position ? { position } : {}),
      ...(jsonFlag(flags, 'initial-state', USAGE_ADD) !== undefined
        ? { initialState: jsonFlag(flags, 'initial-state', USAGE_ADD) }
        : {}),
      // Fix-18 (R7 F-01): a hass:// binding rides the create; the pipeline
      // force-escalates it to the environment owner for approval.
      ...(binding !== undefined ? { binding } : {}),
    })) as EnvDevice;
  }
  if (isEnvProposal(device)) {
    // Fix-1: a builder's add was converted into an install-devices proposal.
    // Fix-10: --json always flags it; an auto-applied proposal names the
    // created ids instead of sending the user back to `device list`.
    if (ctx.json) {
      ctx.out.data({ ...device, proposal: true });
    } else {
      const applied = proposalAppliedSummary(device);
      if (applied) {
        ctx.out.line(applied);
      } else if (binding !== undefined && binding.startsWith('hass://')) {
        ctx.out.line(
          `proposal ${device.id} submitted (install-devices → ${device.status}) — ` +
          t(ctx.lang, 'device.hardwareBinding.proposal', { binding }),
        );
      } else {
        ctx.out.line(
          `proposal ${device.id} submitted (install-devices → ${device.status}) — ` +
          'the device lands in the world when the pipeline approves it',
        );
      }
    }
    return;
  }
  if (ctx.json) {
    ctx.out.data(device);
  } else {
    ctx.out.line(`device ${device.id} "${device.name}" (${device.type}) added to zone ${device.zoneId}`);
  }
}

/**
 * `eaf device update <deviceId>` (R98, simtest-r1 li-03): rename / re-zone /
 * re-capability a device. env owner: the direct PATCH returns the updated
 * device; a builder updating THEIR OWN device is converted server-side into
 * a modify-object proposal (same governed lane as `device add`/`device rm`,
 * same patch semantics as the Web edit form).
 */
async function updateDevice(ctx: Ctx, argv: string[]): Promise<void> {
  const { flags, positionals } = parse(
    argv,
    {
      name: { type: 'string' },
      type: { type: 'string' },
      brand: { type: 'string' },
      capabilities: { type: 'string' },
      zone: { type: 'string' },
      at: { type: 'string' },
      'initial-state': { type: 'string' },
      binding: { type: 'string' },
    },
    USAGE_UPDATE,
  );
  const id = requirePositional(positionals, 'deviceId', USAGE_UPDATE);
  const body: Record<string, unknown> = {};
  if (stringFlag(flags, 'name') !== undefined) body.name = stringFlag(flags, 'name');
  if (stringFlag(flags, 'type') !== undefined) body.type = stringFlag(flags, 'type');
  if (stringFlag(flags, 'brand') !== undefined) body.brand = stringFlag(flags, 'brand');
  const capabilities = csvFlag(flags, 'capabilities');
  if (capabilities !== undefined) body.capabilities = capabilities;
  if (stringFlag(flags, 'zone') !== undefined) body.zoneId = stringFlag(flags, 'zone');
  const initialState = jsonFlag(flags, 'initial-state', USAGE_UPDATE);
  if (initialState !== undefined) body.initialState = initialState;
  if (stringFlag(flags, 'binding') !== undefined) body.binding = stringFlag(flags, 'binding');
  const at = stringFlag(flags, 'at');
  if (at !== undefined) {
    // Position parsing needs the world's map tier — read it off the device.
    const device = (await ctx.openClient().get(`/api/devices/${encodeURIComponent(id)}`)) as EnvDevice;
    const detail = await ctx.resolveEnv(device.envId);
    body.position = parseAt(at, detail.mapType);
  }
  if (Object.keys(body).length === 0) {
    throw usageError(
      'nothing to update — pass --name, --type, --brand, --capabilities, --zone, --at, --initial-state or --binding' +
      `\nusage: ${USAGE_UPDATE}`,
    );
  }
  const result = (await ctx.authedClient().patch(
    `/api/devices/${encodeURIComponent(id)}`,
    body,
  )) as EnvDevice | EnvProposal;
  // R98: a builder's update of their own device comes back as the
  // auto-submitted modify-object proposal — report it truthfully (same
  // shape as `device rm`'s conversion).
  if (isEnvProposal(result)) {
    if (ctx.json) {
      ctx.out.data({ ...result, proposal: true });
    } else {
      const applied = proposalAppliedSummary(result);
      if (applied) {
        ctx.out.line(applied);
      } else if (result.status === 'rejected') {
        ctx.out.line(
          `proposal ${result.id} was rejected by the rule check — ` +
          (result.ruleCheck?.issues?.join(' | ') ?? 'see the proposal for details'),
        );
      } else {
        ctx.out.line(
          `proposal ${result.id} submitted (modify-object → ${result.status}) — ` +
          `the change to device ${id} lands when the pipeline approves it`,
        );
      }
    }
    return;
  }
  if (ctx.json) {
    ctx.out.data(result);
  } else {
    ctx.out.line(`device ${result.id} "${result.name}" (${result.type}) updated in zone ${result.zoneId}`);
  }
}

async function removeDevice(ctx: Ctx, argv: string[]): Promise<void> {
  const { positionals } = parse(argv, {}, USAGE_RM);
  const id = requirePositional(positionals, 'deviceId', USAGE_RM);
  const result = await ctx.authedClient().delete(`/api/devices/${encodeURIComponent(id)}`);
  // Fix-7: in a shared environment a builder's rm of their own device becomes
  // a remove-devices proposal — say so plainly instead of claiming deletion.
  if (isEnvProposal(result)) {
    if (ctx.json) {
      ctx.out.data({ ...result, proposal: true });
    } else {
      const applied = proposalAppliedSummary(result);
      if (applied) {
        ctx.out.line(applied);
      } else {
        ctx.out.line(
          `proposal ${result.id} submitted (remove-devices → ${result.status}) — ` +
          `device ${id} is removed when the pipeline approves it`,
        );
      }
    }
    return;
  }
  if (ctx.json) ctx.out.data({ deleted: id });
  else ctx.out.line(`deleted device ${id}`);
}
