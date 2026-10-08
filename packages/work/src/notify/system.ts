import { newUuidV7, type ExecutionContext } from '@pm/contracts';

/** The execution context of a notification job or consumer acting for the system (4B). */
export function systemExec(workspaceId: string, membershipId: string | null): ExecutionContext {
  const principal = membershipId
    ? { type: 'member' as const, id: membershipId }
    : { type: 'system_job' as const, id: workspaceId };
  return {
    workspaceId,
    correlationId: newUuidV7().replace(/-/g, ''),
    authenticatedPrincipal: { type: 'system_job', id: membershipId ?? workspaceId },
    effectivePrincipal: principal,
    ...(membershipId ? { initiatingMembershipId: membershipId } : {}),
    delegationChain: membershipId
      ? [
          { type: 'member', id: membershipId },
          { type: 'system_job', id: membershipId },
        ]
      : [{ type: 'system_job', id: workspaceId }],
    epochs: { workspace: 0, principal: 0 },
    dataClassLimit: 'C2',
  } as ExecutionContext;
}
