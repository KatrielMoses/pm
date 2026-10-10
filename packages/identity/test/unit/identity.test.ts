import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEP_UP_CHALLENGE_STATES } from '@pm/contracts';
import {
  ACCOUNT_STEP_UP_ACTIONS,
  base32Decode,
  base32Encode,
  checkPasswordPolicy,
  deviceLabel,
  hashRecoveryCode,
  hashToken,
  isWellFormedToken,
  keyedHash,
  networkPrefix,
  newOpaqueToken,
  newRecoveryCodes,
  normalizeEmail,
  normalizeRecoveryCode,
  otpauthUri,
  PasswordHasher,
  renderTemplate,
  safeReturnPath,
  totpCode,
  verifyTotp,
  withResponseFloor,
  MAIL_TEMPLATES,
} from '@pm/identity';

describe('opaque tokens', () => {
  it('are 256-bit, base64url, and stored only as SHA-256', () => {
    const t = newOpaqueToken();
    expect(t.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t.raw, 'base64url')).toHaveLength(32);
    expect(t.hash).toHaveLength(32);
    expect(t.hash.equals(hashToken(t.raw))).toBe(true);
    expect(isWellFormedToken(t.raw)).toBe(true);
    for (const bad of ['', 'x'.repeat(42), `${t.raw}=`, 1, null])
      expect(isWellFormedToken(bad)).toBe(false);
    expect(newOpaqueToken().raw).not.toBe(t.raw);
  });

  it('keyed hashes are domain-separated (CSRF tokens never equal limiter keys)', () => {
    const key = Buffer.alloc(32, 7);
    expect(
      keyedHash(key, 'csrf', 'x').equals(keyedHash(key, 'rate-limit:sign_in.email', 'x')),
    ).toBe(false);
    expect(keyedHash(key, 'csrf', 'x').equals(keyedHash(key, 'csrf', 'x'))).toBe(true);
  });
});

describe('email normalization', () => {
  it('lowercases for comparison, keeps the delivery form, and encodes IDN domains', () => {
    expect(normalizeEmail('  Ada.Lovelace+notes@Example.COM ')).toEqual({
      display: 'Ada.Lovelace+notes@example.com',
      key: 'ada.lovelace+notes@example.com',
    });
    expect(normalizeEmail('user@bücher.example').display).toBe('user@xn--bcher-kva.example');
    // No provider-specific alias rules: dots and plus tags stay distinct.
    expect(normalizeEmail('a.b@gmail.com').key).not.toBe(normalizeEmail('ab@gmail.com').key);
    // Unicode NFC: composed and decomposed forms compare equal.
    expect(normalizeEmail('josé@example.com').key).toBe(normalizeEmail('josé@example.com').key);
  });

  it.each([
    'plain',
    '@example.com',
    'a@b',
    'a@@b.com',
    'a b@example.com',
    'a@-bad.com',
    '.a@example.com',
    `${'a'.repeat(65)}@example.com`,
    'a\u0000@example.com',
    12,
  ])('rejects %s', (bad) => {
    expect(() => normalizeEmail(bad)).toThrow();
  });
});

describe('passwords (Argon2id)', () => {
  it('enforces length limits without truncation or composition rules', () => {
    expect(checkPasswordPolicy('short')).toBe('too_short');
    expect(checkPasswordPolicy('twelve chars')).toBeUndefined();
    expect(checkPasswordPolicy('x'.repeat(257))).toBe('too_long');
    expect(checkPasswordPolicy('é'.repeat(200))).toBeUndefined(); // 400 bytes, 200 chars
    expect(checkPasswordPolicy('😀'.repeat(256))).toBeUndefined(); // exactly 1024 bytes
    expect(checkPasswordPolicy('😀'.repeat(257))).toBe('too_long');
    expect(checkPasswordPolicy('bell\u0007character!!')).toBe('invalid');
    expect(checkPasswordPolicy(42)).toBe('invalid');
  });

  it('hashes with recorded parameters, verifies, and flags weaker parameters for rehash', async () => {
    const hasher = new PasswordHasher({
      memoryKiB: 19456,
      passes: 2,
      parallelism: 1,
      maxConcurrency: 2,
    });
    const h = await hasher.hash('correct horse battery staple');
    expect(h.algorithm).toBe('argon2id');
    expect(h.params).toEqual({ v: 19, m: 19456, t: 2, p: 1, len: 32 });
    expect(h.salt).toHaveLength(16);
    expect(await hasher.verify('correct horse battery staple', h)).toBe(true);
    expect(await hasher.verify('correct horse battery stapl', h)).toBe(false);
    // NFC normalization: composed and decomposed input verify identically.
    const u = await hasher.hash('passéword-long-enough');
    expect(await hasher.verify('passéword-long-enough', u)).toBe(true);
    const stronger = new PasswordHasher({
      memoryKiB: 65536,
      passes: 3,
      parallelism: 1,
      maxConcurrency: 1,
    });
    expect(stronger.needsRehash(h.params)).toBe(true);
    expect(hasher.needsRehash(h.params)).toBe(false);
    expect(await hasher.verify('x'.repeat(2000), h)).toBe(false); // oversize input refused, not truncated
  });

  it('production defaults (64 MiB, 3 passes) stay within a bounded cost on this machine', async () => {
    const prod = new PasswordHasher({
      memoryKiB: 65536,
      passes: 3,
      parallelism: 1,
      maxConcurrency: 4,
    });
    const started = performance.now();
    await prod.hash('benchmark passphrase');
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('TOTP (RFC 6238 test vectors, SHA-1)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('t=%i -> %s', (t, code) => {
    expect(totpCode(secret, Math.floor(t / 30))).toBe(code);
  });

  it('accepts one step of drift and returns the matched step for replay protection', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step + 2), now)).toBeUndefined();
    expect(verifyTotp(secret, '12345', now)).toBeUndefined();
    expect(verifyTotp(secret, 123456, now)).toBeUndefined();
  });

  it('base32 round-trips and builds authenticator URIs', () => {
    const raw = Buffer.from('any bytes here!');
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    expect(otpauthUri('JBSWY3DPEHPK3PXP', 'a@example.com', 'PM')).toBe(
      'otpauth://totp/PM%3Aa%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=PM&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('recovery codes', () => {
  it('are ten unique 80-bit codes, normalized leniently, hashed for storage', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    const n = normalizeRecoveryCode(` ${codes[0]!.toLowerCase().replaceAll('-', ' ')} `)!;
    expect(hashRecoveryCode(n).equals(hashRecoveryCode(normalizeRecoveryCode(codes[0])!))).toBe(
      true,
    );
    expect(normalizeRecoveryCode('short')).toBeUndefined();
  });
});

