/**
 * The versioned AI provider and model registry (ADR-0038 D1, D2, D5). Model identifiers,
 * capabilities, prices, and privacy guarantees are explicit configuration with a version and a
 * source; nothing resolves to an implicit "latest" model and no capability is assumed to carry
 * over between providers.
 *
 * An entry is not an approval. Real monetary dispatch needs every separate gate (corrective review
 * 01): a price verified against the provider's official table, an evidenced strict input bound for
 * the exact request protocol, the model key in AI_APPROVED_MODELS (OD-41), and a deployment
 * transport and secret store that configuration allows (DQ-28). Each attempt is settled against
 * the immutable snapshot taken when it was authorized, never against this table as it is later.
 */

export const AI_REGISTRY_VERSION = '2026-10-17.2';
export const PROMPT_TEMPLATE_VERSION = 'test_run.v1';
export const MESSAGES_PROTOCOL = 'anthropic-messages-2023-06-01' as const;

export type AiProviderId = 'anthropic' | 'fixture';

/** A gate's evidence: what was checked, where, and when; `unverified` names why not. */
export type Verification =
  | { state: 'verified'; source: string; checkedOn: string; note: string }
  | { state: 'unverified'; source: string; checkedOn: string; reason: string }
  | { state: 'synthetic'; note: string };

export interface ModelPrice {
  /** The price table this entry was read from. Snapshotted onto every action and attempt. */
  version: string;
  currency: 'USD';
  /** Picodollars (1e-12 USD) per input and output token. */
  inputPicoPerToken: bigint;
  outputPicoPerToken: bigint;
  /**
   * The largest input-token bound this price tier covers. A request whose bound exceeds it has no
   * supported cost bound and is refused, never priced at a lower tier.
   */
  maxInputTokensAtPrice: number;
  /** Request features the price assumes absent (each would change the price). */
  restrictions: readonly string[];
  verification: Verification;
  synthetic: boolean;
}

export interface ModelCapabilities {
  streaming: true;
  /** The provider's own output ceiling; requests are bounded far below it by configuration. */
  maxOutputTokens: number;
  /** The provider documents no request idempotency key: an unknown outcome is never resent. */
  providerIdempotency: false;
  /** Cancellation closes the stream; the provider may still bill what it generated. */
  cancellation: 'disconnect_best_effort';
  /** Usage arrives in the stream's start and final events; an interrupted stream has none. */
  usageReporting: 'final_event';
  /**
   * Whether an HTTP error response can be billed. `unknown` keeps every error's reservation until
   * reconciled and never retries it automatically; `false` is allowed only with specific reviewed
   * evidence (or for the synthetic fixture, which charges nothing).
   */
  errorResponsesChargeable: false | 'unknown';
  /** 7A sends no tools, files, images, cache writes, server-side fallbacks, or inference_geo. */
  additionalChargeableUsage: 'none';
}

export interface PrivacyGuarantees {
  /**
   * `contract_review_required`: the provider's published commercial terms describe a training
   * exclusion, but no contract has been reviewed (OD-41); the product claims nothing until it is.
   * `synthetic`: the fixture is a local test server; nothing reaches a provider.
   */
  trainingExclusion: 'contract_review_required' | 'synthetic';
  /** Retention is the provider's standard retention unless a reviewed contract says otherwise. */
  retention: 'provider_standard' | 'none_synthetic';
  /** Never inferred from a flag. */
  zeroRetention: false;
}

export interface InputBound {
  /**
   * The computed bound is `bytes / bytesPerToken + overheadTokens + perMessageTokens * messages`.
   * It is a hard ceiling only where `verification` is `verified` (or `synthetic`, where the
   * fixture's own counting is known to stay below it). An unverified bound refuses real monetary
   * dispatch: it is never presented as a guarantee.
   */
  bytesPerToken: 1;
  overheadTokens: number;
  perMessageTokens: number;
  verification: Verification;
}

export interface ModelEntry {
  key: string;
  provider: AiProviderId;
  protocol: typeof MESSAGES_PROTOCOL;
  modelId: string;
  label: string;
  capabilities: ModelCapabilities;
  price: ModelPrice;
  privacy: PrivacyGuarantees;
  inputBound: InputBound;
  /** Whether a workspace key can be used with this model (still off when deployed, OD-46). */
  workspaceKeySupported: boolean;
  synthetic: boolean;
}

