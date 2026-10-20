import { expect } from 'vitest';
import type { TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import {
  apply,
  join,
  membershipOf,
  mutation,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

/** Shared helpers for the 8B agent suites (profiles, connectors, assignments). */
export const v = (n: number, extra: Record<string, unknown> = {}) =>
  mutation({ ifMatch: `"${n}"`, ...extra });
export const code = (c: string) => expect.objectContaining({ code: c });
export const issueOf = (c: string) =>
  expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ code: c })]),
  });

export type Role = 'administrator' | 'member' | 'limited_member' | 'read_only';

export interface AgentWorld {
  ws: string;
  wsId: string;
  owner: Caller;
  brands: Record<string, string>;
  projects: Record<string, string>;
  tasks: Record<string, string>;
  people: Record<string, Caller>;
}

/** A workspace with brands Harbor and Vault (sensitive), a project per brand, and tasks. */
export async function agentWorld(
  env: WorkEnv,
  db: TestDatabase,
  people: Record<string, Record<string, unknown>> = {},
): Promise<AgentWorld> {
  const { owner, ws, brands } = await workspaceWith(env, db, ['Harbor']);
  const vault = (await env.svc.createBrand(owner, ws, { name: 'Vault' }, mutation())).data
    .id as string;
  env.stepUp.allow = true;
  await env.svc.setSensitivity(
    owner,
    ws,
    vault,
    { is_sensitive: true },
    mutation({ ifMatch: '"0"', stepUpToken: 't' }),
  );
  env.stepUp.allow = false;
  const b = { Harbor: brands.Harbor!, Vault: vault };
  const projects: Record<string, string> = {};
  for (const [name, brand] of [
    ['Launch', b.Harbor],
    ['Secret', b.Vault],
  ] as const)
    projects[name] = (await env.svc.createProject(owner, ws, { brand, name }, mutation())).data
      .id as string;
  const tasks: Record<string, string> = {};
  for (const [name, brand, project] of [
    ['Write launch notes', b.Harbor, projects.Launch],
    ['Plan launch party', b.Harbor, projects.Launch],
    ['Loose harbor task', b.Harbor, null],
    ['Vault plan', b.Vault, projects.Secret],
  ] as const)
    tasks[name] = (
      await env.svc.createTask(
        owner,
        ws,
        { brand, title: name, ...(project ? { project } : {}) },
        mutation(),
      )
    ).data.id as string;
  const out: Record<string, Caller> = {};
  for (const [name, body] of Object.entries(people))
    out[name] = await join(env, db, owner, ws, body);
  return { ws, wsId: await workspaceIdOf(db, ws), owner, brands: b, projects, tasks, people: out };
}

export async function memberId(db: TestDatabase, w: AgentWorld, who: Caller) {
  return (await membershipOf(db, w.wsId, who.auth.account.id))!.public_id;
}

export async function grantBrand(
  env: WorkEnv,
  db: TestDatabase,
  w: AgentWorld,
  who: Caller,
  brand: string,
  level: string,
) {
  await apply(env, w.owner, w.ws, {
    kind: 'brand_grant',
    brand,
    principal: await memberId(db, w, who),
    level,
  });
}

export async function revokeBrand(
  env: WorkEnv,
  db: TestDatabase,
  w: AgentWorld,
  who: Caller,
  brand: string,
) {
  await apply(env, w.owner, w.ws, {
    kind: 'brand_revoke',
    brand,
    principal: await memberId(db, w, who),
  });
}

export const config = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  kind: 'internal',
  instructions: 'Summarize the assigned task.',
  model_key: 'fixture/synthetic-messages@2026-10-17',
  limits: { max_runtime_minutes: 30, max_tool_calls: 50, max_artifacts: 5 },
  tools: [{ name: 'pm.tasks.get', version: '1' }],
  scope: { brands: [], projects: [], records: [], integrations: [] },
  approval_policy: {},
  ...over,
});

/** Creates a profile with a draft and turns it on (as `as`). */
export async function activeProfile(
  env: WorkEnv,
  w: AgentWorld,
  as: Caller,
  draft: Record<string, unknown>,
  name = 'Agent',
) {
  const made = (
    await env.svc.createAgentProfile(
      as,
      w.ws,
      { name, kind: draft.kind ?? 'internal', draft },
      mutation(),
    )
  ).data;
  return (await env.svc.activateAgentProfile(as, w.ws, made.id, mutation())).data as {
    id: string;
    version: number;
  };
}

/** The synthetic fixture model key from the 7A registry (labelled synthetic everywhere). */
export async function syntheticModelKey() {
  const { MODELS } = await import('../../src/ai/registry.ts');
  return MODELS.find((m) => m.synthetic)!.key;
}
