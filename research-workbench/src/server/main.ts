import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.WORKBENCH_DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.WORKBENCH_PORT ?? 4310);
// Bind to localhost by default: V1 has no authentication.
const host = process.env.WORKBENCH_HOST ?? '127.0.0.1';

const { app } = await buildApp({ dataDir, logger: process.env.WORKBENCH_QUIET ? false : true, clientDir: path.join(root, 'dist/client') });
await app.listen({ port, host });
console.log(`Research Workbench API on http://${host}:${port}  (data: ${dataDir})`);