const MESSAGES_CAPABILITIES = {
  streaming: true,
  providerIdempotency: false,
  cancellation: 'disconnect_best_effort',
  usageReporting: 'final_event',
  additionalChargeableUsage: 'none',
} as const;

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const TOKEN_COUNTING_URL = 'https://platform.claude.com/docs/en/build-with-claude/token-counting';
const ERRORS_URL = 'https://platform.claude.com/docs/en/api/errors';

const SYNTHETIC_PRICE = {
  version: 'synthetic-2026-10-17',
  currency: 'USD',
  // Synthetic prices so budget enforcement is exercised; no money is spent.
  inputPicoPerToken: 1_000_000n,
  outputPicoPerToken: 2_000_000n,
  maxInputTokensAtPrice: 100_000,
  restrictions: [],
  verification: { state: 'synthetic', note: 'Synthetic test price; labelled synthetic everywhere' },
  synthetic: true,
} as const satisfies ModelPrice;

export const MODELS: readonly ModelEntry[] = [
  {
    key: 'anthropic/claude-haiku-5-5@2026-10-06',
    provider: 'anthropic',
    protocol: MESSAGES_PROTOCOL,
    modelId: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5 (Anthropic Messages API)',
    capabilities: {
      ...MESSAGES_CAPABILITIES,
      maxOutputTokens: 128_000,
      // The official errors page states no billing rule for error responses (checked 2026-10-17).
      errorResponsesChargeable: 'unknown',
    },
    price: {
      version: 'anthropic-first-party-2026-10-17',
      currency: 'USD',
      // Base input $0.10 and output $0.50 per million tokens for prompts up to 100,000 tokens;
      // longer prompts pay the higher tier and are refused here (no tier substitution).
      inputPicoPerToken: 100_000n,
      outputPicoPerToken: 500_000n,
      maxInputTokensAtPrice: 100_000,
      restrictions: [
        'global routing only (no inference_geo; US-only inference costs 1.1x)',
        'no prompt caching (cache writes and reads are priced separately)',
        'no batch processing, tools, fast mode, images, or documents',
      ],
      verification: {
        state: 'verified',
        source: PRICING_URL,
        checkedOn: '2026-10-17',
        note: 'Model pricing table: "Claude Haiku 5.5 (for prompts up to 100,000 tokens) $0.10 / MTok base input, $0.50 / MTok output". Not a commercial approval.',
      },
      synthetic: false,
    },
    privacy: {
      trainingExclusion: 'contract_review_required',
      retention: 'provider_standard',
      zeroRetention: false,
    },
    inputBound: {
      bytesPerToken: 1,
      overheadTokens: 64,
      perMessageTokens: 16,
      verification: {
        state: 'unverified',
        source: TOKEN_COUNTING_URL,
        checkedOn: '2026-10-17',
        reason:
          'No published strict upper bound on tokens per byte or request framing for this model; the counting endpoint is documented as an estimate that "might differ". Real monetary dispatch stays refused until a bound is evidenced.',
      },
    },
    workspaceKeySupported: true,
    synthetic: false,
  },
  {
    key: 'fixture/synthetic-messages@2026-10-17',
    provider: 'fixture',
    protocol: MESSAGES_PROTOCOL,
    modelId: 'synthetic-messages',
    label: 'Synthetic test model (protocol fixture, no provider)',
    capabilities: {
      ...MESSAGES_CAPABILITIES,
      maxOutputTokens: 8192,
      // The fixture is a local server that charges nothing for an error (proven in tests).
      errorResponsesChargeable: false,
    },
    price: SYNTHETIC_PRICE,
    privacy: { trainingExclusion: 'synthetic', retention: 'none_synthetic', zeroRetention: false },
    inputBound: {
      bytesPerToken: 1,
      overheadTokens: 64,
      perMessageTokens: 16,
      verification: {
        state: 'synthetic',
        note: 'The fixture counts ceil(bytes / 4) + 8 tokens, below this bound (tested).',
      },
    },
    workspaceKeySupported: true,
    synthetic: true,
  },
];

