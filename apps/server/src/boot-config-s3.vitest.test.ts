/**
 * @vitest-environment node
 *
 * S3 (Task 1): boot-visible JWT key provenance. loadConfig's strict-mode
 * refusal is covered in config.vitest.test.ts; these tests pin the SERVER
 * side — a dev boot stays zero-config and its FIRST log lines state which
 * JWT key is in use (default vs operator-provided), so a deployment running
 * on the public development key is visible without reading docs.
 *
 * Vitest sets NODE_ENV=test, which is the non-strict path — exactly the
 * "boots in dev with default" acceptance case.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import { buildTestServer } from './test-utils.js';

/** Capture pino's output: fastify threads `logger.stream` to pino's destination. */
function capturingStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
}

describe('S3 Task 1: boot log states the JWT key provenance', () => {
  const apps: FastifyInstance[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function bootWithSecretLogs(jwtSecret?: string): Promise<string> {
    const lines: string[] = [];
    const userDir = mkdtempSync(join(tmpdir(), 'eaf-boot-s3-'));
    dirs.push(userDir);
    const app = await buildTestServer({
      userDir,
      trajectoryDir: join(userDir, 'traj'),
      databasePath: ':memory:',
      webDist: join(userDir, 'no-web-dist'),
      logger: { level: 'info', stream: capturingStream(lines) } as Record<string, unknown>,
      ...(jwtSecret !== undefined ? { jwtSecret } : {}),
    });
    apps.push(app);
    return lines.join('\n');
  }

  it('boots in dev with the default key and WARNS about it in the boot log', async () => {
    const log = await bootWithSecretLogs();
    expect(log).toContain('JWT auth key');
    expect(log).toContain('BUILT-IN DEVELOPMENT default');
    expect(log).toContain('openssl rand -hex 32');
  });

  it('an operator-provided JWT_SECRET is stated in the boot log (info, no secret leaked)', async () => {
    const secret = 's3-operator-secret-' + 'x'.repeat(32);
    const log = await bootWithSecretLogs(secret);
    expect(log).toContain('JWT auth key: operator-provided JWT_SECRET is in use');
    // Never log the key itself — provenance only.
    expect(log).not.toContain(secret);
    expect(log).not.toContain('BUILT-IN DEVELOPMENT');
  });
});
