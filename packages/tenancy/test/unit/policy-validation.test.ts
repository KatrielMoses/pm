import { describe, expect, it } from 'vitest';
import { ACCOUNT_COMMANDS, ACTIONS } from '@pm/contracts';
import {
  authorizeAccountCommand,
  canAssignRole,
  canManageMember,
  decideRecord,
  DEFAULT_POLICY,
  previewToken,
  recordLevel,
  subjectKeys,
  verifyPreviewToken,
  workspaceLevel,
  brandCapabilities,
  brandLevel,
  calendar,
  cell,
  color,
  currency,
  decideBrand,
  decideWorkspace,
  Issues,
  locale,
  parseBrandCreate,
  parseIfMatch,
  parseMerge,
  parseWorkspaceCreate,
  priorities,
  text,
  timezone,
  workingHours,
  type BrandFacts,
  type Level,
  type Principal,
  type WorkspaceRole,
} from '@pm/tenancy';

const principal = (role: WorkspaceRole | null, grants: Record<string, Level> = {}): Principal => ({
  workspaceId: 'w',
  membershipId: 'm',
  accountId: 'a',
  kind: role === 'guest' ? 'guest' : 'member',
  role,
  grants: new Map(Object.entries(grants)),
  grantSources: [],
  teams: [],
  policy: DEFAULT_POLICY,
  epochs: { workspace: 0, principal: 0 },
});
const brand = (over: Partial<BrandFacts> = {}): BrandFacts => ({
  id: 'b1',
  isSensitive: false,
  lifecycleState: 'active',
  ...over,
});

describe('policy compilation (0C matrix)', () => {
  it('reads role cells from the generated 0C action catalog', () => {
    expect(cell('brand.configure', 'owner')).toEqual({ kind: 'implicit' });
    expect(cell('brand.configure', 'member')).toEqual({ kind: 'grant', level: 'manage' });
    expect(cell('brand.archive', 'member')).toEqual({ kind: 'deny' });
    expect(cell('brand.create', null)).toEqual({ kind: 'deny' });
  });

  it('owners hold implicit manage on non-sensitive brands only; sensitive needs an explicit grant', () => {
    expect(brandLevel(principal('owner'), brand())).toBe('manage');
    expect(brandLevel(principal('owner'), brand({ isSensitive: true }))).toBeNull();
    expect(brandLevel(principal('owner', { b1: 'manage' }), brand({ isSensitive: true }))).toBe(
      'manage',
    );
    expect(
      decideBrand(principal('owner'), 'brand.configure', brand({ isSensitive: true })),
    ).toEqual({
      allowed: false,
      code: 'not_found',
    });
    // Explicit view on a sensitive brand: readable, but the implicit-cell action is forbidden.
    expect(
      decideBrand(
        principal('owner', { b1: 'view' }),
        'brand.archive',
        brand({ isSensitive: true }),
      ),
    ).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(
      decideBrand(
        principal('owner', { b1: 'manage' }),
        'brand.archive',
        brand({ isSensitive: true }),
      ),
    ).toEqual({
      allowed: true,
    });
  });

  it('members need grants; denied cells are forbidden only when the brand is readable', () => {
    expect(decideBrand(principal('member'), 'brand.configure', brand())).toEqual({
      allowed: false,
      code: 'not_found',
    });
    expect(decideBrand(principal('member', { b1: 'edit' }), 'brand.configure', brand())).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(decideBrand(principal('member', { b1: 'manage' }), 'brand.configure', brand())).toEqual({
      allowed: true,
    });
    expect(decideBrand(principal('member', { b1: 'manage' }), 'brand.archive', brand())).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(decideWorkspace(principal('member'), 'brand.create')).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(decideWorkspace(principal('guest'), 'workspace.view_settings')).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(decideWorkspace(principal('owner'), 'workspace.configure')).toEqual({ allowed: true });
  });

  it('trashed and purged brands do not exist for anyone; archived are readable, not writable', () => {
    for (const s of ['trashed', 'purged'] as const)
      expect(
        brandLevel(principal('owner', { b1: 'manage' }), brand({ lifecycleState: s })),
      ).toBeNull();
    expect(brandCapabilities(principal('owner'), brand({ lifecycleState: 'archived' }))).toEqual({
      configure: false,
      archive: false,
      restore: true,
      mark_sensitive: false,
      grant_access: false,
    });
  });

  it('refuses actions outside their declared scope (compiler misuse is a programming error)', () => {
    expect(() => decideBrand(principal('owner'), 'brand.create', brand())).toThrow();
    expect(() => decideWorkspace(principal('owner'), 'brand.configure')).toThrow();
  });
});

