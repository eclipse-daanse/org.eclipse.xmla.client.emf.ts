import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    outDir: 'browsercheck/dist',
    lib: { entry: 'browsercheck/entry.ts', formats: ['iife'], name: 'Check', fileName: () => 'check.js' },
    minify: false,
  },
});
