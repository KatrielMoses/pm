/**
 * The versioned AI provider and model registry (ADR-0038 A1, A2). Model identifiers,
 * capabilities, prices, and privacy guarantees are explicit configuration with a version and a
 * source; nothing resolves to an implicit "latest" model and no capability is assumed to carry
 * over between providers. An entry here is not an approval: real-provider dispatch also needs the
 * model key in AI_APPROVED_MODELS (OD-41) and a deployment transport that configuration allows.
 */

export const AI_REGISTRY_VERSION = '2026-10-17';
export const PROMPT_TEMPLATE_VERSION = 'test_run.v1';
export const MESSAGES_PROTOCOL = 'anthropic-messages-2023-06-01' as const;

export type AiProviderId = 'anthropic' | 'fixture';

export interface ModelPrice {
  /** The price table this entry was read from. Snapshotted onto every action. */
  version: string;
  currency: 'USD';
  /** Picodollars (1e-12 USD) per input and output token. */
  inputPicoPerToken: bigint;
  outputPicoPerToken: bigint;
  /**
   * The largest input-token bound this price is valid for. A request whose conservative input
   * bound exceeds it has no supported cost bound and is refused, never priced at a lower tier.
   */
  maxInputTokensAtPrice: number;
  source: string;
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
  /** Usage arrives in the final stream events; an interrupted stream has no usage. */
  usageReporting: 'final_event';
  /**
   * Whether an HTTP error response (4xx/5xx before any stream) can be billed. `false` is the
   * adapter's documented assumption for this provider and is part of the OD-41 review; when it is
   * `unknown`, error responses keep their reservation until reconciled.
   */
  errorResponsesChargeable: false | 'unknown';
  /** 7A sends no tools, files, images, cache writes, or server-side fallbacks. */
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
   * The conservative input-token bound is `bytes / bytesPerToken + overheadTokens +
   * perMessageTokens * messages`. With byte-level tokenization a token never encodes less than one
   * byte, so one token per UTF-8 byte is an upper bound; the overhead covers the request framing.
   */
  bytesPerToken: 1;
  overheadTokens: number;
  perMessageTokens: number;
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
      errorResponsesChargeable: false,
    },
    price: {
      version: 'anthropic-first-party-2026-10-06',
      currency: 'USD',
      // $0.10 and $0.50 per million tokens for prompts up to 100K tokens.
      inputPicoPerToken: 100_000n,
      outputPicoPerToken: 500_000n,
      maxInputTokensAtPrice: 100_000,
      source:
        'Anthropic first-party API price table as cached on 2026-10-06; not a commercial approval',
      synthetic: false,
    },
    privacy: {
      trainingExclusion: 'contract_review_required',
      retention: 'provider_standard',
      zeroRetention: false,
    },
    inputBound: { bytesPerToken: 1, overheadTokens: 64, perMessageTokens: 16 },
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
      errorResponsesChargeable: false,
    },
    price: {
      version: 'synthetic-2026-10-17',
      currency: 'USD',
      // Synthetic prices so budget enforcement is exercised; no money is spent.
      inputPicoPerToken: 1_000_000n,
      outputPicoPerToken: 2_000_000n,
      maxInputTokensAtPrice: 100_000,
      source: 'Synthetic test price; labelled synthetic everywhere it is shown',
      synthetic: true,
    },
    privacy: { trainingExclusion: 'synthetic', retention: 'none_synthetic', zeroRetention: false },
    inputBound: { bytesPerToken: 1, overheadTokens: 64, perMessageTokens: 16 },
    workspaceKeySupported: true,
    synthetic: true,
  },
];

export function modelByKey(key: string | null | undefined): ModelEntry | undefined {
  return key ? MODELS.find((m) => m.key === key) : undefined;
}

/** Models a deployment transport can actually reach (the fixture never offers real models). */
export function modelsForTransport(provider: 'none' | AiProviderId): readonly ModelEntry[] {
  if (provider === 'none') return [];
  return MODELS.filter((m) => m.provider === provider);
}

/** Conservative input-token upper bound for the rendered request. */
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

/** Exact cost of reported usage in picodollars. */
export function usageCostPico(model: ModelEntry, input: number, output: number): bigint {
  return (
    BigInt(input) * model.price.inputPicoPerToken + BigInt(output) * model.price.outputPicoPerToken
  );
}

/** The price snapshot stored with an action (bigints as strings). */
export function priceSnapshot(model: ModelEntry): Record<string, unknown> {
  return {
    version: model.price.version,
    currency: model.price.currency,
    input_pico_per_token: model.price.inputPicoPerToken.toString(),
    output_pico_per_token: model.price.outputPicoPerToken.toString(),
    max_input_tokens_at_price: model.price.maxInputTokensAtPrice,
    synthetic: model.price.synthetic,
  };
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
