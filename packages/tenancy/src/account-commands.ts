import { ACCOUNT_COMMANDS, ACTIONS, type AccountCommand } from '@pm/contracts';
import type { AuthContext, NonHumanPrincipal } from '@pm/identity';
import { issue, TenancyError } from './errors.ts';

/**
 * Account commands (0C AZ-18): account-level actions a verified human account performs before
 * any tenant context exists (`workspace.create`). They are authorized here, against the generated
 * 0C catalog, and never through the tenant compiler: no workspace role cell grants them, and
 * non-human principals (tokens, service principals, OAuth clients, integrations, automations,
 * AI, agents, support, system jobs) cannot exercise them.
 *
 * The other mandatory gates are enforced by the command itself: account still active (re-read
 * from the database), per-account rate limit, and Idempotency-Key.
 */
export function authorizeAccountCommand(
  action: AccountCommand,
  caller: AuthContext | NonHumanPrincipal,
): AuthContext {
  const command = ACCOUNT_COMMANDS.find((c) => c.action === action);
  const row = ACTIONS.find((a) => a.key === action);
  // Catalog invariants (also checked by the 0C validator): fail closed if the catalog drifts.
  if (
    !command ||
    !row ||
    row.kind !== 'personal' ||
    Object.values(row.roles as Record<string, string>).some((cell) => cell !== 'deny') ||
    command.principals.length !== 1 ||
    command.principals[0] !== 'account'
  )
    throw new Error(`${action} is not a registered human-only account command`);
  if (caller.principal !== 'account') throw new TenancyError('unauthenticated');
  if (!caller.account.emailVerified)
    throw new TenancyError('forbidden', {
      issues: [issue('/', 'email_unverified', 'Verify your email address to continue.')],
    });
  return caller;
}
