'use client';

/* Native <select> drawn as a Paper pill. Shared by the settings, knowledge, automations, integrations and onboarding routes. */

import { ChevronDown } from 'lucide-react';
import s from './select.module.css';

export function Select<T extends string>({ value, onChange, options, width, ink, disabled, label, size }: {
  value: T; onChange: (v: T) => void; options: (T | { id: T; label: string })[]; width?: number | string; ink?: boolean; disabled?: boolean; label: string; size?: 'sm' | 'md';
}) {
  return (
    <span className={`${s.select} ${ink ? s.ink : ''} ${size === 'md' ? s.md : ''}`} style={{ width }} onClick={(e) => e.stopPropagation()}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} disabled={disabled} aria-label={label}>
        {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.id} value={o.id}>{o.label}</option>))}
      </select>
      {disabled ? null : <ChevronDown size={14} />}
    </span>
  );
}
