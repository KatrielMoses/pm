import { createHash } from 'node:crypto';
import { AGENT_PROTOCOL } from './tool-registry.ts';

/**
 * Phase 8C assignment-dispatch and result protocol (`pm-agent/1`, run version 1; ADR-0048 D7–D10;
 * 0D PL-55). The product sends one dispatch per run attempt to the connector registered in 8B;
 * the agent answers with an acknowledgment (never completion) and then works through the
 * product's own API or MCP endpoint with the run-bound credential it was given: progress events,
 * registered tool calls, draft artifacts, and one structured final result. Everything the agent
 * sends is untrusted data, validated here with finite bounds before anything reads it.
 */
export const RUN_PROTOCOL_VERSION = '1';

export interface RunDispatch {
  type: 'agent.run.dispatch';
  protocol: typeof AGENT_PROTOCOL;
  version: typeof RUN_PROTOCOL_VERSION;
  dispatch_id: string;
  run: { id: string; attempt: number };
  task: { id: string; title: string };
  brief: {
    goal: string;
    constraints: string | null;
    deliverable: string | null;
    criteria: string[];
    instructions: string;
  };
  context: Array<{ id: string; type: string; name: string }>;
  tools: Array<{ name: string; version: string }>;
  limits: Record<string, number>;
  callback: {
    base_url: string;
    events: string;
    tools: string;
    artifacts: string;
    result: string;
    mcp: string;
  };
  credential: { token: string; expires_at: string };
  issued_at: string;
}

export type Bad = { pointer: string; code: string; message: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; issues: Bad[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(
  v: unknown,
  max: number,
  pointer: string,
  issues: Bad[],
  required = true,
): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) issues.push({ pointer, code: 'required', message: 'This field is required.' });
    return null;
  }
  if (typeof v !== 'string' || v.length > max || CONTROL.test(v)) {
    issues.push({
      pointer,
      code: 'invalid_length',
      message: `Use up to ${max} characters of text.`,
    });
    return null;
  }
  return v;
}

function key(v: unknown, pointer: string, issues: Bad[]): string | null {
  if (typeof v !== 'string' || !KEY.test(v)) {
    issues.push({
      pointer,
      code: 'invalid_key',
      message: 'Use 1 to 128 letters, digits, or . _ : -.',
    });
    return null;
  }
  return v;
}

function only(b: Record<string, unknown>, allowed: string[], issues: Bad[]) {
  for (const k of Object.keys(b))
    if (!allowed.includes(k))
      issues.push({
        pointer: `/${k}`,
        code: 'unknown_field',
        message: 'This field is not accepted.',
      });
}

export interface EventInput {
  key: string;
  kind: 'progress' | 'commentary';
  text: string;
  percent: number | null;
}

/** A progress or commentary event: bounded text, never a completion signal. */
export function parseEvent(body: unknown, maxChars: number): Parsed<EventInput> {
  const issues: Bad[] = [];
  const b = isObj(body) ? body : {};
  only(b, ['key', 'kind', 'text', 'percent'], issues);
  const k = key(b.key, '/key', issues);
  const kind = b.kind === 'progress' || b.kind === 'commentary' ? b.kind : null;
  if (!kind)
    issues.push({
      pointer: '/kind',
      code: 'invalid_option',
      message: 'Use progress or commentary.',
    });
  const t = text(b.text, maxChars, '/text', issues);
  let percent: number | null = null;
  if (b.percent !== undefined && b.percent !== null) {
    if (
      typeof b.percent !== 'number' ||
      !Number.isInteger(b.percent) ||
      b.percent < 0 ||
      b.percent > 100
    )
      issues.push({
        pointer: '/percent',
        code: 'out_of_range',
        message: 'Use a whole number from 0 to 100.',
      });
    else percent = b.percent;
  }
  return issues.length || !k || !kind || t === null
    ? { ok: false, issues }
    : { ok: true, value: { key: k, kind, text: t, percent } };
}

export interface ToolCallInput {
  key: string;
  tool: string;
  version: string;
  arguments: Record<string, unknown>;
}

export function parseToolCall(body: unknown): Parsed<ToolCallInput> {
  const issues: Bad[] = [];
  const b = isObj(body) ? body : {};
  only(b, ['key', 'tool', 'version', 'arguments'], issues);
  const k = key(b.key, '/key', issues);
  const tool = typeof b.tool === 'string' && /^[a-z][a-z0-9_.]{1,79}$/.test(b.tool) ? b.tool : null;
  if (!tool)
    issues.push({
      pointer: '/tool',
      code: 'invalid_reference',
      message: 'Name a registered tool.',
    });
  const version =
    typeof b.version === 'string' && /^[0-9]{1,8}$/.test(b.version) ? b.version : null;
  if (!version)
    issues.push({
      pointer: '/version',
      code: 'invalid_reference',
      message: 'Name the tool version.',
    });
  const args = b.arguments === undefined ? {} : b.arguments;
  if (!isObj(args) || JSON.stringify(args).length > 4096)
    issues.push({
      pointer: '/arguments',
      code: 'invalid_type',
      message: 'Arguments are a small object.',
    });
  return issues.length || !k || !tool || !version
    ? { ok: false, issues }
    : { ok: true, value: { key: k, tool, version, arguments: args as Record<string, unknown> } };
}

export const ARTIFACT_MEDIA_TYPES = ['text/markdown', 'text/plain', 'application/json'] as const;
export type ArtifactMediaType = (typeof ARTIFACT_MEDIA_TYPES)[number];

export interface ArtifactInput {
  key: string;
  title: string;
  media_type: ArtifactMediaType;
  content: string;
  sha256: string;
}

