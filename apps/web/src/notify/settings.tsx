import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { Problem } from '../collab/shared.tsx';
import { projects as projectsClient, type ProjectSummary } from '../projects/client.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { timeZones } from '../tenancy/client.ts';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Banner } from '../ui/feedback.tsx';
import { browserSupported } from './bell.tsx';
import {
  announceProfileChanged,
  NOTIFICATION_TYPES,
  notifications,
  TYPE_LABEL,
  type Delivery,
  type DigestCadence,
  type Mode,
  type PrefChannel,
  type Preference,
  type Preferences,
  type Profile,
} from './client.ts';
import {
  CHANNEL_LABEL,
  DELIVERY_STATE_LABEL,
  deliveryReason,
  explainNotify,
  isStale,
  MODE_LABEL,
  relativeTime,
  useNow,
  useOnline,
  when,
  WEEKDAYS,
  type Explained,
} from './shared.tsx';

/**
 * A person's notification settings (4B): what each channel can truthfully do now, quiet hours and
 * the digest, browser notifications (asked for only on a click), the per-type choices and mutes,
 * a plain history of recent deliveries, and (for administrators) the health of delivery. Nothing
 * here ever says "sent" for something that was only queued or could not be sent (UXD-18).
 */

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) => (
  <section className="card" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    {children}
  </section>
);

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------

export function emailStatus(p: Profile): string {
  if (p.channels.email.state === 'not_configured')
    return "Email isn't set up for this workspace yet, so nothing is sent.";
  if (p.channels.email.provider === 'capture')
    return 'Email is in test mode for this workspace: messages are captured and are not delivered to inboxes.';
  return p.email_enabled
    ? 'Email is on. Urgent notifications are emailed right away and the rest go in your digest. A message is only counted as delivered once the email provider accepts it.'
    : 'Email is off for you, so nothing is emailed.';
}

function browserStatus(p: Profile, live: NotificationPermission | 'unsupported'): string {
  if (live === 'unsupported')
    return "This browser doesn't support notifications, so they can't be turned on here.";
  if (live === 'denied' || p.browser_permission === 'denied')
    return 'Off. Your browser is blocking notifications for this site.';
  if (p.channels.browser.state === 'on' && live === 'granted')
    return 'On. They appear while the app is open in a browser tab.';
  return 'Off.';
}

