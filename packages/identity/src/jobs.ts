import type { IdentityConfig, SecretVault } from '@pm/config';
import { sql, type PlatformDatabase } from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { JobError, type JobHandler, type RecurringJob } from '@pm/platform';
import { MAIL_TEMPLATES, renderTemplate, type MailTemplate } from './mail/templates.ts';
import type { MailTransport } from './mail/transport.ts';

export interface IdentityJobDeps {
  db: PlatformDatabase;
  config: IdentityConfig;
  vault: SecretVault;
  transport: MailTransport;
  appName: string;
  logger: Logger;
  metrics: Metrics;
}

/**
 * Mail delivery (queue `mail`). At least once: a crash between send and the "sent" mark can
 * resend; one-time-token consumption makes duplicates harmless. The secret-store copy of the token
 * is destroyed once the message is sent.
 */
export function mailDeliveryHandler(d: IdentityJobDeps): JobHandler {
  return {
    kind: 'identity.mail.deliver',
    queue: 'mail',
    timeoutMs: 30_000,
    async handle(ctx) {
      const id = ctx.job.payloadRef?.startsWith('mail:') ? ctx.job.payloadRef.slice(5) : undefined;
      if (!id) throw new JobError('deterministic', 'mail_payload_missing');
      const loaded = await d.db.withPlatform({ module: 'identity', readOnly: true }, async (tx) => {
        const m = await tx.db
          .selectFrom('identity.mail_delivery as m')
          .leftJoin('identity.account as a', 'a.id', 'm.account_id')
          .select([
            'm.id',
            'm.template',
            'm.recipient',
            'm.sealed_ref',
            'm.state',
            'a.display_name',
          ])
          .where('m.id', '=', id)
          .executeTakeFirst();
        if (!m) return undefined;
        const token = m.sealed_ref ? await d.vault.get(m.sealed_ref, { scope: tx }) : undefined;
        return { ...m, token };
      });
      if (!loaded || loaded.state === 'sent') return;
      if (!loaded.recipient || !(MAIL_TEMPLATES as readonly string[]).includes(loaded.template)) {
        throw new JobError('deterministic', 'mail_not_deliverable');
      }
      if (loaded.sealed_ref && !loaded.token)
        throw new JobError('deterministic', 'mail_token_expired');
      const rendered = renderTemplate(loaded.template as MailTemplate, {
        displayName: loaded.display_name ?? 'there',
        appName: d.appName,
        origin: d.config.publicOrigin,
        ...(loaded.token ? { token: loaded.token } : {}),
      });
      let providerMessageId: string;
      try {
        ({ providerMessageId } = await d.transport.send({
          id: loaded.id,
          to: loaded.recipient,
          from: d.config.mailFrom,
          ...rendered,
        }));
      } catch {
        d.metrics.count('mail.deliveries', 1, { template: loaded.template, outcome: 'retry' });
        throw new JobError('transient', 'mail_transport_failed');
      }
      await ctx.step('mark_sent', async (tx) => {
        await tx.db
          .updateTable('identity.mail_delivery')
          .set({
            state: 'sent',
            sent_at: new Date(),
            provider_message_id: providerMessageId,
            attempts: sql`attempts + 1`,
          })
          .where('id', '=', loaded.id)
          .execute();
        if (loaded.sealed_ref) await d.vault.destroy(loaded.sealed_ref, { scope: tx });
      });
      d.metrics.count('mail.deliveries', 1, { template: loaded.template, outcome: 'sent' });
      ctx.logger.info('mail.sent', { template: loaded.template });
    },
  };
}

/** Grace period before ended one-time rows are deleted (keeps "already used" answers meaningful). */
const TOKEN_GRACE_MS = 24 * 60 * 60_000;

/**
 * Retention sweep for platform identity data (queue `maintenance`, recurring). Idempotent:
 * deletes only rows past their retention, in dependency order, one platform transaction.
 */
export function identityCleanupHandler(d: IdentityJobDeps): JobHandler {
  return {
    kind: 'identity.cleanup',
    queue: 'maintenance',
    timeoutMs: 60_000,
    async handle(ctx) {
      await ctx.step('sweep', async (tx) => {
        const now = Date.now();
        const tokenCutoff = new Date(now - TOKEN_GRACE_MS);
        const sessionCutoff = new Date(now - d.config.sessionRetentionMs);
        const count = (rows: unknown[], kind: string) => {
          if (rows.length) d.metrics.count('identity.cleanup.deleted', rows.length, { kind });
          return rows.length;
        };
        // Challenges first (they reference sessions).
        const challenges = await tx.db
          .deleteFrom('identity.step_up_challenge')
          .where((eb) =>
            eb.or([
              eb('expires_at', '<', tokenCutoff),
              eb(
                'session_id',
                'in',
                eb
                  .selectFrom('identity.session')
                  .select('id')
                  .where((s) =>
                    s.or([
                      s('revoked_at', '<', sessionCutoff),
                      s('absolute_expires_at', '<', sessionCutoff),
                      s('idle_expires_at', '<', sessionCutoff),
                    ]),
                  ),
              ),
            ]),
          )
          .returning('id')
          .execute();
        const sessions = await tx.db
          .deleteFrom('identity.session')
          .where((s) =>
            s.or([
              s('revoked_at', '<', sessionCutoff),
              s('absolute_expires_at', '<', sessionCutoff),
              s('idle_expires_at', '<', sessionCutoff),
            ]),
          )
          .returning('id')
          .execute();
        const tokens = await tx.db
          .deleteFrom('identity.verification_token')
          .where((t) =>
            t.or([
              t('expires_at', '<', tokenCutoff),
              t('consumed_at', '<', tokenCutoff),
              t('revoked_at', '<', tokenCutoff),
            ]),
          )
          .returning('sealed_ref')
          .execute();
        const mail = await tx.db
          .deleteFrom('identity.mail_delivery')
          .where('created_at', '<', new Date(now - d.config.mailRetentionMs))
          .returning('sealed_ref')
          .execute();
        const refs = [...tokens, ...mail]
          .map((r) => r.sealed_ref)
          .filter((r): r is string => Boolean(r));
        if (refs.length)
          await tx.db.deleteFrom('ops.dev_secret_vault').where('ref', 'in', refs).execute();
        const vault = await tx.db
          .deleteFrom('ops.dev_secret_vault')
          .where('expires_at', '<', new Date(now))
          .returning('ref')
          .execute();
        const buckets = await tx.db
          .deleteFrom('ops.rate_limit_bucket')
          .where('updated_at', '<', new Date(now - 24 * 60 * 60_000))
          .returning('policy')
          .execute();
        const active = await tx.db
          .selectFrom('identity.session')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('revoked_at', 'is', null)
          .where('absolute_expires_at', '>', new Date(now))
          .where('idle_expires_at', '>', new Date(now))
          .executeTakeFirst();
        d.metrics.gauge('identity.sessions', Number(active?.n ?? 0), { state: 'active' });
        count(challenges, 'step_up_challenge');
        count(sessions, 'session');
        count(tokens, 'verification_token');
        count(mail, 'mail_delivery');
        count(vault, 'vault_secret');
        count(buckets, 'rate_limit_bucket');
      });
    },
  };
}

export function identityJobHandlers(d: IdentityJobDeps): JobHandler[] {
  return [mailDeliveryHandler(d), identityCleanupHandler(d)];
}

export const IDENTITY_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: 'identity.cleanup',
    queue: 'maintenance',
    intervalMs: 15 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];
