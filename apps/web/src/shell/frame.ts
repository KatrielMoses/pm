import { createContext, useContext } from 'react';

/** Present when a page renders inside the application shell (which owns header and navigation). */
export interface ShellFrame {
  kind: 'workspace' | 'personal';
}

export const ShellFrameContext = createContext<ShellFrame | null>(null);

export function useShellFrame(): ShellFrame | null {
  return useContext(ShellFrameContext);
}
