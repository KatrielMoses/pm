'use client';

import { Workspace } from '@/lib/workspace';
import { designById } from '@/designs/meta';
import { designComponents } from '@/designs/components';
import { Toolbar } from './Toolbar';

export function MockupView({ id, embed }: { id: number; embed?: boolean }) {
  const meta = designById(id)!;
  const Design = designComponents[id];
  return (
    <Workspace house={meta.house}>
      <Design />
      {embed ? null : <Toolbar meta={meta} />}
    </Workspace>
  );
}
