import { useEffect } from 'react';
import { ProjectShell } from './components/ProjectShell';
import { useLang } from './lib/i18n';
import { useRoute } from './lib/router';
import { useWorkspace } from './lib/store';
import { cls } from './lib/util';
import { ProjectsPage } from './pages/ProjectsPage';

export function App() {
  const route = useRoute();
  // Re-render the whole tree when the interface language changes.
  useLang();
  return (
    <>
      {route.page === 'projects' ? <ProjectsPage /> : <ProjectShell projectId={route.projectId} tab={route.tab} param={route.param} />}
      <Toasts />
      <UnloadGuard />
    </>
  );
}

function Toasts() {
  const toasts = useWorkspace((s) => s.toasts);
  const dismiss = useWorkspace((s) => s.dismissToast);
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', t.kind)} onClick={() => dismiss(t.id)} data-testid="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Warn before closing the tab while a draft save is still in flight. */
function UnloadGuard() {
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      const st = useWorkspace.getState().saveStatus;
      if (st === 'pending' || st === 'saving' || st === 'error') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, []);
  return null;
}
