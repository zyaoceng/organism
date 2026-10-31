import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.WORKBENCH_PORT ?? 4310);
const api = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // GitHub Codespaces opens the dev server through *.app.github.dev
    allowedHosts: ['.app.github.dev'],
    proxy: {
      '/api': {
        target: api,
        // the API accepts only its own Host and Origin (src/server/app.ts allowedHosts)
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // a page served by this dev server counts as the API's own origin; any other origin is passed on and refused
            const origin = req.headers.origin;
            if (origin && req.headers.host && origin.replace(/^https?:\/\//, '') === req.headers.host) proxyReq.setHeader('origin', api);
          });
        },
      },
    },
  },
  build: { outDir: 'dist/client', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'obsidian-plugin/test/**/*.test.ts'],
    environment: 'node',
  },
});
