import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageDir, '../..');

export default defineConfig({
  resolve: {
    alias: {
      // Client inspectors import app-shell helpers (`@/styles`, `@/store/tool/helpers`).
      '@/locales': path.resolve(repoRoot, 'packages/locales/src'),
      '@': path.resolve(repoRoot, 'src'),
    },
  },
  test: {
    environment: 'node',
  },
});
