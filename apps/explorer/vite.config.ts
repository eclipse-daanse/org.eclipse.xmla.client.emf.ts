import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  server: {
    // So the app can be opened without a CORS-aware server in front of it:
    // /xmla is forwarded to the probe, and the browser sees one origin.
    proxy: {
      '/xmla': { target: process.env['XMLA_TARGET'] ?? 'http://localhost:8090', changeOrigin: true },
    },
  },
});
