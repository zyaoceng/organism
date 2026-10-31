import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type AppContext } from './app';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.WORKBENCH_DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.WORKBENCH_PORT ?? 4310);
// Bind to localhost by default: V1 has no authentication.
const host = process.env.WORKBENCH_HOST ?? '127.0.0.1';
const level = process.env.WORKBENCH_LOG_LEVEL?.trim();
const logger = process.env.WORKBENCH_QUIET ? false : level ? { level } : true;

// Requests must name this server; a web page on another site (or a DNS-rebound name) is refused.
const allowedHosts = [
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  ...(['127.0.0.1', 'localhost', '0.0.0.0', '::'].includes(host) ? [] : [`${host.includes(':') ? `[${host}]` : host}:${port}`]),
  ...(process.env.WORKBENCH_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
];

let ctx: AppContext;
try {
  // daily backups start once the port is ours (below), not in an instance that is about to fail
  ctx = await buildApp({
    dataDir,
    logger,
    clientDir: path.join(root, 'dist/client'),
    allowedHosts,
    // Obsidian's requestUrl may send this Origin; the vault routes need the Obsidian token anyway
    allowedOrigins: ['app://obsidian.md'],
    publicUrl: `http://127.0.0.1:${port}`,
  });
} catch (e) {
  console.error(`Research Workbench could not start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const { app, backups } = ctx;

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info(`${signal}: shutting down`);
  // launchd sends SIGKILL after 20 seconds; give up a little earlier.
  setTimeout(() => {
    console.error('Research Workbench: shutdown timed out');
    process.exit(1);
  }, 10_000).unref();
  try {
    await backups.stop(); // waits for a backup that is being written
    await app.close(); // closes the database (onClose hook)
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port, host });
} catch (e) {
  // e.g. the port is taken by another copy of the server
  console.error(`Research Workbench could not start: ${e instanceof Error ? e.message : String(e)}`);
  await app.close().catch(() => {});
  process.exit(1);
}
if (!closing) backups.start();
console.log(`Research Workbench API on http://${host}:${port}  (data: ${dataDir})`);
