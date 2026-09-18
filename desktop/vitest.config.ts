import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// Pin the Vitest root to this desktop package directory so running Vitest from
// anywhere (e.g. the repository root) still only scans desktop/tests and never
// accidentally picks up upstream s2s/ sources.
const desktopRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: desktopRoot,
  plugins: [vue()],
  resolve: {
    alias: {
      // Must stay in sync with vite.config.ts: shared cross-stage contracts.
      '@contracts': fileURLToPath(
        new URL('../packages/contracts/src', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Never let an empty run be reported as success (FND-003 must add real
    // contract cases before test:contracts can turn green).
    passWithNoTests: false,
  },
});
