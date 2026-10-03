import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, clearCsrf } from './api.ts';

export interface Me {
  id: string;
  email: string;
  display_name: string;
  email_verified: boolean;
  session: { id: string; assurance: 'single_factor' | 'multi_factor'; auth_methods: string[] };
  mfa: { totp: boolean; recovery_codes_remaining: number };
}

interface AuthState {
  me: Me | null | undefined; // undefined = loading
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ data: Me }>('GET', '/v1/auth/me');
      setMe(r.body.data);
      return r.body.data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearCsrf();
        setMe(null);
        return null;
      }
      setMe((prev) => (prev === undefined ? null : prev));
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api('POST', '/v1/auth/sign-out');
    } finally {
      clearCsrf();
      setMe(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    api<{ data: Me }>('GET', '/v1/auth/me').then(
      (r) => active && setMe(r.body.data),
      () => active && setMe(null),
    );
    return () => {
      active = false;
    };
  }, []);

  return <AuthContext.Provider value={{ me, refresh, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
