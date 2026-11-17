import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['scripts/replay-history.capture.ts'], testTimeout: 60000 },
});
