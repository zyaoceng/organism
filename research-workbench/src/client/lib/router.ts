import { useEffect, useState } from 'react';

export type Tab = 'overview' | 'model' | 'evidence' | 'valuation' | 'catalysts' | 'market' | 'trades' | 'history';
export const TABS: { id: Tab; label: string; key: string }[] = [
  { id: 'overview', label: 'Overview', key: 'o' },
  { id: 'model', label: 'Model', key: 'm' },
  { id: 'evidence', label: 'Evidence', key: 'e' },
  { id: 'valuation', label: 'Valuation', key: 'v' },
  { id: 'catalysts', label: 'Catalysts', key: 'c' },
  { id: 'market', label: 'Market', key: 'k' },
  { id: 'trades', label: 'Trades', key: 't' },
  { id: 'history', label: 'History', key: 'h' },
];

export type Route = { page: 'projects' } | { page: 'project'; projectId: string; tab: Tab; param?: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) {
    const tab = (TABS.find((t) => t.id === parts[2])?.id ?? 'model') as Tab;
    return { page: 'project', projectId: parts[1], tab, param: parts[3] };
  }
  return { page: 'projects' };
}

export function href(route: Route): string {
  if (route.page === 'projects') return '#/';
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
  return route;
}
