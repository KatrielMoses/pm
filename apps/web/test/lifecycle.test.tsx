import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChangeList,
  DeletedItem,
  PermissionUnavailable,
  PurgeConfirmDialog,
  RestoreConflict,
  TrashMetadata,
} from '../src/ui/lifecycle.tsx';

afterEach(cleanup);

describe('audit change list', () => {
  it('shows values per class, never a secret, and explains redactions in text', () => {
    const { container } = render(
      <ChangeList
        changes={[
          { field: 'title', label: 'Title', class: 'plain', old: 'Old', new: 'New' },
          { field: 'api_key', label: 'API key', class: 'secret' },
          { field: 'body', label: 'Body', class: 'content', versionLabel: 'version 2' },
          { field: 'notes', label: 'Notes', redacted: true, reason: 'purge' },
        ]}
      />,
    );
    expect(screen.getByText('Title').nextElementSibling?.textContent).toMatch(
      /Old.*changed to.*New/,
    );
    expect(screen.getByText('API key').nextElementSibling?.textContent).toBe(
      'Changed (the value is never shown)',
    );
    expect(screen.getByText('Body').nextElementSibling?.textContent).toBe(
      'Content changed (version 2)',
    );
    const notes = screen.getByText('Notes').nextElementSibling!;
    expect(notes.textContent).toMatch(/Redacted.*permanently deleted/);
    expect(container.querySelector('dl')).not.toBeNull();
  });

  it('says so when an event recorded no field changes', () => {
    render(<ChangeList changes={[]} />);
    expect(screen.getByText(/No field changes/)).toBeTruthy();
  });
});

describe('deleted, unavailable, and trash states', () => {
  it('renders one generic deleted item with no identifying details', () => {
    const { container } = render(<DeletedItem />);
    expect(container.textContent).toBe('⊘ Deleted item');
  });

  it('permission unavailable does not reveal existence', () => {
    render(<PermissionUnavailable what="this item" />);
    expect(screen.getByRole('status').textContent).toMatch(/can’t view this item/);
  });

  it('trash metadata shows no purge date while the recovery period is undecided', () => {
    const { container } = render(
      <TrashMetadata
        deletedBy="A. Example"
        deletedAt="2026-10-01T09:30:00.000Z"
        itemCount={3}
        purgeEligibleAt={null}
      />,
    );
    expect(container.textContent).toMatch(/3 items/);
    expect(container.textContent).toMatch(/until you delete it permanently/);
    expect(container.textContent).not.toMatch(/2026-11|Nov/);
  });

  it('restore conflicts explain the reason and offer the next step', () => {
    const restore = vi.fn();
    render(<RestoreConflict reason="container_trashed" onRestoreContainer={restore} />);
    expect(screen.getByText('Its location is in trash')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore its location' }));
    expect(restore).toHaveBeenCalledOnce();
  });
});

describe('permanent deletion confirmation', () => {
  it('requires typing DELETE, states irreversibility and backup residuals, and focuses Cancel', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(
      <PurgeConfirmDialog
        itemLabel="Synthetic project"
        itemCount={2}
        onConfirm={confirm}
        onCancel={cancel}
      />,
    );
    const dialog = screen.getByRole('alertdialog', {
      name: /Delete “Synthetic project” permanently\?/,
    });
    expect(dialog.textContent).toMatch(/can’t be undone/);
    expect(dialog.textContent).toMatch(/backups/);
    expect(document.activeElement?.textContent).toBe('Cancel');
    const button = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), {
      target: { value: 'delete' },
    });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/), {
      target: { value: 'DELETE' },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
