import type { ShellCommandId, ShellCommandTrigger } from '@pm/contracts/shell';
import { shell } from './client.ts';

/**
 * Best-effort shell counters (PL-21): command identifiers from the fixed registry with their
 * trigger, and client-side state decode failures. Batched; failures are ignored (never blocks UI).
 * Nothing else (routes, titles, queries, identifiers) is ever sent.
 */
type CommandEvent = { command: ShellCommandId; trigger: ShellCommandTrigger };
type DecodeEvent = { source: 'url' | 'local'; reason: string };

let commands: CommandEvent[] = [];
let decodes: DecodeEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const body = { commands: commands.slice(0, 20), decode_failures: decodes.slice(0, 20) };
    commands = [];
    decodes = [];
    if (body.commands.length || body.decode_failures.length)
      void shell.events(body).catch(() => undefined);
  }, 3000);
}

export function countCommand(command: ShellCommandId, trigger: ShellCommandTrigger): void {
  commands.push({ command, trigger });
  schedule();
}

export function countDecodeFailure(source: 'url' | 'local', reason: string): void {
  decodes.push({ source, reason });
  schedule();
}