describe('normalization and canonical datasets', () => {
  it('validates IANA time zones, BCP 47 locales, ISO 4217 currencies', () => {
    const i = new Issues();
    expect(timezone('America/Argentina/Buenos_Aires', '/tz', i)).toBe(
      'America/Argentina/Buenos_Aires',
    );
    expect(timezone('UTC', '/tz', i)).toBe('UTC');
    expect(locale('pt-BR', '/l', i)).toBe('pt-BR');
    expect(currency('JPY', '/c', i)).toBe('JPY');
    expect(i.list).toEqual([]);
    timezone('Europe/Atlantis', '/tz', i);
    locale('en_us', '/l', i);
    locale('EN-us', '/l', i);
    currency('usd', '/c', i);
    currency('XYZ', '/c', i);
    expect(i.list.map((x) => x.code)).toEqual([
      'invalid_timezone',
      'invalid_locale',
      'invalid_locale',
      'invalid_currency',
      'invalid_currency',
    ]);
  });

  it('trims and bounds text, refusing control characters; colors are normalized', () => {
    const i = new Issues();
    expect(text('  Harbor  ', '/n', i, { max: 80, required: true, label: 'Name' })).toBe('Harbor');
    expect(
      text('x'.repeat(81), '/n', i, { max: 80, required: true, label: 'Name' }),
    ).toBeUndefined();
    expect(text('bell\u0007', '/n', i, { max: 80, required: true, label: 'Name' })).toBeUndefined();
    expect(text('   ', '/n', i, { max: 80, required: false, label: 'Short' })).toBeNull();
    expect(color('#A1B2C3', '/c', i)).toBe('#a1b2c3');
    expect(color('javascript:alert(1)', '/c', i)).toBeUndefined();
    expect(i.list.map((x) => x.code)).toEqual(['too_long', 'invalid_characters', 'invalid_color']);
  });

  it('brand presentation fields: closed icon set, statuses, unknown fields refused', () => {
    expect(parseBrandCreate({ name: 'A' }, 'UTC')).toMatchObject({
      color: '#336699',
      icon: 'circle',
      operational_status: 'operating',
      timezone: 'UTC',
      notification_content_mode: 'standard',
    });
    expect(() => parseBrandCreate({ name: 'A', icon: '<svg onload=x>' }, 'UTC')).toThrow();
    expect(() => parseBrandCreate({ name: 'A', lifecycle_state: 'archived' }, 'UTC')).toThrow();
    expect(() => parseBrandCreate({ name: 'A', operational_status: 'archived' }, 'UTC')).toThrow();
  });

  it('workspace creation input: all defaults explicit; nested first brand inherits the time zone', () => {
    expect(
      parseWorkspaceCreate({
        name: 'W',
        timezone: 'Asia/Kolkata',
        locale: 'en-IN',
        currency: 'INR',
        week_start: 1,
        first_brand: { name: 'B' },
      }),
    ).toMatchObject({ first_brand: { timezone: 'Asia/Kolkata' } });
    expect(() =>
      parseWorkspaceCreate({
        name: 'W',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 0,
      }),
    ).toThrow();
  });
});

describe('working hours, calendar, priorities', () => {
  const wh = (days: unknown) => {
    const i = new Issues();
    return {
      value: workingHours({ schema_version: 1, days }, i),
      codes: i.list.map((x) => x.code),
    };
  };

  it('accepts closed days, multiple sorted ranges, and end-of-day 24:00', () => {
    expect(
      wh([
        {
          weekday: 3,
          ranges: [
            { start: '13:00', end: '24:00' },
            { start: '08:00', end: '12:00' },
          ],
        },
        { weekday: 1, ranges: [] },
      ]),
    ).toEqual({
      value: {
        schema_version: 1,
        days: [
          { weekday: 1, ranges: [] },
          {
            weekday: 3,
            ranges: [
              { start: '08:00', end: '12:00' },
              { start: '13:00', end: '24:00' },
            ],
          },
        ],
      },
      codes: [],
    });
  });

  it('rejects overlaps, reversed ranges, duplicate days, bad times, and too many ranges', () => {
    expect(
      wh([
        {
          weekday: 1,
          ranges: [
            { start: '09:00', end: '12:00' },
            { start: '11:59', end: '13:00' },
          ],
        },
      ]).codes,
    ).toEqual(['overlap']);
    expect(wh([{ weekday: 1, ranges: [{ start: '12:00', end: '12:00' }] }]).codes).toEqual([
      'end_before_start',
    ]);
    expect(
      wh([
        { weekday: 1, ranges: [] },
        { weekday: 1, ranges: [] },
      ]).codes,
    ).toEqual(['duplicate_day']);
    expect(wh([{ weekday: 1, ranges: [{ start: '9:00', end: '12:00' }] }]).codes).toEqual([
      'invalid_time',
    ]);
    expect(wh([{ weekday: 1, ranges: [{ start: '24:00', end: '24:00' }] }]).codes).toEqual([
      'invalid_time',
    ]);
    expect(
      wh([
        {
          weekday: 1,
          ranges: Array.from({ length: 5 }, (_, k) => ({ start: `0${k}:00`, end: `0${k}:30` })),
        },
      ]).codes,
    ).toEqual(['too_many']);
    expect(wh([{ weekday: 8, ranges: [] }]).codes).toEqual(['invalid_weekday']);
    // Ranges that touch are not overlaps.
    expect(
      wh([
        {
          weekday: 1,
          ranges: [
            { start: '09:00', end: '12:00' },
            { start: '12:00', end: '13:00' },
          ],
        },
      ]).codes,
    ).toEqual([]);
  });

  it('calendar and priorities are bounded and closed', () => {
    const i = new Issues();
    expect(calendar({ schema_version: 1, default_view: 'month' }, i)).toEqual({
      schema_version: 1,
      week_start: null,
      show_weekends: false,
      default_view: 'month',
      label: null,
    });
    calendar({ schema_version: 1, default_view: 'gantt' }, i);
    priorities(
      {
        schema_version: 1,
        entries: Array.from({ length: 11 }, () => ({ kind: 'goal', text: 'x' })),
      },
      i,
    );
    priorities({ schema_version: 2, entries: [] }, i);
    expect(i.list.map((x) => x.code)).toEqual(['invalid_option', 'too_many', 'invalid_type']);
  });
});

