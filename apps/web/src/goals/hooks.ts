import { useEffect, useRef, useState } from 'react';
import { newIdempotencyKey } from '../api.ts';
import { collab } from '../tenancy/client.ts';

/**
 * One Idempotency-Key per distinct request body. A retry of the same body (after a dropped
 * connection whose outcome is unknown) reuses the key, so the server replays instead of applying
 * twice; a changed body gets a new key, because a key is bound to the body it first carried.
 */
export function useIdempotency() {
  const current = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(payload: unknown): string {
      const fingerprint = JSON.stringify(payload);
      if (!current.current || current.current.fingerprint !== fingerprint)
        current.current = { fingerprint, key: newIdempotencyKey() };
      return current.current.key;
    },
    /** After the server accepted the request: the next one is a new action. */
    reset() {
      current.current = null;
    },
  };
}

export interface MemberOption {
  id: string;
  name: string;
  you: boolean;
}

/**
 * Active members, for owner choices. The directory is available only to people who may view it;
 * without it the list is empty and the owner defaults to the person themself on the server.
 */
export function useMembers(ws: string): { members: MemberOption[]; loaded: boolean } {
  const [state, setState] = useState<{ members: MemberOption[]; loaded: boolean }>({
    members: [],
    loaded: false,
  });
  useEffect(() => {
    let active = true;
    collab.people(ws, { state: 'active' }).then(
      (list) => {
        if (active)
          setState({
            loaded: true,
            members: list
              .filter((m) => m.kind === 'member')
              .map((m) => ({ id: m.id, name: m.display_name, you: m.is_you })),
          });
      },
      () => {
        if (active) setState({ members: [], loaded: true });
      },
    );
    return () => {
      active = false;
    };
  }, [ws]);
  return state;
}
