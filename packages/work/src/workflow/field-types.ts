import { compilePattern, PatternError, type Pattern } from './pattern.ts';

/**
 * Custom field types (ADR-0015 W10–W16): per-type configuration, validation, and canonical value
 * normalization. The database repeats the shape checks (workflow.field_value_shape); this module
 * gives pointer-addressed, user-facing errors first. Client validation is only assistance.
 */

export const FIELD_TYPES = [
  'text',
  'number',
  'currency',
  'percentage',
  'date',
  'person',
  'label',
  'checkbox',
  'url',
  'email',
  'select',
  'formula',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Invariants (not tunable): decimal scale and the percentage range in percentage points. */
export const DECIMAL_SCALE_MAX = 12;
export const PERCENT_SCALE_MAX = 4;
export const PERCENT_MIN = -1000;
export const PERCENT_MAX = 1000;
export const URL_SCHEMES = ['https', 'http', 'mailto'] as const;
const URL_MAX = 2048;
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EMAIL_MAX = 254;

/** ISO 4217 active codes and their minor-unit exponents (2 unless listed otherwise). */
const ISO_4217 =
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL'.split(
    ' ',
  );
const EXPONENT: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};
export const CURRENCIES: ReadonlySet<string> = new Set(ISO_4217);
export const currencyExponent = (code: string) => EXPONENT[code] ?? 2;

export interface FieldIssue {
  path: string;
  code: string;
  message: string;
}
export class FieldValidation extends Error {
  readonly issues: FieldIssue[];
  constructor(issues: FieldIssue[]) {
    super('field validation failed');
    this.issues = issues;
  }
}
const fail = (path: string, code: string, message: string): never => {
  throw new FieldValidation([{ path, code, message }]);
};

export interface FieldBounds {
  textMax: number;
  patternMax: number;
}

// -----------------------------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------------------------

