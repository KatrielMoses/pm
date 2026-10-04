import { Link } from '../router.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { useCommands } from './commands.tsx';
import { usePreferences } from './preferences.tsx';
import { isSingleKey, shortcutLabel } from './shortcuts.ts';

const LAYER_TITLE = {
  global: 'Everywhere',
  view: 'In lists',
  record: 'On a record',
  editor: 'While typing',
} as const;

/**
 * Shortcut reference (A11Y-KB-06): every shortcut the current person can use, with its platform
 * label, and whether single-key shortcuts are on. Each listed command also exists in the palette
 * or as a visible control.
 */
export function ShortcutReference() {
  const { commands, setHelpOpen } = useCommands();
  const { singleKeyShortcuts } = usePreferences();
  const withKeys = commands.filter((c) => c.shortcut);
  const layers = (['global', 'view', 'record'] as const).map((layer) => ({
    layer,
    items: withKeys.filter((c) => (c.layer ?? 'global') === layer),
  }));
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => setHelpOpen(false)}>
      <p>
        Single-key shortcuts are {singleKeyShortcuts ? 'on' : 'off'}. They never act while you type
        in a field.{' '}
        <Link to="/settings/preferences" onClick={() => setHelpOpen(false)}>
          Change in Preferences
        </Link>
      </p>
      {layers.map(({ layer, items }) =>
        items.length ? (
          <section key={layer} aria-labelledby={`sc-${layer}`}>
            <h3 id={`sc-${layer}`}>{LAYER_TITLE[layer]}</h3>
            <dl className="shortcut-list">
              {items.map((c) => (
                <div key={c.id} className="shortcut-row">
                  <dt>{c.label}</dt>
                  <dd>
                    <kbd>{shortcutLabel(c.shortcut!)}</kbd>
                    {isSingleKey(c.shortcut!) && !singleKeyShortcuts ? (
                      <span className="hint"> (off)</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null,
      )}
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          data-initial
          onClick={() => setHelpOpen(false)}
        >
          Close
        </button>
      </div>
    </Dialog>
  );
}
