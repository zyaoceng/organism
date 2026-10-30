import { useEffect, useState } from 'react';

export type Tab = 'model' | 'valuation' | 'trades' | 'history' | 'evidence' | 'catalysts' | 'overview';
/** Main tabs first; `more` tabs are listed under "More" in advanced mode (their routes always work). */
export const TABS: { id: Tab; label: string; more?: boolean }[] = [
  { id: 'model', label: 'Model' },
  { id: 'valuation', label: 'Valuation' },
  { id: 'trades', label: 'Trades' },
  { id: 'history', label: 'History' },
  { id: 'evidence', label: 'Evidence', more: true },
  { id: 'catalysts', label: 'Catalysts', more: true },
  { id: 'overview', label: 'Overview', more: true },
];

/** Old routes that now live on another tab (Market was merged into Trades). */
const ALIASES: Record<string, Tab> = { market: 'trades' };

export type Route = { page: 'projects' } | { page: 'project'; projectId: string; tab: Tab; param?: string } | { page: 'settings' } | { page: 'journal' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'settings') return { page: 'settings' };
  if (parts[0] === 'journal') return { page: 'journal' };
  if (parts[0] === 'p' && parts[1]) {
    const id = ALIASES[parts[2]] ?? parts[2];
    const tab = (TABS.find((t) => t.id === id)?.id ?? 'model') as Tab;
    return { page: 'project', projectId: parts[1], tab, param: parts[3] };
  }
  return { page: 'projects' };
}

export function href(route: Route): string {
  if (route.page === 'projects') return '#/';
  if (route.page === 'settings') return '#/settings';
  if (route.page === 'journal') return '#/journal';
  return `#/p/${encodeURIComponent(route.projectId)}/${route.tab}${route.param ? `/${encodeURIComponent(route.param)}` : ''}`;
}

export function navigate(route: Route) {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    // Show the current address after an old one (#/p/x/market → #/p/x/trades). replaceState fires no hashchange.
    const tab = window.location.hash.replace(/^#\/?/, '').split('/')[2];
    if (route.page === 'project' && tab && tab in ALIASES) history.replaceState(null, '', href(route));
  }, [route]);
  return route;
}
