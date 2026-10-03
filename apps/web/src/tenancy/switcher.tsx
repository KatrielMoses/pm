import { useId, useState } from 'react';
import { ApiError } from '../api.ts';
import { Banner } from '../ui/feedback.tsx';
import { tenancy, type WorkspaceContext } from './client.ts';

/**
 * Compact brand-scope switcher: one brand or all authorized brands (WSB-006). Reusable; Phase 1E
 * places it in the final shell. The server derives the scope and validates the stored preference
 * on every read, so this component only displays what the server returned and asks it to change.
 */
export function ContextSwitcher({
  workspaceId,
  context,
  onChange,
}: {
  workspaceId: string;
  context: WorkspaceContext;
  onChange: (next: WorkspaceContext) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const brands = context.brands;
  const value =
    context.scope.kind === 'all'
      ? 'all'
      : context.scope.kind === 'brand'
        ? context.scope.brand_id
        : '';
  if (!brands.length)
    return (
      <p className="switcher-empty" role="status">
        No active brands yet.
      </p>
    );
  const change = async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      const ctx = await tenancy.select(
        workspaceId,
        next === 'all' ? { scope: 'all' } : { scope: 'brand', brand_id: next },
      );
      onChange(ctx);
      setSaid(
        ctx.scope.kind === 'all'
          ? `Now showing all ${ctx.brands.length} brands you can access.`
          : `Now showing ${ctx.brands.find((b) => ctx.scope.kind === 'brand' && b.id === ctx.scope.brand_id)?.name ?? 'the selected brand'}.`,
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="switcher">
      <label htmlFor={id}>Showing</label>
      <select
        id={id}
        value={value}
        disabled={busy}
        aria-describedby={`${id}-desc`}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="all">All brands ({brands.length})</option>
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.is_sensitive ? ' (sensitive)' : ''}
          </option>
        ))}
      </select>
      <p id={`${id}-desc`} className="hint">
        All brands means every active brand you can access. Archived brands are not included.
      </p>
      {context.fallback === 'stale_selection' ? (
        <Banner tone="info" title="Your last selection is no longer available">
          It may have been archived or your access changed. We picked another brand you can access.
        </Banner>
      ) : null}
      {error ? (
        <Banner
          tone="danger"
          title={
            error instanceof ApiError && error.code === 'not_found'
              ? "That brand isn't available anymore"
              : error instanceof ApiError && error.offline
                ? "You're offline. Try again when you're connected."
                : "We couldn't switch. Try again."
          }
        />
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
