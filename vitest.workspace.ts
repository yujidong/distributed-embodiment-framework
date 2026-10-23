/**
 * Vitest Workspace Configuration
 *
 * Enables per-package vitest.config.ts to be loaded correctly
 * when running tests from the monorepo root.
 *
 * This ensures aliases (e.g. @lib, @components in web) and
 * per-package settings (environment, setupFiles, etc.) work properly.
 */

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*',
  'apps/*',
]);
