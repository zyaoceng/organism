/**
 * Bundle the MCP adapter into one file, dist/mcp/research-workbench-mcp.mjs, that the AI apps run
 * with the installer's Node (npm run build:mcp, part of npm run build). The bundle must stay free of
 * the server and the client: no better-sqlite3 (a native module), Fastify or React.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const MCP_BUNDLE = path.join(APP_ROOT, 'dist/mcp/research-workbench-mcp.mjs');

const FORBIDDEN = /(^|\/)src\/(server|client)\/|node_modules\/(better-sqlite3|fastify|@fastify|react|react-dom)\//;

export async function buildMcp(outfile = MCP_BUNDLE): Promise<string> {
  const r = await build({
    entryPoints: [path.join(APP_ROOT, 'src/mcp/main.ts')],
    absWorkingDir: APP_ROOT,
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
    // bundled CommonJS packages call require() for Node built-ins
    banner: { js: "import { createRequire as __wbcr } from 'node:module'; const require = __wbcr(import.meta.url);" },
  });
  const bad = Object.keys(r.metafile.inputs).filter((f) => FORBIDDEN.test(f));
  if (bad.length) throw new Error(`MCP adapter must not import: ${bad.join(', ')}`);
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMcp(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
    .then((f) => console.log(`built ${path.relative(process.cwd(), f) || f}`))
    .catch((e: Error) => {
      console.error(e.message);
      process.exit(1);
    });
}
