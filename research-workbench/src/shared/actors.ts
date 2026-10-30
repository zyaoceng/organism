/**
 * Who did something. Every write records an actor: the user (browser cookie or user token), an AI
 * client (its own token from tokens.json) or the server itself (background work, CLIs, seeding).
 * This is attribution, not security: any program on the same Mac can read tokens.json.
 *
 * Stored values (audit_log.actor, *.created_by, draft_ops.actor): 'user', 'system' or
 * 'agent:<client>'. Bare client ids appear only in ai_sessions.client and ai_clients.client.
 */
export const AGENT_CLIENTS = ['claude-desktop', 'claude-code', 'chatgpt'] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

/** Keys of tokens.json: one per caller that gets its own token. */
export const TOKEN_NAMES = ['user', ...AGENT_CLIENTS] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export type AgentActor = `agent:${AgentClient}`;
export type Actor = 'user' | 'system' | AgentActor;

export const isAgentClient = (c: unknown): c is AgentClient => typeof c === 'string' && (AGENT_CLIENTS as readonly string[]).includes(c);

export const isAgentActor = (a?: string | null): a is AgentActor => !!a && a.startsWith('agent:') && isAgentClient(a.slice(6));

/** The client id of an agent actor ('agent:claude-desktop' → 'claude-desktop'), else null. */
export const agentClientOf = (a?: string | null): AgentClient | null => (isAgentActor(a) ? (a.slice(6) as AgentClient) : null);

/** The actor a token name stands for. */
export function actorFor(name: TokenName): Actor {
  return name === 'user' ? 'user' : `agent:${name}`;
}

export const CLIENT_LABEL: Record<'en' | 'zh-TW', Record<AgentClient, string>> = {
  en: { 'claude-desktop': 'Claude Desktop', 'claude-code': 'Claude Code', chatgpt: 'ChatGPT desktop' },
  'zh-TW': { 'claude-desktop': 'Claude 桌面版', 'claude-code': 'Claude Code', chatgpt: 'ChatGPT 桌面版' },
};

/** Display name of a stored actor. Rows written before schema v2 have none. */
export function actorLabel(a: string | null | undefined, lang: 'en' | 'zh-TW'): string {
  const zh = lang === 'zh-TW';
  if (!a) return zh ? 'v2 之前' : 'before v2';
  if (a === 'user') return zh ? '你' : 'You';
  if (a === 'system') return zh ? '系統' : 'System';
  const c = agentClientOf(a);
  return c ? CLIENT_LABEL[lang][c] : a;
}