export type FieldConfig = Record<string, unknown>;
const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const DEC = (scale: number) => new RegExp(`^-?[0-9]{1,18}(\\.[0-9]{1,${scale}})?$`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const ALLOWED: Record<FieldType, readonly string[]> = {
  text: ['min_length', 'max_length', 'pattern', 'multiline'],
  number: ['min', 'max', 'scale'],
  currency: ['currency', 'min_minor', 'max_minor'],
  percentage: ['min', 'max', 'scale'],
  date: ['min_date', 'max_date'],
  person: [],
  label: [],
  checkbox: [],
  url: ['schemes'],
  email: [],
  select: [],
  formula: ['source'],
};

/** Validates and canonicalizes a definition's type configuration (unknown keys are refused). */
export function parseFieldConfig(
  type: FieldType,
  raw: unknown,
  b: FieldBounds,
  base = '/config',
): FieldConfig {
  const c = raw === undefined || raw === null ? {} : raw;
  if (!isObj(c)) return fail(base, 'invalid', 'Configuration must be an object.');
  for (const k of Object.keys(c))
    if (!ALLOWED[type].includes(k))
      fail(`${base}/${k}`, 'unknown', `${type} fields have no ${k} setting.`);
  const out: FieldConfig = {};
  const int = (k: string, lo: number, hi: number) => {
    const v = c[k];
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi)
      fail(`${base}/${k}`, 'invalid', `Enter a whole number from ${lo} to ${hi}.`);
    out[k] = v;
    return v as number;
  };
  const dec = (k: string, scale: number, lo?: number, hi?: number) => {
    const v = c[k];
    if (v === undefined || v === null) return undefined;
    const s = typeof v === 'number' ? String(v) : v;
    if (typeof s !== 'string' || !DEC(scale).test(s))
      return fail(`${base}/${k}`, 'invalid', 'Enter a number.');
    if ((lo !== undefined && Number(s) < lo) || (hi !== undefined && Number(s) > hi))
      fail(`${base}/${k}`, 'invalid', `Enter a number from ${lo} to ${hi}.`);
    out[k] = s;
    return Number(s);
  };
  switch (type) {
    case 'text': {
      const lo = int('min_length', 0, b.textMax) ?? 0;
      const hi = int('max_length', 1, b.textMax) ?? b.textMax;
      if (lo > hi) fail(`${base}/min_length`, 'invalid', 'The minimum is larger than the maximum.');
      if (c.pattern !== undefined && c.pattern !== null) {
        if (typeof c.pattern !== 'string') fail(`${base}/pattern`, 'invalid', 'Enter a pattern.');
        try {
          compilePattern(c.pattern as string, b.patternMax);
        } catch (e) {
          if (e instanceof PatternError) fail(`${base}/pattern`, 'pattern_invalid', e.message);
          throw e;
        }
        out.pattern = c.pattern;
      }
      if (c.multiline !== undefined) {
        if (typeof c.multiline !== 'boolean')
          fail(`${base}/multiline`, 'invalid', 'Choose yes or no.');
        out.multiline = c.multiline;
      }
      break;
    }
    case 'number': {
      const scale = int('scale', 0, DECIMAL_SCALE_MAX) ?? 2;
      out.scale = scale;
      const lo = dec('min', DECIMAL_SCALE_MAX);
      const hi = dec('max', DECIMAL_SCALE_MAX);
      if (lo !== undefined && hi !== undefined && lo > hi)
        fail(`${base}/min`, 'invalid', 'The minimum is larger than the maximum.');
      break;
    }
    case 'percentage': {
      const scale = int('scale', 0, PERCENT_SCALE_MAX) ?? 0;
      out.scale = scale;
      const lo = dec('min', PERCENT_SCALE_MAX, PERCENT_MIN, PERCENT_MAX) ?? 0;
      const hi = dec('max', PERCENT_SCALE_MAX, PERCENT_MIN, PERCENT_MAX) ?? 100;
      out.min = String(lo);
      out.max = String(hi);
      if (lo > hi) fail(`${base}/min`, 'invalid', 'The minimum is larger than the maximum.');
      break;
    }
    case 'currency': {
      if (typeof c.currency !== 'string' || !CURRENCIES.has(c.currency))
        fail(`${base}/currency`, 'invalid', 'Choose an ISO 4217 currency.');
      out.currency = c.currency;
      for (const k of ['min_minor', 'max_minor']) {
        const v = c[k];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' || !/^-?[0-9]{1,18}$/.test(v))
          fail(`${base}/${k}`, 'invalid', 'Enter an amount in minor units.');
        out[k] = v;
      }
      if (
        out.min_minor !== undefined &&
        out.max_minor !== undefined &&
        BigInt(out.min_minor as string) > BigInt(out.max_minor as string)
      )
        fail(`${base}/min_minor`, 'invalid', 'The minimum is larger than the maximum.');
      break;
    }
    case 'date':
      for (const k of ['min_date', 'max_date']) {
        const v = c[k];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' || !validDate(v))
          fail(`${base}/${k}`, 'invalid', 'Enter a date.');
        out[k] = v;
      }
      if (out.min_date && out.max_date && (out.min_date as string) > (out.max_date as string))
        fail(`${base}/min_date`, 'invalid', 'The earliest date is after the latest.');
      break;
    case 'url': {
      const s = c.schemes ?? ['https'];
      if (
        !Array.isArray(s) ||
        s.length === 0 ||
        s.some((x) => !(URL_SCHEMES as readonly string[]).includes(x as string))
      )
        fail(`${base}/schemes`, 'invalid', `Choose from ${URL_SCHEMES.join(', ')}.`);
      out.schemes = [...new Set(s as string[])].sort();
      break;
    }
    case 'formula':
      // The source is compiled by the definition command (it needs the referenced definitions).
      if (typeof c.source !== 'string') fail(`${base}/source`, 'required', 'Enter a formula.');
      out.source = c.source;
      break;
    default:
      break;
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// Values
// -----------------------------------------------------------------------------------------------

/**
 * A reference resolver supplied by the service: maps a public ID to an internal ID when the
 * target is eligible (active member, label of the record's brand, active option of this field).
 * Returns null when the target is not eligible; the error never says why.
 */
export type RefResolver = (
  kind: 'person' | 'label' | 'select',
  publicId: string,
) => Promise<string | null>;

const patternCache = new Map<string, Pattern>();
function pattern(src: string, max: number): Pattern {
  let p = patternCache.get(src);
  if (!p) {
    p = compilePattern(src, max);
    if (patternCache.size > 500) patternCache.clear();
    patternCache.set(src, p);
  }
  return p;
}

const normEmail = (s: string) => {
  const t = s.trim();
  const at = t.lastIndexOf('@');
  if (at < 1 || at === t.length - 1 || t.length > EMAIL_MAX) return null;
  const local = t.slice(0, at);
  const domain = t.slice(at + 1).toLowerCase();
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  )
    return null;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
    return null;
  return `${local}@${domain}`;
};
const normUrl = (s: string, schemes: readonly string[]) => {
  const t = s.trim();
  if (!t || t.length > URL_MAX || CONTROL_CHARS.test(t) || /\s/.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '');
  if (!schemes.includes(scheme)) return null;
  if (scheme !== 'mailto' && (!u.hostname || u.username || u.password)) return null;
  return u.toString();
};

/**
 * Validates an input value against a definition and returns its canonical stored JSON (or null to
 * clear). `path` is the pointer reported on error.
 */
export async function normalizeValue(
  def: { type: FieldType; config: FieldConfig; name: string },
  input: unknown,
  path: string,
  b: FieldBounds,
  resolve: RefResolver,
): Promise<unknown> {
  if (input === null || input === undefined || input === '') return null;
  const c = def.config;
  switch (def.type) {
    case 'text': {
      if (typeof input !== 'string') return fail(path, 'invalid', 'Enter text.');
      const v = c.multiline ? input.replace(/\r\n?/g, '\n') : input.trim();
      if (!v) return null;
      if (CONTROL_EXCEPT_NEWLINE.test(v))
        return fail(path, 'invalid', 'Remove control characters.');
      if (!c.multiline && v.includes('\n')) return fail(path, 'invalid', 'Enter a single line.');
      const len = [...v].length;
      const lo = (c.min_length as number | undefined) ?? 0;
      const hi = (c.max_length as number | undefined) ?? b.textMax;
      if (len < lo) return fail(path, 'too_short', `Enter at least ${lo} characters.`);
      if (len > hi) return fail(path, 'too_long', `Enter at most ${hi} characters.`);
      if (typeof c.pattern === 'string' && !pattern(c.pattern, b.patternMax).test(v))
        return fail(path, 'pattern_mismatch', 'This does not match the required format.');
      return v;
    }
    case 'number':
    case 'percentage': {
      const s = typeof input === 'number' && Number.isFinite(input) ? String(input) : input;
      const scale = (c.scale as number | undefined) ?? (def.type === 'number' ? 2 : 0);
      if (typeof s !== 'string' || !/^-?[0-9]{1,18}(\.[0-9]+)?$/.test(s.trim()))
        return fail(path, 'invalid', 'Enter a number.');
      const t = s.trim();
      const frac = t.split('.')[1] ?? '';
      if (frac.replace(/0+$/, '').length > scale)
        return fail(
          path,
          'scale',
          scale === 0 ? 'Enter a whole number.' : `Use at most ${scale} decimal places.`,
        );
      const n = Number(t);
      const lo =
        c.min !== undefined ? Number(c.min) : def.type === 'percentage' ? PERCENT_MIN : undefined;
      const hi =
        c.max !== undefined ? Number(c.max) : def.type === 'percentage' ? PERCENT_MAX : undefined;
      if (lo !== undefined && n < lo) return fail(path, 'too_small', `Enter ${lo} or more.`);
      if (hi !== undefined && n > hi) return fail(path, 'too_large', `Enter ${hi} or less.`);
      const [i, f = ''] = t.replace(/^(-?)0+(?=\d)/, '$1').split('.');
      const ff = f.replace(/0+$/, '');
      const out = ff ? `${i}.${ff}` : i!;
      return out === '-0' ? '0' : out;
    }
    case 'currency': {
      if (!isObj(input)) return fail(path, 'invalid', 'Enter an amount.');
      const code = c.currency as string;
      if (input.currency !== undefined && input.currency !== code)
        return fail(
          path,
          'currency_mismatch',
          `This field is in ${code}; amounts are never converted.`,
        );
      const exp = currencyExponent(code);
      let minor: bigint;
      if (typeof input.minor === 'string' && /^-?[0-9]{1,18}$/.test(input.minor))
        minor = BigInt(input.minor);
      else if (
        typeof input.amount === 'string' &&
        /^-?[0-9]{1,16}(\.[0-9]+)?$/.test(input.amount)
      ) {
        const [i, f = ''] = input.amount.split('.');
        if (f.replace(/0+$/, '').length > exp)
          return fail(path, 'scale', `${code} uses ${exp} decimal places.`);
        const neg = i!.startsWith('-');
        const digits = `${i!.replace('-', '')}${f.padEnd(exp, '0').slice(0, exp)}`;
        minor = BigInt(digits) * (neg ? -1n : 1n);
      } else return fail(path, 'invalid', 'Enter an amount.');
      if (minor > 999_999_999_999_999_999n || minor < -999_999_999_999_999_999n)
        return fail(path, 'too_large', 'The amount is too large.');
      if (c.min_minor !== undefined && minor < BigInt(c.min_minor as string))
        return fail(path, 'too_small', 'The amount is below the minimum.');
      if (c.max_minor !== undefined && minor > BigInt(c.max_minor as string))
        return fail(path, 'too_large', 'The amount is above the maximum.');
      return { minor: minor.toString(), currency: code };
    }
    case 'date': {
      if (typeof input !== 'string' || !validDate(input))
        return fail(path, 'invalid', 'Enter a date.');
      if (c.min_date && input < (c.min_date as string))
        return fail(path, 'too_early', `Choose ${c.min_date as string} or later.`);
      if (c.max_date && input > (c.max_date as string))
        return fail(path, 'too_late', `Choose ${c.max_date as string} or earlier.`);
      return input;
    }
    case 'checkbox':
      if (typeof input !== 'boolean') return fail(path, 'invalid', 'Choose yes or no.');
      return input;
    case 'url': {
      if (typeof input !== 'string') return fail(path, 'invalid', 'Enter a web address.');
      const v = normUrl(input, (c.schemes as string[] | undefined) ?? ['https']);
      if (!v)
        return fail(
          path,
          'invalid',
          `Enter a ${((c.schemes as string[] | undefined) ?? ['https']).join(' or ')} address.`,
        );
      return v;
    }
    case 'email': {
      if (typeof input !== 'string') return fail(path, 'invalid', 'Enter an email address.');
      const v = normEmail(input);
      if (!v) return fail(path, 'invalid', 'Enter an email address.');
      return v;
    }
    case 'person':
    case 'label':
    case 'select': {
      if (typeof input !== 'string' || input.length > 40)
        return fail(path, 'invalid', 'Choose an option.');
      const id = await resolve(def.type, input);
      if (!id)
        return fail(
          path,
          'not_eligible',
          def.type === 'person' ? 'Choose an active member.' : 'Choose an available option.',
        );
      return id;
    }
    case 'formula':
      return fail(path, 'read_only', 'Formula fields are calculated.');
  }
}

/** Whether a stored value counts as present for required-field rules. */
export const hasValue = (v: unknown) => v !== null && v !== undefined && v !== '' && v !== false;