/** The evidence sources the registry cites (recorded in ADR-0038). */
export const REGISTRY_SOURCES = { PRICING_URL, TOKEN_COUNTING_URL, ERRORS_URL } as const;

export function modelByKey(
  key: string | null | undefined,
  models: readonly ModelEntry[] = MODELS,
): ModelEntry | undefined {
  return key ? models.find((m) => m.key === key) : undefined;
}

/** Models a deployment transport can actually reach (the fixture never offers real models). */
export function modelsForTransport(
  provider: 'none' | AiProviderId,
  models: readonly ModelEntry[] = MODELS,
): readonly ModelEntry[] {
  if (provider === 'none') return [];
  return models.filter((m) => m.provider === provider);
}

/** Why a model may not carry real money, independent of approval and secrets; null when it may. */
export function monetaryGate(model: ModelEntry): 'price_unverified' | 'bound_unverified' | null {
  if (model.synthetic) return null;
  if (model.price.verification.state !== 'verified') return 'price_unverified';
  if (model.inputBound.verification.state !== 'verified') return 'bound_unverified';
  return null;
}

/** Computed input-token bound for the rendered request (a hard ceiling only when verified). */
export function inputTokenBound(model: ModelEntry, parts: readonly string[], messages: number) {
  const bytes = parts.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0);
  return (
    Math.ceil(bytes / model.inputBound.bytesPerToken) +
    model.inputBound.overheadTokens +
    model.inputBound.perMessageTokens * messages
  );
}

/** The reservation ceiling in picodollars for one dispatch (input bound and the output maximum). */
export function maxCostPico(model: ModelEntry, inputBound: number, outputBound: number): bigint {
  return (
    BigInt(inputBound) * model.price.inputPicoPerToken +
    BigInt(outputBound) * model.price.outputPicoPerToken
  );
}

/** The price snapshot stored with an action and each attempt (bigints as strings). */
export function priceSnapshot(model: ModelEntry): Record<string, unknown> {
  return {
    model_key: model.key,
    version: model.price.version,
    currency: model.price.currency,
    input_pico_per_token: model.price.inputPicoPerToken.toString(),
    output_pico_per_token: model.price.outputPicoPerToken.toString(),
    max_input_tokens_at_price: model.price.maxInputTokensAtPrice,
    synthetic: model.price.synthetic,
    verification: model.price.verification.state,
  };
}

/** The capability snapshot an attempt is settled against. */
export function capabilitySnapshot(model: ModelEntry): Record<string, unknown> {
  return {
    error_responses_chargeable: model.capabilities.errorResponsesChargeable,
    max_output_tokens: model.capabilities.maxOutputTokens,
    input_bound_verification: model.inputBound.verification.state,
  };
}

/** Stable comparison of two snapshots (key order independent). */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export class UsageValueError extends Error {
  constructor() {
    super('usage is not a finite non-negative safe integer');
    this.name = 'UsageValueError';
  }
}

/** A token count fit for exact arithmetic: a finite, non-negative safe integer. */
export function validTokens(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Exact cost of usage against an immutable price snapshot (never the current table). Unknown or
 * malformed prices and invalid usage throw instead of producing a number.
 */
export function snapshotCostPico(snapshot: unknown, input: number, output: number): bigint {
  if (!validTokens(input) || !validTokens(output)) throw new UsageValueError();
  const s = (snapshot ?? {}) as Record<string, unknown>;
  const price = (v: unknown) => {
    if (typeof v !== 'string' || !/^\d{1,18}$/.test(v)) throw new Error('invalid price snapshot');
    return BigInt(v);
  };
  return (
    BigInt(input) * price(s.input_pico_per_token) + BigInt(output) * price(s.output_pico_per_token)
  );
}

export function privacySnapshot(
  model: ModelEntry,
  approved: boolean,
  maxDataClass: string,
): Record<string, unknown> {
  return {
    training_exclusion: model.privacy.trainingExclusion,
    retention: model.privacy.retention,
    zero_retention: model.privacy.zeroRetention,
    approved_for_customer_data: approved,
    max_data_class: maxDataClass,
  };
}
