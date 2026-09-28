import { useEffect } from 'react';
import { DraftPanel } from '../components/DraftPanel';
import { Inspector } from '../components/Inspector';
import { TreeCanvas } from '../components/TreeCanvas';
import { createAndLink, namedScreenshot, uploadEvidenceFiles } from '../lib/evidence';
import { t } from '../lib/i18n';
import { useWorkspace } from '../lib/store';
import { isTypingTarget } from '../lib/util';

export function ModelPage({ param }: { param?: string }) {
  const select = useWorkspace((s) => s.select);

  useEffect(() => {
    if (param) select(param);
  }, [param, select]);

  // Paste a screenshot anywhere on the Model page → image evidence linked to the selected node.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      const { projectId, selectedNodeId, viewing, toast } = useWorkspace.getState();
      if (!projectId) return;
      if (viewing) return toast(t('Return to the draft to attach evidence.'), 'error');
      void createAndLink(() => uploadEvidenceFiles(projectId, files.map(namedScreenshot), { sourceType: 'screenshot' }), selectedNodeId, 'supports');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  return (
    <div className="workspace">
      <div className="canvas">
        <TreeCanvas />
      </div>
      <div className="inspector">
        <Inspector />
      </div>
      <DraftPanel />
    </div>
  );
}
