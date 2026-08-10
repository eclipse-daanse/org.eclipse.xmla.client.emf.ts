import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    // Per-file, via the @vitest-environment comment. Only the rendering tests
    // need a DOM, and paying for one everywhere would slow the rest down.
    environment: 'node',
  },
});
