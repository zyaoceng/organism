/**
 * MCP adapter: an AI app (Claude Desktop, Claude Code, ChatGPT/Codex) starts this process and talks
 * to it over stdin/stdout; it calls the workbench server over HTTP with this client's token.
 * Stdout carries only JSON-RPC: everything else goes to stderr, which the apps write to their logs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_INSTRUCTIONS } from '../shared/aiInstructions';
import { ArgsError, parseArgs, USAGE } from './args';
import { WorkbenchHttp } from './http';
import { registerTools } from './tools';

// a stray console.log would corrupt the protocol stream
console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.debug = console.error.bind(console);
process.on('unhandledRejection', (e) => console.error('[research-workbench-mcp] unhandled rejection:', e));

/**
 * The installed commit, from version.json two folders up: dist/mcp/research-workbench-mcp.mjs (the
 * bundle) and src/mcp/main.ts (npm run mcp) both sit two levels below the app folder.
 */
function adapterVersion(): string {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../version.json');
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { commit?: unknown };
    if (typeof v.commit === 'string' && v.commit.trim()) return v.commit.trim();
  } catch {
    // a development checkout has no version.json
  }
  return 'dev';
}

let args;
try {
  args = parseArgs(process.argv.slice(2), process.env);
} catch (e) {
  if (!(e instanceof ArgsError)) throw e;
  process.stderr.write(`research-workbench-mcp: ${e.message}\n${USAGE}\n`);
  process.exit(2);
}

const ADAPTER_VERSION = adapterVersion();
const http = new WorkbenchHttp({ baseUrl: `http://${args.host}:${args.port}`, dataDir: args.dataDir, client: args.client });
const server = new McpServer({ name: 'research-workbench', version: ADAPTER_VERSION }, { instructions: MCP_INSTRUCTIONS });
registerTools(server, http, { port: args.port });

// "Claude 桌面版 最後連線 10:32" on the settings page; a server that is down is not an error here
const heartbeat = () => {
  const info = server.server.getClientVersion();
  http
    .post('/api/ai/heartbeat', { clientInfo: info ? { name: info.name, version: info.version } : undefined, adapterVersion: ADAPTER_VERSION }, { tool: 'heartbeat', timeoutMs: 5_000 })
    .catch(() => undefined);
};
server.server.oninitialized = heartbeat;
setInterval(heartbeat, 600_000).unref();

const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
// the app closed our stdin: nothing more will arrive
process.stdin.on('end', () => process.exit(0));
await server.connect(transport);