function Channels({
  profile,
  live,
}: {
  profile: Profile;
  live: NotificationPermission | 'unsupported';
}) {
  return (
    <Section id="nset-channels" title="Where you get notifications">
      <dl className="ntf-channels">
        <div>
          <dt>In the app</dt>
          <dd>On. The notification centre always has everything addressed to you.</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{emailStatus(profile)}</dd>
        </div>
        <div>
          <dt>Browser</dt>
          <dd>{browserStatus(profile, live)}</dd>
        </div>
      </dl>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Profile: time zone, quiet hours, digest, email
// ---------------------------------------------------------------------------------------------

interface Form {
  timezone: string;
  quiet: boolean;
  quietStart: string;
  quietEnd: string;
  email: boolean;
  cadence: DigestCadence;
  dailyTime: string;
  weekday: number;
  weeklyTime: string;
}

const formOf = (p: Profile): Form => ({
  timezone: p.timezone ?? '',
  quiet: p.quiet_hours !== null,
  quietStart: p.quiet_hours?.start ?? '22:00',
  quietEnd: p.quiet_hours?.end ?? '07:00',
  email: p.email_enabled,
  cadence: p.digest_cadence,
  dailyTime: p.daily_digest_time,
  weekday: p.weekly_digest_day,
  weeklyTime: p.weekly_digest_time,
});

function ProfileForm({
  ws,
  profile,
  onProfile,
}: {
  ws: string;
  profile: Profile;
  onProfile: (p: Profile) => void;
}) {
  const online = useOnline();
  const [saved, setSaved] = useState<Form>(() => formOf(profile));
  const [form, setForm] = useState<Form>(() => formOf(profile));
  const [version, setVersion] = useState(profile.version);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = useRef<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const zones = [...new Set([...(form.timezone ? [form.timezone] : []), ...timeZones()])];
  const edit = (patch: Partial<Form>) => {
    key.current = null; // a changed form is a new request
    setNotice('');
    setForm((f) => ({ ...f, ...patch }));
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const found: Record<string, string> = {};
    if (form.quiet && form.quietStart === form.quietEnd)
      found.quietEnd = 'Quiet hours need different start and end times.';
    for (const [k, v] of [
      ['quietStart', form.quietStart],
      ['quietEnd', form.quietEnd],
      ['dailyTime', form.dailyTime],
      ['weeklyTime', form.weeklyTime],
    ] as const)
      if (!/^\d\d:\d\d$/.test(v)) found[k] = 'Choose a time.';
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setProblem(null);
    setNotice('');
    key.current ??= newIdempotencyKey();
    try {
      const next = await notifications.saveProfile(
        ws,
        {
          timezone: form.timezone || null,
          quiet_hours: form.quiet ? { start: form.quietStart, end: form.quietEnd } : null,
          email_enabled: form.email,
          digest_cadence: form.cadence,
          daily_digest_time: form.dailyTime,
          weekly_digest_day: form.weekday,
          weekly_digest_time: form.weeklyTime,
        },
        version,
        key.current,
      );
      key.current = null;
      setVersion(next.version);
      setSaved(form);
      onProfile(next);
      announceProfileChanged();
      setNotice('Saved.');
    } catch (err) {
      if (isStale(err)) {
        // Someone (or another tab) changed the settings: take the new version, keep these edits.
        key.current = null;
        try {
          const fresh = await notifications.profile(ws);
          const latest = formOf(fresh);
          // Keep what this person changed; whatever they left alone takes the newer value.
          const merged = { ...latest } as Record<keyof Form, Form[keyof Form]>;
          for (const k of Object.keys(form) as Array<keyof Form>)
            if (form[k] !== saved[k]) merged[k] = form[k];
          setVersion(fresh.version);
          setSaved(latest);
          setForm(merged as unknown as Form);
          onProfile(fresh);
          setProblem({
            message:
              'Your settings were changed somewhere else. We loaded the latest version and kept your edits. Review them, then save again.',
            kind: 'stale',
            retryable: false,
          });
        } catch (again) {
          setProblem(explainNotify(again, 'reloading', true));
        }
      } else setProblem(explainNotify(err, 'saving', true));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="nset-profile" title="Time, quiet hours, and digest">
      <form onSubmit={(e) => void save(e)} noValidate>
        <div className="field">
          <label htmlFor="nset-tz">Time zone</label>
          <p className="hint" id="nset-tz-hint">
            Quiet hours and digests follow this time zone.
          </p>
          <select
            id="nset-tz"
            aria-describedby="nset-tz-hint"
            value={form.timezone}
            onChange={(e) => edit({ timezone: e.target.value })}
          >
            <option value="">
              {profile.timezone
                ? 'Use my account time zone'
                : `Use my account time zone (${profile.effective_timezone})`}
            </option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="choices">
          <legend>Quiet hours</legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={form.quiet}
              onChange={(e) => edit({ quiet: e.target.checked })}
            />
            Hold email and browser notifications during quiet hours
          </label>
          {form.quiet ? (
            <div className="ntf-times">
              <TimeField
                id="nset-qs"
                label="Quiet hours start"
                value={form.quietStart}
                error={errors.quietStart}
                onChange={(v) => edit({ quietStart: v })}
              />
              <TimeField
                id="nset-qe"
                label="Quiet hours end"
                value={form.quietEnd}
                error={errors.quietEnd}
                onChange={(v) => edit({ quietEnd: v })}
              />
            </div>
          ) : null}
          <p className="hint">
            Held notifications are sent when quiet hours end. Security notices and the in-app centre
            are never held.
          </p>
        </fieldset>

        <fieldset className="choices">
          <legend>Email</legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={form.email}
              onChange={(e) => edit({ email: e.target.checked })}
            />
            Email me notifications
          </label>
          <p className="hint">{emailStatus({ ...profile, email_enabled: form.email })}</p>
        </fieldset>

        <fieldset className="choices">
          <legend>Digest</legend>
          <div className="field">
            <label htmlFor="nset-cadence">Send me a digest</label>
            <select
              id="nset-cadence"
              value={form.cadence}
              onChange={(e) => edit({ cadence: e.target.value as DigestCadence })}
            >
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          {form.cadence === 'daily' ? (
            <TimeField
              id="nset-dt"
              label="Daily digest time"
              value={form.dailyTime}
              error={errors.dailyTime}
              onChange={(v) => edit({ dailyTime: v })}
            />
          ) : null}
          {form.cadence === 'weekly' ? (
            <div className="ntf-times">
              <div className="field">
                <label htmlFor="nset-wd">Weekly digest day</label>
                <select
                  id="nset-wd"
                  value={form.weekday}
                  onChange={(e) => edit({ weekday: Number(e.target.value) })}
                >
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i + 1}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <TimeField
                id="nset-wt"
                label="Weekly digest time"
                value={form.weeklyTime}
                error={errors.weeklyTime}
                onChange={(v) => edit({ weeklyTime: v })}
              />
            </div>
          ) : null}
          <p className="hint">
            You get one digest at a time, with everything that is waiting in a single email, never
            one email per item.
          </p>
        </fieldset>

        {!online ? (
          <p className="collab-offline" role="status">
            <span aria-hidden="true">! </span>
            You're offline. Your edits are kept here. Save when you're back online.
          </p>
        ) : null}
        <Problem problem={problem} onRetry={() => void save()} busy={busy} />
        <div className="actions">
          <button type="submit" className="button button-primary" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
          {dirty ? <span className="hint">You have unsaved changes.</span> : null}
        </div>
        <p className="announce" role="status">
          {notice}
        </p>
      </form>
    </Section>
  );
}

function TimeField({
  id,
  label,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>{label}</label>
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
      <input
        id={id}
        type="time"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Browser notifications: the permission prompt only ever follows the person's own click
// ---------------------------------------------------------------------------------------------

function BrowserSection({
  ws,
  profile,
  live,
  setLive,
  onProfile,
}: {
  ws: string;
  profile: Profile;
  live: NotificationPermission | 'unsupported';
  setLive: (p: NotificationPermission | 'unsupported') => void;
  onProfile: (p: Profile) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [notice, setNotice] = useState('');
  const on = profile.channels.browser.state === 'on' && live === 'granted';

  const save = async (patch: Parameters<typeof notifications.saveProfile>[1]) => {
    try {
      const next = await notifications.saveProfile(ws, patch, profile.version);
      onProfile(next);
      announceProfileChanged();
      return true;
    } catch (err) {
      if (isStale(err)) {
        try {
          onProfile(await notifications.profile(ws));
        } catch {
          // The failure message below covers it.
        }
        setProblem({
          message: 'Your settings were changed somewhere else. We loaded the latest. Try again.',
          kind: 'stale',
          retryable: false,
        });
      } else setProblem(explainNotify(err, 'saving'));
      return false;
    }
  };

  // This runs only from the button's click, so the browser's prompt is always the person's choice.
  const turnOn = async () => {
    if (!browserSupported()) return;
    setProblem(null);
    setNotice('');
    setBusy(true);
    const ask = async (): Promise<NotificationPermission> => Notification.requestPermission();
    const result = await ask().catch((): NotificationPermission => 'default');
    setLive(result);
    const permission =
      result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'unknown';
    const ok = await save({ browser_enabled: true, browser_permission: permission });
    if (ok)
      setNotice(
        permission === 'granted'
          ? 'Browser notifications are on.'
          : permission === 'denied'
            ? 'Your browser blocked notifications, so they are not on.'
            : 'You closed the prompt without choosing, so nothing is on yet.',
      );
    setBusy(false);
  };
  const turnOff = async () => {
    setProblem(null);
    setNotice('');
    setBusy(true);
    if (await save({ browser_enabled: false })) setNotice('Browser notifications are off.');
    setBusy(false);
  };

  return (
    <Section id="nset-browser" title="Browser notifications">
      {live === 'unsupported' ? (
        <p>
          This browser doesn't support notifications, so they can't be turned on here. The in-app
          centre and email still work.
        </p>
      ) : (
        <>
          <p>
            Show a short notification while the app is open in a browser tab. They are off until you
            turn them on, and your browser asks for permission first.
          </p>
          {live === 'denied' ? (
            <Banner tone="warning" title="Your browser is blocking notifications for this site">
              To turn them on, allow notifications for this site in your browser's site settings,
              then reload this page. We won't ask again on our own.
            </Banner>
          ) : null}
          {on ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void turnOff()}
            >
              Turn off browser notifications
            </button>
          ) : live !== 'denied' ? (
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void turnOn()}
            >
              Turn on browser notifications
            </button>
          ) : null}
        </>
      )}
      <Problem problem={problem} />
      <p className="announce" role="status">
        {notice}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Preferences and mutes
// ---------------------------------------------------------------------------------------------

const CHANNELS = ['in_app', 'email', 'browser'] as const;

const isOverride = (r: Preference) =>
  r.scope_kind === 'workspace' && r.event_type !== '*' && r.channel !== 'all';

function PreferencesSection({
  ws,
  prefs,
  reload,
}: {
  ws: string;
  prefs: Preferences;
  reload: () => Promise<void>;
}) {
  const [local, setLocal] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Explained | null>(null);
  const [notice, setNotice] = useState('');
  const overrides = prefs.data.filter(isOverride);
  const valueOf = (type: string, channel: string): string =>
    local[`${type}|${channel}`] ??
    overrides.find((r) => r.event_type === type && r.channel === channel)?.mode ??
    'default';

  const choose = async (type: string, channel: (typeof CHANNELS)[number], value: string) => {
    const k = `${type}|${channel}`;
    setProblem(null);
    setNotice('');
    setLocal((l) => ({ ...l, [k]: value }));
    try {
      if (value === 'default')
        await notifications.removePreference(ws, {
          event_type: type,
          scope: 'workspace',
          channel,
        });
      else
        await notifications.setPreference(ws, {
          event_type: type,
          scope: 'workspace',
          channel,
          mode: value as Mode,
        });
      await reload();
      setNotice('Saved.');
    } catch (err) {
      setProblem(explainNotify(err, 'saving'));
    } finally {
      setLocal((l) => {
        const { [k]: _gone, ...rest } = l;
        return rest;
      });
    }
  };

  return (
    <Section id="nset-prefs" title="What you get, by type">
      <p className="hint">
        Each type shows what applies by default. Change a channel to override it. Security notices
        are always on.
      </p>
      <div className="table-scroll">
        <table className="ntf-table">
          <caption className="visually-hidden">Notification types and channels</caption>
          <thead>
            <tr>
              <th scope="col">Type</th>
              {CHANNELS.map((c) => (
                <th key={c} scope="col">
                  {CHANNEL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prefs.defaults.map((d) => (
              <tr key={d.event_type}>
                <th scope="row">{d.label}</th>
                {d.security ? (
                  <td colSpan={3}>Always on. Security notices can't be muted.</td>
                ) : (
                  CHANNELS.map((c) => {
                    const id = `pref-${d.event_type}-${c}`;
                    return (
                      <td key={c}>
                        <label className="visually-hidden" htmlFor={id}>
                          {CHANNEL_LABEL[c]} for {d.label}
                        </label>
                        <select
                          id={id}
                          value={valueOf(d.event_type, c)}
                          onChange={(e) => void choose(d.event_type, c, e.target.value)}
                        >
                          <option value="default">Default: {MODE_LABEL[d[c]]}</option>
                          <option value="immediate">Immediately</option>
                          {c === 'email' ? <option value="digest">In the digest</option> : null}
                          <option value="muted">Off</option>
                        </select>
                      </td>
                    );
                  })
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        You have {prefs.data.length} of {prefs.limit} saved choices and mutes.
      </p>
      <Problem problem={problem} />
      <p className="announce" role="status">
        {notice}
      </p>
    </Section>
  );
}

const MUTE_UNTIL: Array<[string, string, number | null]> = [
  ['forever', 'Until I turn it back on', null],
  ['hour', 'For 1 hour', 3600_000],
  ['day', 'For 1 day', 24 * 3600_000],
  ['week', 'For 1 week', 7 * 24 * 3600_000],
  ['month', 'For 30 days', 30 * 24 * 3600_000],
];

const scopeWords = (r: Preference): string => {
  if (r.scope_kind === 'workspace') return 'Everywhere in this workspace';
  if (r.scope === null || r.scope_name === null) return 'A place you can no longer open';
  return `${r.scope_kind === 'brand' ? 'Brand' : r.scope_kind === 'project' ? 'Project' : 'Task'}: ${r.scope_name}`;
};

function MutesSection({
  ws,
  prefs,
  reload,
}: {
  ws: string;
  prefs: Preferences;
  reload: () => Promise<void>;
}) {
  const shell = useWorkspaceShell();
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    let active = true;
    projectsClient.list(ws).then(
      (r) => active && setProjectList(r.data),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [ws]);
  const brands = shell?.context?.brands ?? [];
  const mutes = prefs.data.filter((r) => !isOverride(r));
  const [scope, setScope] = useState('');
  const [type, setType] = useState('*');
  const [channel, setChannel] = useState<PrefChannel>('all');
  const [until, setUntil] = useState('forever');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [notice, setNotice] = useState('');
  const now = useNow();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!scope) {
      setProblem({ message: 'Choose what to mute.', kind: 'rejected', retryable: false });
      return;
    }
    const ms = MUTE_UNTIL.find(([k]) => k === until)![2];
    setBusy(true);
    setProblem(null);
    setNotice('');
    try {
      await notifications.setPreference(ws, {
        event_type: type,
        scope,
        channel,
        mode: 'muted',
        ...(ms ? { expires_at: new Date(Date.now() + ms).toISOString() } : {}),
      });
      await reload();
      setNotice('Muted.');
    } catch (err) {
      setProblem(explainNotify(err, 'muting'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: Preference) => {
    if (!r.scope) return;
    setProblem(null);
    setNotice('');
    try {
      await notifications.removePreference(ws, {
        event_type: r.event_type,
        scope: r.scope,
        channel: r.channel,
      });
      await reload();
      setNotice('Mute removed.');
    } catch (err) {
      setProblem(explainNotify(err, 'removing it'));
    }
  };

  return (
    <Section id="nset-mutes" title="Mutes">
      <p className="hint">
        Mute a brand, a project, or a kind of notification. Security notices are never muted. You
        can keep up to {prefs.limit} choices and mutes in all.
      </p>
      {mutes.length ? (
        <ul className="plain-list ntf-mutes" aria-label="Your mutes">
          {mutes.map((r) => {
            const what = `${r.event_type === '*' ? 'All notifications' : (TYPE_LABEL[r.event_type as keyof typeof TYPE_LABEL] ?? r.event_type)} · ${CHANNEL_LABEL[r.channel]}`;
            const desc = `${scopeWords(r)}, ${what}`;
            const expired = r.expires_at ? new Date(r.expires_at).getTime() <= now : false;
            return (
              <li
                key={`${r.scope_kind}|${r.scope}|${r.event_type}|${r.channel}`}
                className="ntf-mute"
              >
                <span>
                  <strong>{scopeWords(r)}</strong> · {what} ·{' '}
                  {r.mode === 'muted' ? 'Muted' : MODE_LABEL[r.mode]}{' '}
                  <span className="hint">
                    {r.expires_at
                      ? expired
                        ? `(ended ${relativeTime(r.expires_at, now)})`
                        : `(until ${when(r.expires_at)})`
                      : '(until you remove it)'}
                  </span>
                  {r.scope === null && r.scope_kind !== 'workspace' ? (
                    <span className="hint block">
                      It applies again if you get access back. It can't be removed from here,
                      because you can't open the place it is about.
                    </span>
                  ) : null}
                </span>
                {r.scope ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    aria-label={`Remove mute: ${desc}`}
                    onClick={() => void remove(r)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty">You haven't muted anything.</p>
      )}
      <form onSubmit={(e) => void add(e)} className="ntf-mute-form" aria-label="Add a mute">
        <div className="field">
          <label htmlFor="mute-scope">Mute</label>
          <select id="mute-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Choose a brand or project…</option>
            {brands.length ? (
              <optgroup label="Brands">
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {projectList.length ? (
              <optgroup label="Projects">
                {projectList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mute-type">What to mute</label>
          <select id="mute-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="*">All types</option>
            {NOTIFICATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mute-channel">Where</label>
          <select
            id="mute-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as PrefChannel)}
          >
            <option value="all">All channels</option>
            <option value="in_app">In the app</option>
            <option value="email">Email</option>
            <option value="browser">Browser</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="mute-until">For how long</label>
          <select id="mute-until" value={until} onChange={(e) => setUntil(e.target.value)}>
            {MUTE_UNTIL.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button type="submit" className="button button-secondary" disabled={busy}>
            Add mute
          </button>
        </div>
      </form>
      <Problem problem={problem} />
      <p className="announce" role="status">
        {notice}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------------

function DeliveryLine({ d, now }: { d: Delivery; now: number }) {
  const reason = deliveryReason(d);
  const channel = d.kind === 'digest' ? 'Digest email' : (CHANNEL_LABEL[d.channel] ?? d.channel);
  const type = d.notification_type
    ? (TYPE_LABEL[d.notification_type as keyof typeof TYPE_LABEL] ?? null)
    : null;
  return (
    <>
      <strong>{channel}</strong>
      {type ? <> · {type}</> : null} · {DELIVERY_STATE_LABEL[d.state] ?? d.state}
      {reason ? <> · {reason}</> : null}
      {d.attempts > 1 ? <> · {d.attempts} attempts</> : null} ·{' '}
      <time dateTime={d.updated_at} title={when(d.updated_at)}>
        {relativeTime(d.updated_at, now)}
      </time>
    </>
  );
}

function usePagedList<T>(
  load: (
    cursor?: string,
  ) => Promise<{ data: T[]; page: { has_more: boolean; next_cursor?: string } }>,
  key: string,
) {
  const [entry, setEntry] = useState<{
    key: string;
    rows: T[];
    cursor: string | null;
    error: unknown;
  } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [more, setMore] = useState<{ busy: boolean; e: Explained | null }>({
    busy: false,
    e: null,
  });
  useEffect(() => {
    let active = true;
    load().then(
      (r) =>
        active &&
        setEntry({
          key,
          rows: r.data,
          cursor: r.page.has_more ? (r.page.next_cursor ?? null) : null,
          error: null,
        }),
      (error: unknown) => active && setEntry({ key, rows: [], cursor: null, error }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const current = entry?.key === key ? entry : null;
  return {
    rows: current?.rows ?? [],
    cursor: current?.cursor ?? null,
    error: current?.error ?? null,
    loading: current === null,
    more,
    setRows: (f: (rows: T[]) => T[]) => setEntry((e) => (e ? { ...e, rows: f(e.rows) } : e)),
    retry: () => {
      setEntry(null);
      setNonce((n) => n + 1);
    },
    loadMore: async () => {
      if (!current?.cursor) return;
      setMore({ busy: true, e: null });
      try {
        const r = await load(current.cursor);
        setEntry((e) =>
          e
            ? {
                ...e,
                rows: [...e.rows, ...r.data],
                cursor: r.page.has_more ? (r.page.next_cursor ?? null) : null,
              }
            : e,
        );
        setMore({ busy: false, e: null });
      } catch (err) {
        setMore({ busy: false, e: explainNotify(err, 'loading more') });
      }
    },
  };
}

function DeliveryHistory({ ws }: { ws: string }) {
  const now = useNow();
  const list = usePagedList(
    (cursor) => notifications.myDeliveries(ws, cursor ? { cursor } : {}),
    ws,
  );
  return (
    <Section id="nset-history" title="Recent deliveries">
      <p className="hint">
        What happened to the email and browser notifications meant for you. This never shows what a
        notification said.
      </p>
      {list.loading ? <p className="loading">Loading recent deliveries…</p> : null}
      {list.error ? (
        <Problem problem={explainNotify(list.error, 'loading')} onRetry={list.retry} />
      ) : null}
      {!list.loading && !list.error && !list.rows.length ? (
        <p className="empty">Nothing has been sent to you by email or browser yet.</p>
      ) : null}
      {list.rows.length ? (
        <ul className="plain-list ntf-deliveries" aria-label="Recent deliveries">
          {list.rows.map((d) => (
            <li key={d.id} className="ntf-delivery">
              <DeliveryLine d={d} now={now} />
            </li>
          ))}
        </ul>
      ) : null}
      <Problem problem={list.more.e} onRetry={() => void list.loadMore()} busy={list.more.busy} />
      {list.cursor ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={list.more.busy}
          onClick={() => void list.loadMore()}
        >
          {list.more.busy ? 'Loading…' : 'Load more deliveries'}
        </button>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Delivery health (administrators only: hidden when the server says no)
// ---------------------------------------------------------------------------------------------

const EMAIL_PROVIDER: Record<string, string> = {
  configured: 'Email is set up and sending through your provider.',
  capture: 'Email is in test mode: messages are captured and are not delivered to inboxes.',
  unconfigured: "Email isn't set up for this workspace yet, so nothing is sent.",
};

function DeliveryHealth({ ws }: { ws: string }) {
  const now = useNow();
  const [email, setEmail] = useState<string | null>(null);
  const list = usePagedList(async (cursor) => {
    const r = await notifications.health(ws, cursor ? { cursor } : {});
    setEmail(r.email);
    return r;
  }, ws);
  const [result, setResult] = useState('');
  const [problem, setProblem] = useState<Explained | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const hidden =
    list.error instanceof ApiError &&
    (list.error.status === 403 || list.error.status === 404 || list.error.status === 401);
  if (hidden || list.loading) return null;
  if (list.error)
    return (
      <Section id="nset-health" title="Delivery health">
        <Problem problem={explainNotify(list.error, 'loading')} onRetry={list.retry} />
      </Section>
    );

  const retry = async (d: Delivery) => {
    setBusy(d.id);
    setProblem(null);
    setResult('');
    try {
      await notifications.retry(ws, d.id);
      list.setRows((rows) => rows.filter((r) => r.id !== d.id));
      setResult(
        `Queued again for ${d.recipient?.name ?? 'the recipient'}. It is sent once the provider accepts it.`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.issues.some((i) => i.code === 'not_retryable'))
        setProblem({
          message:
            "That delivery can't be retried: it is no longer failed. Refresh to see where it stands.",
          kind: 'rejected',
          retryable: false,
        });
      else if (err instanceof ApiError && err.code === 'forbidden')
        setProblem({
          message: "You don't have permission to retry deliveries.",
          kind: 'permission',
          retryable: false,
        });
      else setProblem(explainNotify(err, 'retrying'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section id="nset-health" title="Delivery health">
      <p>{email ? (EMAIL_PROVIDER[email] ?? '') : ''}</p>
      <h3>Failed deliveries</h3>
      {!list.rows.length ? (
        <p className="empty">No deliveries have failed.</p>
      ) : (
        <ul className="plain-list ntf-deliveries" aria-label="Failed deliveries">
          {list.rows.map((d) => (
            <li key={d.id} className="ntf-delivery">
              <span>
                {d.recipient?.name ?? 'Someone'} · <DeliveryLine d={d} now={now} />
              </span>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy === d.id}
                aria-label={`Retry delivery to ${d.recipient?.name ?? 'the recipient'}, ${CHANNEL_LABEL[d.channel] ?? d.channel}`}
                onClick={() => void retry(d)}
              >
                Retry
              </button>
            </li>
          ))}
        </ul>
      )}
      <Problem problem={problem} />
      <p className="announce" role="status">
        {result}
      </p>
      <Problem problem={list.more.e} onRetry={() => void list.loadMore()} busy={list.more.busy} />
      {list.cursor ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={list.more.busy}
          onClick={() => void list.loadMore()}
        >
          {list.more.busy ? 'Loading…' : 'Load more failed deliveries'}
        </button>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// The page body
// ---------------------------------------------------------------------------------------------

export function NotificationSettings({ ws }: { ws: string }) {
  const profile = useResource(() => notifications.profile(ws), `profile:${ws}`);
  const prefs = useResource(() => notifications.preferences(ws), `prefs:${ws}`, {
    keepOnRefreshError: true,
  });
  const [live, setLive] = useState<NotificationPermission | 'unsupported'>(() =>
    browserSupported() ? Notification.permission : 'unsupported',
  );
  return (
    <>
      <ResourceView resource={profile.state} onRetry={profile.retry} what="notification settings">
        {(p) => (
          <>
            <Channels profile={p} live={live} />
            <ProfileForm ws={ws} profile={p} onProfile={profile.set} />
            <BrowserSection
              ws={ws}
              profile={p}
              live={live}
              setLive={setLive}
              onProfile={profile.set}
            />
          </>
        )}
      </ResourceView>
      <ResourceView resource={prefs.state} onRetry={prefs.retry} what="notification choices">
        {(d) => (
          <>
            <PreferencesSection ws={ws} prefs={d} reload={prefs.refresh} />
            <MutesSection ws={ws} prefs={d} reload={prefs.refresh} />
          </>
        )}
      </ResourceView>
      <DeliveryHistory ws={ws} />
      <DeliveryHealth ws={ws} />
    </>
  );
}