describe('concurrency inputs', () => {
  it('If-Match must be a quoted version', () => {
    expect(parseIfMatch('"12"')).toBe(12);
    for (const bad of [undefined, '', '12', 'W/"12"', '"x"'])
      expect(() => parseIfMatch(bad)).toThrow(
        expect.objectContaining({ code: 'precondition_required' }),
      );
  });

  it('field-merge requests accept only writable fields with base and value', () => {
    expect(
      parseMerge({ version: 3, changes: { name: { base: 'a', value: 'b' } } }, [
        'name',
      ]).changes.get('name'),
    ).toEqual({
      base: 'a',
      value: 'b',
    });
    for (const bad of [
      {},
      { changes: {} },
      { changes: { state: { base: 'a', value: 'b' } } },
      { changes: { name: { value: 'b' } } },
      { version: 'x', changes: { name: { base: 'a', value: 'b' } } },
      { changes: { name: { base: 'a', value: 'b' } }, workspace_id: 'ws_x' },
    ])
      expect(() => parseMerge(bad, ['name'])).toThrow(
        expect.objectContaining({ code: 'validation_failed' }),
      );
  });
});

describe('account commands (0C AZ-18)', () => {
  const human = {
    principal: 'account' as const,
    account: {
      id: 'a',
      publicId: 'acct_x',
      email: 'x@example.test',
      displayName: 'X',
      locale: 'en',
      timezone: 'UTC',
      emailVerified: true,
    },
    session: {} as never,
  };

  it('workspace.create is registered, all-deny for every role, and human-account only', () => {
    expect(ACCOUNT_COMMANDS.map((c) => c.action)).toEqual([
      'workspace.create',
      'invitation.accept',
    ]);
    const row = ACTIONS.find((a) => a.key === 'workspace.create')!;
    expect(row.kind).toBe('personal');
    expect(new Set(Object.values(row.roles))).toEqual(new Set(['deny']));
    for (const role of [
      'owner',
      'administrator',
      'member',
      'limited_member',
      'read_only',
      'guest',
    ] as const)
      expect(cell('workspace.create', role)).toEqual({ kind: 'deny' });
  });

  it('authorizes only verified human accounts and never through the tenant compiler', () => {
    expect(authorizeAccountCommand('workspace.create', human)).toBe(human);
    expect(() =>
      authorizeAccountCommand('workspace.create', { principal: 'non_human', type: 'agent_run' }),
    ).toThrow(expect.objectContaining({ code: 'unauthenticated' }));
    expect(() =>
      authorizeAccountCommand('workspace.create', {
        ...human,
        account: { ...human.account, emailVerified: false },
      }),
    ).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => decideWorkspace(principal('owner'), 'workspace.create')).toThrow();
  });
});

