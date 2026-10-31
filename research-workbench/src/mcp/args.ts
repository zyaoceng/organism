/**
 * Command line of the MCP adapter. AI apps start it with absolute paths written by the installer
 * (GUI apps do not inherit the shell's environment):
 *   node research-workbench-mcp.mjs --client=claude-desktop --data-dir=/Users/…/ResearchWorkbench --port=4310
 */
import path from 'node:path';
import { AGENT_CLIENTS, isAgentClient, type AgentClient } from '../shared/actors';

export interface AdapterArgs {
  client: AgentClient;
  /** Folder holding tokens.json (the server's data folder). */
  dataDir: string;
  port: number;
  /** The server listens on loopback only. */
  host: '127.0.0.1';
}

export class ArgsError extends Error {
  override name = 'ArgsError';
}

export const USAGE = `usage: research-workbench-mcp --client=<${AGENT_CLIENTS.join('|')}> --data-dir=<absolute path> [--port=4310]`;

const KNOWN = new Set(['client', 'data-dir', 'port']);

/** Parse `--name=value` or `--name value`; WORKBENCH_DATA_DIR and WORKBENCH_PORT are fallbacks. */
export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): AdapterArgs {
  const given: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !KNOWN.has(m[1])) throw new ArgsError(`unknown argument: ${a}`);
    let value = m[2];
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ArgsError(`--${m[1]} needs a value`);
      i++;
    }
    given[m[1]] = value;
  }

  const client = given.client;
  if (!client) throw new ArgsError('--client is required');
  if (!isAgentClient(client)) throw new ArgsError(`--client must be one of ${AGENT_CLIENTS.join(', ')} (got "${client}")`);

  const dataDir = given['data-dir'] ?? env.WORKBENCH_DATA_DIR;
  if (!dataDir) throw new ArgsError('--data-dir is required (or set WORKBENCH_DATA_DIR)');
  if (!path.isAbsolute(dataDir)) throw new ArgsError(`--data-dir must be an absolute path (got "${dataDir}")`);

  const portText = given.port ?? env.WORKBENCH_PORT ?? '4310';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new ArgsError(`--port must be a TCP port (got "${portText}")`);

  return { client, dataDir: path.normalize(dataDir), port, host: '127.0.0.1' };
}
