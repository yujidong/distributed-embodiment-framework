/**
 * Stale-dist self-check tests (Fix-6, usability P1-8).
 *
 * warnIfDistStale warns on stderr when the compiled entry under a `dist/`
 * directory is older than the newest non-test source file, and stays quiet
 * when the dist is fresh or the module isn't running from a dist build.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { warnIfDistStale } from './dist-freshness.js';

describe('warnIfDistStale', () => {
  let root: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eaf-dist-freshness-'));
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  /** Build a minimal dist/ + src/ tree with controlled mtimes. */
  function fixture(distAgeSec: number, srcAgeSec: number): string {
    const dist = join(root, 'dist');
    const src = join(root, 'src');
    mkdirSync(dist, { recursive: true });
    mkdirSync(src, { recursive: true });
    const entry = join(dist, 'index.js');
    writeFileSync(entry, '// compiled\n');
    writeFileSync(join(src, 'server.ts'), '// source\n');
    const now = Date.now() / 1000;
    utimesSync(entry, now - distAgeSec, now - distAgeSec);
    utimesSync(join(src, 'server.ts'), now - srcAgeSec, now - srcAgeSec);
    return entry;
  }

  it('warns when a source file is newer than the compiled entry', () => {
    warnIfDistStale(fixture(3600, 60));
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain('STALE build');
  });

  it('stays quiet when the dist is newer than the sources', () => {
    warnIfDistStale(fixture(60, 3600));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('ignores test files when computing the newest source mtime', () => {
    const entry = fixture(60, 3600);
    const testFile = join(root, 'src', 'server.vitest.test.ts');
    writeFileSync(testFile, '// test\n');
    // Just-written test file is newer than dist, but must not trigger a warning.
    warnIfDistStale(entry);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('is a no-op when not running from a dist directory', () => {
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    const entry = join(src, 'index.ts');
    writeFileSync(entry, '// source\n');
    warnIfDistStale(entry);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