describe('1D compiler: grantable authority, caps, guests, workspace scope, previews', () => {
  const p1 = (role: WorkspaceRole, over: Partial<Principal> = {}): Principal => ({
    ...principal(role),
    ...over,
  });

  it('grantable authority follows 0C §3.1: owners assign any role, administrators never owner', () => {
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('administrator', 'owner')).toBe(false);
    expect(canAssignRole('administrator', 'administrator')).toBe(true);
    expect(canAssignRole('member', 'member')).toBe(false);
    expect(canAssignRole('member', 'guest')).toBe(true);
    expect(canManageMember(p1('administrator'), 'owner', null)).toBe(false);
    expect(canManageMember(p1('administrator'), 'member', 'owner')).toBe(false);
    expect(canManageMember(p1('owner'), 'administrator', 'owner')).toBe(true);
    expect(canManageMember(p1('member'), 'guest', null)).toBe(false);
  });

  it('policy cells read the workspace policy; own cells allow only the caller own target', () => {
    const member = p1('member');
    expect(decideWorkspace(member, 'ownership.accept')).toEqual({ allowed: true });
    expect(decideWorkspace(p1('guest'), 'ownership.accept')).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(decideWorkspace(member, 'ownership.transfer')).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(decideWorkspace(p1('administrator'), 'ownership.transfer')).toEqual({
      allowed: false,
      code: 'forbidden',
    });
  });

  it('role caps: read-only views at most; guests see only exact shares, at most edit', () => {
    const ro = p1('read_only', { grants: new Map([['b1', 'manage']]) });
    expect(brandLevel(ro, brand())).toBe('view');
    const guest = p1('guest', { kind: 'guest', grants: new Map([['b1', 'manage']]) });
    expect(brandLevel(guest, brand())).toBeNull();
    expect(
      recordLevel(guest, { brand: brand(), lifecycleState: 'active', shareLevel: null }),
    ).toBeNull();
    expect(
      recordLevel(guest, { brand: brand(), lifecycleState: 'active', shareLevel: 'edit' }),
    ).toBe('edit');
    expect(
      recordLevel(guest, { brand: brand(), lifecycleState: 'trashed', shareLevel: 'edit' }),
    ).toBeNull();
    expect(
      recordLevel(guest, { brand: null, lifecycleState: 'active', shareLevel: null }),
    ).toBeNull();
    // Archived: view (or comment by policy) at most.
    expect(
      recordLevel(p1('owner'), { brand: brand(), lifecycleState: 'archived', shareLevel: null }),
    ).toBe('view');
  });

  it('workspace-scoped records never flow into brands; members use the default level; limited none', () => {
    expect(workspaceLevel(p1('owner'))).toBe('manage');
    expect(workspaceLevel(p1('member'))).toBe('view');
    expect(
      workspaceLevel(
        p1('member', { policy: { ...DEFAULT_POLICY, workspace_records_default_level: 'comment' } }),
      ),
    ).toBe('comment');
    expect(
      workspaceLevel(
        p1('read_only', { policy: { ...DEFAULT_POLICY, workspace_records_default_level: 'edit' } }),
      ),
    ).toBe('view');
    expect(workspaceLevel(p1('limited_member'))).toBeNull();
    expect(brandLevel(p1('member'), brand())).toBeNull();
  });

  it('team grants count like direct grants; brand-context subjects are never added for guests', () => {
    const viaTeam = p1('limited_member', { teams: ['t1'], grants: new Map([['b1', 'edit']]) });
    expect(brandLevel(viaTeam, brand())).toBe('edit');
    expect(subjectKeys(viaTeam, ['b1'])).toEqual(['b1', 'm', 't1'].sort());
    expect(subjectKeys(p1('guest', { kind: 'guest' }), ['b1'])).toEqual(['m']);
  });

  it('onward sharing is never derived from a share (AT-050)', () => {
    const shared = p1('member');
    expect(
      decideRecord(shared, 'record.share', {
        brand: brand(),
        lifecycleState: 'active',
        shareLevel: 'edit',
      }),
    ).toEqual({
      allowed: false,
      code: 'forbidden',
    });
    expect(
      decideRecord(p1('owner'), 'record.share', {
        brand: brand(),
        lifecycleState: 'active',
        shareLevel: null,
      }),
    ).toEqual({
      allowed: true,
    });
  });

  it('preview fingerprints bind viewer, change, epochs, and diff, and expire', () => {
    const key = Buffer.alloc(32, 1);
    const diff = {
      brands: [],
      records_gained: {},
      records_lost: {},
      capabilities_gained: [],
      capabilities_lost: [],
      affected_members: 1,
      increases_access: false,
    };
    const input = { viewer: 'v', change: { kind: 'role' }, epochs: [1], diff };
    const t = previewToken(key, input, 60_000, 1_000);
    expect(verifyPreviewToken(key, t, input, 2_000)).toBe(true);
    expect(verifyPreviewToken(key, t, { ...input, epochs: [2] }, 2_000)).toBe(false);
    expect(verifyPreviewToken(key, t, { ...input, viewer: 'w' }, 2_000)).toBe(false);
    expect(verifyPreviewToken(key, t, input, 70_000)).toBe(false);
    expect(verifyPreviewToken(Buffer.alloc(32, 2), t, input, 2_000)).toBe(false);
  });
});
