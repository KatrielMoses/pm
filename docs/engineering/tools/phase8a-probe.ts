/**
 * Runtime probe for the Phase 8A validator (phase8a.py): runs the real automation compiler, not a
 * text search. It compiles every starter template, reports the action and trigger matrices, and
 * checks that unsupported configuration is refused and future sources stay unavailable. Prints one
 * JSON document; no database, network, or clock.
 *
 *   node --conditions=@pm/source docs/engineering/tools/phase8a-probe.ts
 */
import {
  ACTION_MATRIX,
  compileDefinition,
  DefinitionError,
  TRIGGERS,
  type DefinitionLimits,
} from '../../../packages/work/src/automation/definition.ts';
import { STARTER_TEMPLATES, templateDraft } from '../../../packages/work/src/automation/templates.ts';

const LIMITS: DefinitionLimits = {
  definitionBytesMax: 32_768,
  nodesMax: 25,
  conditionDepthMax: 4,
  conditionsMax: 20,
  targetFanoutMax: 25,
  delayHorizonMinutes: 43_200,
};
const VALUES = {
  timezone: 'Europe/London',
  project: 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  member: 'mem_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  label: 'lbl_01HZZZZZZZZZZZZZZZZZZZZZZZ',
};
const compile = (raw: unknown) => {
  try {
    const c = compileDefinition(raw, LIMITS);
    return { ok: true, unavailable: c.unavailable.map((u) => u.owner), actions: c.actions };
  } catch (err) {
    if (err instanceof DefinitionError)
      return { ok: false, codes: err.issues.map((i) => `${i.pointer}:${i.code}`) };
    throw err;
  }
};
const step = (s: Record<string, unknown>) => ({
  schema_version: 1,
  trigger: { kind: 'record.created', record: 'task' },
  conditions: null,
  steps: [s],
});

const templates: Record<string, unknown> = {};
for (const t of STARTER_TEMPLATES) {
  const d = templateDraft(t.key, VALUES, { brandId: null, brandPublicIds: [] });
  templates[t.key] = d ? compile(d.definition) : { ok: false, codes: ['missing'] };
}
const actions = Object.fromEntries(
  Object.entries(ACTION_MATRIX).map(([k, v]) => [
    k,
    { status: v.status, owner: 'owner' in v ? v.owner : null },
  ]),
);
const triggers = Object.fromEntries(
  Object.entries(TRIGGERS).map(([k, v]) => [k, { status: v.status, owner: 'owner' in v ? v.owner : null }]),
);
const probes = {
  arbitrary_http: compile(step({ id: 'x', type: 'action', action: 'http.request', params: {} })),
  project_assign: compile({
    ...step({ id: 'x', type: 'action', action: 'project.assign', params: {} }),
    trigger: { kind: 'record.created', record: 'project' },
  }),
  agent_step: compile(step({ id: 'x', type: 'action', action: 'agent.invoke', params: { agent: 'agp_01HZZZZZZZZZZZZZZZZZZZZZZZ' } })),
  test_trigger: compile({ ...step({ id: 'x', type: 'action', action: 'task.update', params: { fields: { priority: 'high' } } }), trigger: { kind: 'test.result', record: 'task' } }),
  unknown_fallback: compile(
    step({
      id: 'x',
      type: 'action',
      action: 'task.update',
      params: { fields: { priority: 'high' } },
      fallback: { on: ['outcome_unknown'], next: null },
    }),
  ),
  cycle: compile({
    schema_version: 1,
    trigger: { kind: 'record.created', record: 'task' },
    conditions: null,
    steps: [
      { id: 'a', type: 'branch', when: { field: 'priority', op: 'eq', value: 'high' }, then: 'b', else: null },
      { id: 'b', type: 'delay', minutes: 5, next: 'a' },
    ],
  }),
  script: compile(step({ id: 'x', type: 'action', action: 'task.update', params: { fields: { title: { $expr: 'process.exit()' } } } })),
};
console.log(JSON.stringify({ templates, actions, triggers, probes }));
