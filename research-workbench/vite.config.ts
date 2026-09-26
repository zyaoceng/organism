import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.WORKBENCH_PORT ?? 4310);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${serverPort}` },
  },
  build: { outDir: 'dist/client', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
