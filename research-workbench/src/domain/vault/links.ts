/**
 * Links in generated text are placeholder tokens, [[wb:<id>|alias]], because only the plugin knows
 * where a note actually lives in the vault (the user may have moved or renamed it). The plugin
 * replaces each token with the note's path, or with the plain alias when the note does not exist.
 */
import { renderValue } from './frontmatter';
import type { RenderedNote, ResolvedNote } from './types';

/** [[wb:<id>|alias]], or [[wb:<id>\|alias]] inside a table cell (Obsidian's escaped pipe). */
export const LINK_TOKEN_RE = /\[\[wb:([^|\\\]\n]+)(\\?)\|([^[\]\n]*)\]\]/g;

/** Alias text that cannot end the link early: | [ ] become full-width, line breaks spaces. */
export const sanitizeAlias = (alias: string) =>
  alias.replace(/\|/g, '｜').replace(/\[/g, '［').replace(/\]/g, '］').replace(/\r\n?|\n/g, ' ');

/** `inTable` escapes the pipe so the link does not split a table cell. */
export const linkToken = (wbId: string, alias: string, inTable = false) => `[[wb:${wbId}${inTable ? '\\' : ''}|${sanitizeAlias(alias)}]]`;

/** Returns the vault path of a note without `.md`, or null when it has none. */
export type LinkLookup = (wbId: string) => string | null;

export function resolveLinks(text: string, lookup: LinkLookup): string {
  return text.replace(LINK_TOKEN_RE, (_m, id: string, esc: string, alias: string) => {
    const path = lookup(id);
    return path ? `[[${path}${esc}|${alias}]]` : alias;
  });
}

export function resolveNote(note: RenderedNote, lookup: LinkLookup): ResolvedNote {
  const linkText = (id: string, alias: string) => {
    const path = lookup(id);
    return path ? `[[${path}|${sanitizeAlias(alias)}]]` : null;
  };
  return {
    wbId: note.wbId,
    frontmatter: note.frontmatter.map(([k, v]) => [k, renderValue(v, linkText)]),
    block: resolveLinks(note.block, lookup),
    body: resolveLinks(note.body, lookup),
  };
}
