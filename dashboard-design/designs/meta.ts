import type { Kit } from '@/lib/kits';

/*
 * Round 1: twenty directions for the owner home (all-brands dashboard). `house` is each design's
 * own default palette, shown when no brand is selected; selecting a brand swaps in that brand's
 * identity kit. `refs` lists the inspiration files each direction borrows from.
 */

export type DesignMeta = { id: number; name: string; vibe: string; mode: 'dark' | 'light' | 'mixed'; house: Kit; refs: string[] };

const k = (name: string, a: string, b: string, c: string): Kit => ({ name, colors: [a, b, c] });

export const designs: DesignMeta[] = [
  { id: 1, name: 'Obsidian', vibe: 'Dark cards, one lit hero', mode: 'dark', house: k('Obsidian', '#3B82F6', '#FFFFFF', '#0B0B0F'), refs: ['093cc0fb', 'f32fff0c', 'ef252962'] },
  { id: 2, name: 'Paper', vibe: 'Warm light, black hero tile', mode: 'light', house: k('Paper', '#FF5F1F', '#FFFFFF', '#141414'), refs: ['b411e445', 'a9da54c9', 'b8360d27'] },
  { id: 3, name: 'Terminal Bento', vibe: 'Mono type, flat tiles', mode: 'dark', house: k('Terminal', '#5B6E99', '#B5B4A8', '#0F0F12'), refs: ['71f53c18'] },
  { id: 4, name: 'Lime Pulse', vibe: 'Black + neon, pill bars', mode: 'dark', house: k('Lime', '#C6F432', '#FFFFFF', '#0A0A0A'), refs: ['35897799', 'ef252962', '6a3449c7'] },
  { id: 5, name: 'Command Deck', vibe: 'Top nav, full-width chart band', mode: 'mixed', house: k('Deck', '#5B8CFF', '#7CE3B5', '#0B0D12'), refs: ['261b453f', 'original-93f5'] },
  { id: 6, name: 'One Number', vibe: 'Giant figure, density band', mode: 'light', house: k('Mono', '#22C55E', '#111111', '#FFFFFF'), refs: ['f62f9275'] },
  { id: 7, name: 'Schedule Rail', vibe: 'Pill timeline across the top', mode: 'light', house: k('Rail', '#B6F23A', '#111111', '#FFFFFF'), refs: ['fbf4459a', 'fcd5c9a9'] },
  { id: 8, name: 'Portfolio Map', vibe: 'Gantt across brands', mode: 'dark', house: k('Map', '#F43F5E', '#8B5CF6', '#22C55E'), refs: ['99198827'] },
  { id: 9, name: 'Pastel Columns', vibe: 'Brand columns, soft tints', mode: 'light', house: k('Pastel', '#7C5CFF', '#FFB86B', '#4FD1C5'), refs: ['58a6c6be', '979bfa36'] },
  { id: 10, name: 'Violet Glass', vibe: 'Plum glass, AI front and centre', mode: 'dark', house: k('Violet', '#7B61FF', '#5EE6A8', '#14121F'), refs: ['b209427e', '3c82df68'] },
  { id: 11, name: 'Day Planner', vibe: 'Today timeline is the home', mode: 'light', house: k('Planner', '#4B5BF2', '#A5B4FC', '#FFFFFF'), refs: ['d9a1e65e', 'c4c7a5c2', 'a2f27a4a'] },
  { id: 12, name: 'Split Focus', vibe: 'List left, dark detail right', mode: 'mixed', house: k('Split', '#5B3DF5', '#D7FF3A', '#111111'), refs: ['b097a6b1'] },
  { id: 13, name: 'Two-Tone', vibe: 'Dark band over cream', mode: 'mixed', house: k('TwoTone', '#F2E94E', '#19C39C', '#101114'), refs: ['70968e0f'] },
  { id: 14, name: 'Neo Brutal', vibe: 'Outlines, offset shadows, dock', mode: 'light', house: k('Brutal', '#A3E66B', '#A5A6F6', '#000000'), refs: ['0c3231a0'] },
  { id: 15, name: 'Editorial', vibe: 'Serif display, airy', mode: 'light', house: k('Editorial', '#2563EB', '#7DD3FC', '#FFFFFF'), refs: ['979bfa36', 'c1d5c0ff'] },
  { id: 16, name: 'Heat Ops', vibe: 'Warm dark, heatmap, stepper', mode: 'dark', house: k('Heat', '#F2875B', '#D4E157', '#141414'), refs: ['original-93f5'] },
  { id: 17, name: 'Gauges', vibe: 'Pure black, tick gauges', mode: 'dark', house: k('Gauge', '#3346FF', '#FF5A36', '#000000'), refs: ['3c82df68', '6483e2cb'] },
  { id: 18, name: 'Sage Triage', vibe: 'Soft sage, needs-you cards', mode: 'light', house: k('Sage', '#8B7CF6', '#22C55E', '#F1F3E8'), refs: ['31949ae3', 'b9d55a6e'] },
  { id: 19, name: 'Swiss', vibe: 'Hairlines and type only', mode: 'light', house: k('Swiss', '#FF3B1F', '#111111', '#FFFFFF'), refs: ['f62f9275', 'c1d5c0ff'] },
  { id: 20, name: 'Orbit', vibe: 'Mixed tiles, dot matrices', mode: 'mixed', house: k('Orbit', '#FF6A1A', '#7C3AED', '#10B981'), refs: ['1fcdefde'] },
];

export const designById = (id: number) => designs.find((d) => d.id === id);