/**
 * A draft artifact: text the agent produced, validated by type, size, and declared checksum. The
 * agent's name and type claims are never trusted beyond this: no URL is fetched, no script runs,
 * and JSON must parse. Files need 4E hosting and are refused here as unavailable.
 */
export function parseArtifact(body: unknown, maxBytes: number): Parsed<ArtifactInput> {
  const issues: Bad[] = [];
  const b = isObj(body) ? body : {};
  only(b, ['key', 'title', 'media_type', 'content', 'sha256'], issues);
  const k = typeof b.key === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(b.key) ? b.key : null;
  if (!k)
    issues.push({
      pointer: '/key',
      code: 'invalid_key',
      message: 'Use 1 to 64 letters, digits, or . _ -.',
    });
  const title = text(b.title, 200, '/title', issues);
  const mt = (ARTIFACT_MEDIA_TYPES as readonly string[]).includes(b.media_type as string)
    ? (b.media_type as ArtifactMediaType)
    : null;
  if (!mt)
    issues.push({
      pointer: '/media_type',
      code: 'unsupported_media_type',
      message:
        'Artifacts are Markdown, plain text, or JSON. Files need file hosting, which runs do not use yet.',
    });
  let content: string | null = null;
  if (typeof b.content !== 'string')
    issues.push({ pointer: '/content', code: 'required', message: 'Add the content.' });
  else if (Buffer.byteLength(b.content) > maxBytes)
    issues.push({
      pointer: '/content',
      code: 'too_large',
      message: `An artifact is at most ${maxBytes} bytes.`,
    });
  else if (CONTROL.test(b.content.replace(/[\n\r\t]/g, '')))
    issues.push({
      pointer: '/content',
      code: 'invalid_format',
      message: 'Control characters are not accepted.',
    });
  else content = b.content;
  if (content !== null && mt === 'application/json') {
    try {
      JSON.parse(content);
    } catch {
      issues.push({
        pointer: '/content',
        code: 'invalid_format',
        message: 'This is not valid JSON.',
      });
    }
  }
  const sha = typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.sha256) ? b.sha256 : null;
  if (!sha)
    issues.push({
      pointer: '/sha256',
      code: 'invalid_format',
      message: 'Give the SHA-256 of the content.',
    });
  else if (content !== null && sha256Hex(content) !== sha)
    issues.push({
      pointer: '/sha256',
      code: 'checksum_mismatch',
      message: 'The checksum does not match the content.',
    });
  return issues.length || !k || title === null || !mt || content === null || !sha
    ? { ok: false, issues }
    : { ok: true, value: { key: k, title, media_type: mt, content, sha256: sha } };
}

export interface ResultInput {
  key: string;
  attempt: number;
  status: 'completed' | 'failed';
  summary: string;
  artifacts: string[];
  reported_cost: { amount_micros: number; currency: string } | null;
}

/**
 * The one structured final result, bound to the run attempt and an idempotency key. `completed`
 * means the agent says it is done; the product records the run as ready for review, never as
 * accepted and never as task completion.
 */
export function parseResult(body: unknown): Parsed<ResultInput> {
  const issues: Bad[] = [];
  const b = isObj(body) ? body : {};
  only(b, ['key', 'attempt', 'status', 'summary', 'artifacts', 'reported_cost'], issues);
  const k = key(b.key, '/key', issues);
  const attempt =
    typeof b.attempt === 'number' && Number.isInteger(b.attempt) && b.attempt >= 1
      ? b.attempt
      : null;
  if (attempt === null)
    issues.push({ pointer: '/attempt', code: 'required', message: 'Name the run attempt.' });
  const status = b.status === 'completed' || b.status === 'failed' ? b.status : null;
  if (!status)
    issues.push({
      pointer: '/status',
      code: 'invalid_option',
      message: 'Use completed or failed.',
    });
  const summary = text(b.summary, 4000, '/summary', issues);
  const artifacts: string[] = [];
  if (b.artifacts !== undefined) {
    if (!Array.isArray(b.artifacts) || b.artifacts.length > 50)
      issues.push({
        pointer: '/artifacts',
        code: 'invalid_type',
        message: 'List up to 50 artifact keys.',
      });
    else
      for (const [i, a] of b.artifacts.entries())
        if (typeof a !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(a))
          issues.push({
            pointer: `/artifacts/${i}`,
            code: 'invalid_key',
            message: 'Name an artifact key.',
          });
        else if (!artifacts.includes(a)) artifacts.push(a);
  }
  let reported: ResultInput['reported_cost'] = null;
  if (b.reported_cost !== undefined && b.reported_cost !== null) {
    const r = b.reported_cost;
    if (
      !isObj(r) ||
      typeof r.amount_micros !== 'number' ||
      !Number.isSafeInteger(r.amount_micros) ||
      r.amount_micros < 0 ||
      typeof r.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(r.currency)
    )
      issues.push({
        pointer: '/reported_cost',
        code: 'invalid_type',
        message: 'Give an amount in micros and a currency.',
      });
    else reported = { amount_micros: r.amount_micros, currency: r.currency };
  }
  return issues.length || !k || attempt === null || !status || summary === null
    ? { ok: false, issues }
    : { ok: true, value: { key: k, attempt, status, summary, artifacts, reported_cost: reported } };
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** The acknowledgment an agent returns to a dispatch: receipt only, never completion. */
export function parseAck(body: unknown, dispatchId: string): boolean {
  return (
    isObj(body) &&
    body.type === 'agent.run.ack' &&
    body.dispatch_id === dispatchId &&
    body.accepted === true
  );
}
