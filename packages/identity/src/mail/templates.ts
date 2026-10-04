export const MAIL_TEMPLATES = [
  'email_verification',
  'account_exists',
  'password_reset',
  'password_changed',
  'mfa_enabled',
  'mfa_disabled',
  'recovery_codes_regenerated',
  'sessions_revoked',
  'oauth_linked',
  'oauth_unlinked',
  'workspace_invitation',
] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

export interface TemplateInput {
  displayName: string;
  appName: string;
  origin: string;
  /** One-time token for link templates (placed in the URL fragment, never the query). */
  token?: string;
}

interface Rendered {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function render(
  input: TemplateInput,
  subject: string,
  paragraphs: string[],
  action?: { label: string; url: string },
): Rendered {
  const greeting = `Hi ${input.displayName},`;
  const text = [
    greeting,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(action ? [`${action.label}: ${action.url}`, ''] : []),
    `— ${input.appName}`,
  ].join('\n');
  const html = `<!doctype html><html lang="en"><body style="font-family:system-ui,sans-serif;color:#1a1d23;line-height:1.5">
<p>${escape(greeting)}</p>
${paragraphs.map((p) => `<p>${escape(p)}</p>`).join('\n')}
${action ? `<p><a href="${escape(action.url)}" style="color:#1d5bd6">${escape(action.label)}</a></p><p style="color:#474d59;font-size:14px">If the button doesn't work, copy this address into your browser: ${escape(action.url)}</p>` : ''}
<p>— ${escape(input.appName)}</p>
</body></html>`;
  return { subject, text, html };
}

const SECURITY_FOOTER =
  "If this wasn't you, reset your password and review your signed-in sessions in account security.";

/**
 * English templates (i18n keys arrive with 1E/11E). Messages never include internal IDs, IP
 * addresses, device details, or codes. Links carry only the opaque token, in the URL fragment so
 * it never reaches server logs or Referer headers.
 */
export function renderTemplate(template: MailTemplate, input: TemplateInput): Rendered {
  const link = (path: string) => `${input.origin}${path}#token=${input.token ?? ''}`;
  switch (template) {
    case 'email_verification':
      return render(
        input,
        `Verify your email for ${input.appName}`,
        [
          'Confirm this email address to finish setting up your account. This link works once and expires soon.',
        ],
        {
          label: 'Verify email address',
          url: link('/verify-email/confirm'),
        },
      );
    case 'account_exists':
      return render(input, `Sign-in help for ${input.appName}`, [
        'Someone tried to create an account with this email address, but you already have one.',
        `You can sign in at ${input.origin}/sign-in. If you've forgotten your password, use "Forgot password" on the sign-in page.`,
        "If this wasn't you, you can ignore this email.",
      ]);
    case 'password_reset':
      return render(
        input,
        `Reset your ${input.appName} password`,
        [
          'We received a request to reset your password. This link works once and expires soon. Resetting signs you out everywhere.',
          "If you didn't ask for this, you can ignore this email; your password won't change.",
        ],
        { label: 'Choose a new password', url: link('/reset-password') },
      );
    case 'password_changed':
      return render(input, `Your ${input.appName} password was changed`, [
        'Your password was just changed and other sessions were signed out.',
        SECURITY_FOOTER,
      ]);
    case 'mfa_enabled':
      return render(input, `Two-step verification is on`, [
        'Two-step verification was turned on for your account.',
        SECURITY_FOOTER,
      ]);
    case 'mfa_disabled':
      return render(input, `Two-step verification was turned off`, [
        'Two-step verification was turned off for your account.',
        SECURITY_FOOTER,
      ]);
    case 'recovery_codes_regenerated':
      return render(input, `New recovery codes were created`, [
        'New recovery codes were created for your account. Your previous codes no longer work.',
        SECURITY_FOOTER,
      ]);
    case 'sessions_revoked':
      return render(input, `You were signed out of other devices`, [
        'Your other sessions were signed out.',
        SECURITY_FOOTER,
      ]);
    case 'oauth_linked':
      return render(input, `A sign-in method was linked`, [
        'A new sign-in method was linked to your account.',
        SECURITY_FOOTER,
      ]);
    case 'oauth_unlinked':
      return render(input, `A sign-in method was removed`, [
        'A sign-in method was removed from your account.',
        SECURITY_FOOTER,
      ]);
    case 'workspace_invitation':
      // No workspace name, inviter, or role in mail: those are shown only after the recipient
      // signs in with the invited email address (0C AZ-19).
      return render(
        input,
        `You're invited to a workspace on ${input.appName}`,
        [
          `Someone invited this email address to join a workspace on ${input.appName}. Sign in or create an account with this same email address to see the details and accept.`,
          "This link works once and expires. If you weren't expecting this, you can ignore this email.",
        ],
        { label: 'View invitation', url: link('/invitations/accept') },
      );
  }
}
