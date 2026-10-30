import { useEffect } from 'react';
import { useWorkspace } from './store';

const POLL_MS = 10_000;

/**
 * Keep the open project in step with writes made elsewhere (an AI client, another window): poll
 * the draft's version every 10 seconds and whenever the window comes back to the front.
 */
export function useDraftSync(projectId: string) {
  useEffect(() => {
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (useWorkspace.getState().projectId !== projectId) return;
      void useWorkspace.getState().syncNow();
    };
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    const timer = setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [projectId]);
}
