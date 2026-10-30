import { useEffect } from 'react';
import { ProjectShell } from './components/ProjectShell';
import { ensureSession } from './lib/api';
import { useLang } from './lib/i18n';
import { useRoute, type Route } from './lib/router';
import { unsavedWork, useWorkspace } from './lib/store';
import { cls } from './lib/util';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const route = useRoute();
  // Re-render the whole tree when the interface language changes.
  useLang();
  useEffect(() => {
    // The identity cookie for this browser; every write is refused without it.
    ensureSession()
      .then((s) => {
        if (!useWorkspace.getState().dbGeneration) useWorkspace.setState({ dbGeneration: s.dbGeneration });
      })
      .catch(() => undefined);
  }, []);
  return (
    <>
      <Page route={route} />
      <Toasts />
      <UnloadGuard />
    </>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'projects':
      return <ProjectsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'project':
      return <ProjectShell projectId={route.projectId} tab={route.tab} param={route.param} />;
  }
}

function Toasts() {
  const toasts = useWorkspace((s) => s.toasts);
  const dismiss = useWorkspace((s) => s.dismissToast);
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', t.kind)} onClick={() => dismiss(t.id)} data-testid="toast">
          {t.text}
          {t.action && (
            <button
              className="btn xs toast-action"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
                t.action!.run();
              }}
              data-testid="toast-action"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Warn before closing the tab while a draft save is still in flight or a conflict is unresolved. */
function UnloadGuard() {
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (unsavedWork(useWorkspace.getState())) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, []);
  return null;
}
