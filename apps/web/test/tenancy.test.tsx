import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchPath } from '../src/router.tsx';
import { mergeRequest, type Priorities } from '../src/tenancy/client.ts';
import {
  hoursDraft,
  PrioritiesEditor,
  rangeId,
  validateHours,
  validatePriorities,
  WorkingHoursEditor,
  type HoursDraft,
} from '../src/tenancy/editors.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('route matching', () => {
  it('matches public-ID segments only', () => {
    expect(matchPath('/workspaces/:ws/brands/:brand', '/workspaces/ws_A/brands/br_B')).toEqual({
      ws: 'ws_A',
      brand: 'br_B',
    });
    expect(matchPath('/workspaces/:ws', '/workspaces/ws_A/extra')).toBeNull();
    expect(matchPath('/workspaces/:ws', '/workspaces/%3Cscript%3E')).toBeNull();
  });
});

describe('field-merge request', () => {
  it('sends only changed fields with the base the form loaded', () => {
    expect(mergeRequest(3, { name: 'A', currency: 'EUR' }, { name: 'B', currency: 'EUR' })).toEqual(
      {
        version: 3,
        changes: { name: { base: 'A', value: 'B' } },
      },
    );
  });
});

describe('working hours', () => {
  const base = hoursDraft({
    schema_version: 1,
    days: [{ weekday: 1, ranges: [{ start: '09:00', end: '17:00' }] }],
  });

  it('closed days are omitted; ranges are sorted; overlaps and reversed ranges are errors', () => {
    expect(validateHours(base)).toEqual({
      value: {
        schema_version: 1,
        days: [{ weekday: 1, ranges: [{ start: '09:00', end: '17:00' }] }],
      },
      errors: {},
    });
    const draft: HoursDraft = {
      days: base.days.map((d) =>
        d.weekday === 1
          ? {
              ...d,
              ranges: [
                { start: '13:00', end: '18:00' },
                { start: '09:00', end: '13:30' },
              ],
            }
          : d,
      ),
    };
    expect(Object.keys(validateHours(draft).errors)).toEqual([rangeId(1, 0, 'start')]);
    const reversed: HoursDraft = {
      days: base.days.map((d) =>
        d.weekday === 1 ? { ...d, ranges: [{ start: '18:00', end: '09:00' }] } : d,
      ),
    };
    expect(validateHours(reversed).errors[rangeId(1, 0, 'end')]).toMatch(/after the start/);
    const midnight: HoursDraft = {
      days: base.days.map((d) =>
        d.weekday === 1 ? { ...d, ranges: [{ start: '20:00', end: '24:00' }] } : d,
      ),
    };
    expect(validateHours(midnight).errors).toEqual({});
  });

  it('is operable with labelled native controls and states the time zone', () => {
    function Harness() {
      const [draft, setDraft] = useState(base);
      return (
        <WorkingHoursEditor
          draft={draft}
          onChange={setDraft}
          timezone="Europe/Lisbon"
          errors={{}}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText('Europe/Lisbon')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Tuesday' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open on Tuesday' }));
    expect(screen.getByLabelText('From (Tuesday, range 1)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a time range on Tuesday' }));
    expect(screen.getByLabelText('To (Tuesday, range 2)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove range 2 on Tuesday' }));
    expect(screen.queryByLabelText('To (Tuesday, range 2)')).toBeNull();
  });
});

describe('priorities', () => {
  it('is bounded to 10, reorderable, and validates empty text', () => {
    function Harness() {
      const [v, setV] = useState<Priorities>({ schema_version: 1, entries: [] });
      return <PrioritiesEditor value={v} onChange={setV} errors={validatePriorities(v)} />;
    }
    render(<Harness />);
    expect(screen.getByText('No goals or priorities yet.')).toBeTruthy();
    for (let i = 0; i < 10; i++)
      fireEvent.click(screen.getByRole('button', { name: 'Add an entry' }));
    expect(screen.queryByRole('button', { name: 'Add an entry' })).toBeNull();
    expect(screen.getByText('10 of 10 used.')).toBeTruthy();
    expect(screen.getAllByText('Enter some text, or remove this entry.')).toHaveLength(10);
    fireEvent.change(screen.getByLabelText('Entry 2'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move up entry 2' }));
    expect((screen.getByLabelText('Entry 1') as HTMLInputElement).value).toBe('Second');
  });
});
