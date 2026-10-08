'use client';

/*
 * Product-prototype state shared by every /app page: open overlays (task drawer, capture,
 * command palette, notifications, AI panel), task edits (so a status changed on the board shows
 * everywhere), toasts and display preferences. Brand + identity kit live in lib/workspace.tsx.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { tasks as seedTasks, type WorkItem } from './app-data';

type Toast = { id: number; text: string; tone?: 'ok' | 'bad' };
type Panel = null | 'notifications' | 'ai';

type AppCtx = {
  mode: 'light' | 'dark'; setMode: (m: 'light' | 'dark') => void;
  density: 'comfortable' | 'compact'; setDensity: (d: 'comfortable' | 'compact') => void;
  taskId: string | null; openTask: (id: string | null) => void;
  capture: boolean; setCapture: (v: boolean) => void;
  palette: boolean; setPalette: (v: boolean) => void;
  panel: Panel; setPanel: (p: Panel) => void;
  tasks: WorkItem[]; updateTask: (id: string, patch: Partial<WorkItem>) => void;
  toasts: Toast[]; toast: (text: string, tone?: 'ok' | 'bad') => void;
  timer: { taskId: string; since: number } | null; setTimer: (t: { taskId: string; since: number } | null) => void;
};

const Ctx = createContext<AppCtx | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside <AppProvider>');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [taskId, openTask] = useState<string | null>(null);
  const [capture, setCapture] = useState(false);
  const [palette, setPalette] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [patches, setPatches] = useState<Record<string, Partial<WorkItem>>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [timer, setTimer] = useState<{ taskId: string; since: number } | null>(null);

  const tasks = useMemo(() => seedTasks.map((t) => (patches[t.id] ? { ...t, ...patches[t.id] } : t)), [patches]);
  const updateTask = useCallback((id: string, patch: Partial<WorkItem>) => setPatches((p) => ({ ...p, [id]: { ...p[id], ...patch } })), []);
  const toast = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  return (
    <Ctx.Provider value={{ mode, setMode, density, setDensity, taskId, openTask, capture, setCapture, palette, setPalette, panel, setPanel, tasks, updateTask, toasts, toast, timer, setTimer }}>
      {children}
    </Ctx.Provider>
  );
}