describe('privacy minimization and redirect safety', () => {
  it('reduces addresses to /24 or /48 prefixes and user agents to a family label', () => {
    expect(networkPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(networkPrefix('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(networkPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(networkPrefix('not-an-ip')).toBeUndefined();
    expect(
      deviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0',
      ),
    ).toBe('Edge on Windows');
    expect(
      deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'),
    ).toBe('Firefox on Linux');
    expect(deviceLabel(undefined)).toBeUndefined();
  });

  it.each([
    ['/account/security', '/account/security'],
    ['/onboarding?step=2', '/onboarding?step=2'],
    ['https://evil.example/', '/onboarding'],
    ['//evil.example', '/onboarding'],
    ['/\\evil.example', '/onboarding'],
    ['/admin', '/onboarding'],
    ['javascript:alert(1)', '/onboarding'],
    [undefined, '/onboarding'],
  ])('return path %s -> %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });

  it('applies a response floor to both success and failure', async () => {
    const t = async (fn: () => Promise<unknown>) => {
      const s = performance.now();
      await fn().catch(() => undefined);
      return performance.now() - s;
    };
    expect(await t(() => withResponseFloor(80, async () => 'ok'))).toBeGreaterThanOrEqual(75);
    expect(
      await t(() => withResponseFloor(80, async () => Promise.reject(new Error('x')))),
    ).toBeGreaterThanOrEqual(75);
  });
});

describe('mail templates', () => {
  it('carry only the opaque token in the URL fragment and no internal identifiers', () => {
    for (const t of MAIL_TEMPLATES) {
      const r = renderTemplate(t, {
        displayName: 'Ada <script>',
        appName: 'PM',
        origin: 'https://app.example.test',
        token: 'T'.repeat(43),
      });
      expect(r.subject.length).toBeGreaterThan(5);
      expect(r.html).not.toContain('<script>');
      expect(r.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      if (t === 'email_verification' || t === 'password_reset' || t === 'workspace_invitation') {
        expect(r.text).toMatch(/https:\/\/app\.example\.test\/[a-z-/]+#token=T{43}/);
        expect(r.text).not.toMatch(/\?token=/);
      } else {
        expect(r.text).not.toContain('T'.repeat(43));
      }
    }
  });
});

describe('account step-up actions come from the canonical 0C registry (AZ-17)', () => {
  const policy = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../docs/architecture/access/policy/policy.json'),
      'utf8',
    ),
  ) as {
    actions: Array<{
      key: string;
      kind: string;
      scopes: string[];
      step_up: boolean;
      risk_class: string;
      roles: Record<string, string>;
    }>;
  };

  it('equals the personal, step-up-flagged account.* actions of policy.json', () => {
    const canonical = policy.actions.filter(
      (a) => a.kind === 'personal' && a.step_up && a.key.startsWith('account.'),
    );
    expect([...ACCOUNT_STEP_UP_ACTIONS].sort()).toEqual(canonical.map((a) => a.key).sort());
    expect([...ACCOUNT_STEP_UP_ACTIONS].sort()).toEqual([
      'account.mfa_disable',
      'account.mfa_enroll',
      'account.recovery_codes_regenerate',
    ]);
    for (const a of canonical) {
      expect(a.scopes).toEqual(['personal']);
      expect(new Set(Object.values(a.roles))).toEqual(new Set(['own']));
      expect(['R3', 'R4']).toContain(a.risk_class);
    }
  });

  it('uses the 0D challenge states, including the stored terminal locked state', () => {
    expect(STEP_UP_CHALLENGE_STATES).toEqual([
      'pending',
      'verified',
      'consumed',
      'expired',
      'cancelled',
      'locked',
    ]);
  });
});
