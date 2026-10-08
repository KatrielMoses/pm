'use client';

/* New project modal: name, brand, optional template. Esc or Cancel closes. */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { templates } from '@/lib/app-data';
import { brands, type BrandId } from '@/lib/data';
import { BrandChip } from '@/components/brand';
import { Button, IconButton, u } from '@/components/paper/ui';
import s from './projects.module.css';

export function CreateProject({ brand, onClose }: { brand: BrandId | null; onClose: () => void }) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [b, setB] = useState<BrandId>(brand ?? 'op');
  const [tpl, setTpl] = useState('');

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const projTemplates = templates.filter((t) => t.kind === 'Project');
  const chosen = projTemplates.find((t) => t.id === tpl);
  const finalName = name.trim() || chosen?.name || '';

  const create = () => {
    if (!finalName) return;
    toast(`Project created · ${finalName}`);
    onClose();
  };

  return (
    <div className={s.scrim} onClick={onClose}>
      <form className={s.modal} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); create(); }} role="dialog" aria-modal="true" aria-label="New project">
        <div className={s.mHead}>
          <h2>New project</h2>
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>

        <label className={u.field}>Name
          <input className={u.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.name ?? 'e.g. Partner sandbox launch'} autoFocus />
        </label>

        <div className={u.field}>Brand
          <div className={s.mBrands} role="radiogroup" aria-label="Brand">
            {brands.map((x) => (
              <button type="button" key={x.id} role="radio" aria-checked={b === x.id} className={b === x.id ? s.mBrandOn : s.mBrand} onClick={() => setB(x.id)}>
                <BrandChip id={x.id} size={20} />{x.name}
              </button>
            ))}
          </div>
        </div>

        <label className={u.field}>Start from
          <select className={s.select} value={tpl} onChange={(e) => setTpl(e.target.value)}>
            <option value="">Blank project</option>
            {projTemplates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.items} items</option>)}
          </select>
          <span className={s.hint}>{chosen ? `Adds ${chosen.items} tasks and milestones you can edit.` : 'Starts empty. Add tasks from the project page.'}</span>
        </label>

        <div className={s.mFoot}>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button variant="dark" type="submit" disabled={!finalName}>Create project</Button>
        </div>
      </form>
    </div>
  );
}
