import type { Block, Doc } from './client.ts';
import { LiveNotice, LiveStatusLine, PresenceList, useLiveEngine } from './live-ui.tsx';
import { DocView } from './render.tsx';

/**
 * A read-only page that follows the shared document live (ADR-0027 C4, C9): people who may read
 * but not edit see other people's changes as they arrive, and who is here. It says nothing while
 * the plain page is simply shown (live editing off, full, or unavailable).
 */
export function LiveReadView({
  ws,
  doc,
  suggest,
}: {
  ws: string;
  doc: Doc;
  suggest?: (b: Block) => void;
}) {
  const { engine, state } = useLiveEngine({
    ws,
    doc: doc.id,
    mode: 'view',
    enabled: true,
    getBlocks: () => [],
    onBlocks: () => undefined,
    initialView: doc.content.blocks,
    initialRefs: doc.references,
    savedAt: Date.parse(doc.updated_at) || null,
    contentVersion: doc.content_version,
  });
  const following = state.active && state.mode === 'view';
  const blocks = following ? state.viewBlocks : state.locked ? state.viewBlocks : doc.content.blocks;
  return (
    <>
      <div className="live-bar">
        <LiveStatusLine state={state} onRetry={() => engine?.retry()} quietWhenPlain />
        {following ? <PresenceList presence={state.presence} /> : null}
        <LiveNotice state={state} />
      </div>
      <DocView
        content={{ v: 2, blocks }}
        refs={{ ...doc.references, ...state.references }}
        idBase="read"
        {...(suggest ? { suggest } : {})}
      />
    </>
  );
}
