import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  // The models are read from disk in Node and inlined for the browser. Until
  // that inlining exists, the app runs against the recorded conversations.
  optimizeDeps: { exclude: ['@daanse/xmla-model'] },
});
