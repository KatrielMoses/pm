import { useEffect, useState } from 'react';
import { tenancy } from '../tenancy/client.ts';

/** The brands the person can read (all of them, not only the ones in the current scope). */
export function useBrands(ws: string): Array<{ id: string; name: string }> {
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let active = true;
    tenancy.listBrands(ws, 'active').then(
      (r) => {
        if (active) setBrands(r.data.map((b) => ({ id: b.id, name: b.name })));
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [ws]);
  return brands;
}
