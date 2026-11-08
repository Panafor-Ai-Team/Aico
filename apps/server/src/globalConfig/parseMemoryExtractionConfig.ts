import { DEFAULT_MINI_PROVIDER } from '@lobechat/business-const';
import { DEFAULT_MINI_MODEL, DEFAULT_USER_MEMORY_EMBEDDING_MODEL_ITEM } from '@lobechat/const';

import {
  type GlobalMemoryExtractionConfig,
  type GlobalMemoryLayer,
  type MemoryAgentPublicConfig,
  type MemoryLayerExtractorPublicConfig,
} from '@/types/serverConfig';

const MEMORY_LAYERS: GlobalMemoryLayer[] = [
  'activity',
  'context',
  'experience',
  'identity',
  'preference',
];

const DEFAULT_WORKFLOW_PROCESS_USER_TOPICS_PARALLELISM = 25;

// NOTICE: Hard per-user, per-run fan-out ceiling. A single user with a large backlog of
// un-extracted topics must never enqueue an unbounded flood of process-topic runs (we have seen a
// single user back up 650k+ QStash messages). flowControl only caps concurrency, not queue depth,
// so this count cap is the actual backlog guard. Remaining topics stay "un-extracted" and are
// picked up by later hourly runs, so the cap self-drains without dropping data.
const DEFAULT_WORKFLOW_MAX_TOPICS_PER_USER_PER_RUN = 100;

const parseTokenLimitEnv = (value?: string) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;

  return Math.floor(parsed);
};

const parsePositiveIntegerEnv = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;

  return parsed;
};

// NOTICE:
// Memory context limit envs reserve only the dynamic context slice that we trim before requests.
// The final provider request still adds system prompts, user prompt wrappers, JSON schemas, tools,
// and response tokens. Configure layer/persona limits to 65%-75% of the provider context window,
// not the hard model maximum. For example, a 272000-token provider limit should use roughly
// 176800-204000 here so wrappers cannot push the final request over the limit.
// TODO: Move these provider-window assumptions to model-bank once it exposes context-window and
// embedding-input-limit capability metadata for each model.

export type MemoryAgentConfig = MemoryAgentPublicConfig & {
  apiKey?: string;
  language?: string;
  model: string;
};

export type MemoryLayerExtractorConfig = MemoryLayerExtractorPublicConfig &
  MemoryAgentConfig & {
    layers: Record<GlobalMemoryLayer, string>;
  };

export type MemoryExtractionRunner = 'local' | 'workflow';

// Aico: QStash may be configured but unusable (e.g. a rejected token), so the env wins over detection.
const parseExtractionRunner = (): MemoryExtractionRunner => {
  const value = process.env.MEMORY_USER_MEMORY_EXTRACTION_RUNNER?.trim().toLowerCase();
  if (value === 'local' || value === 'workflow') return value;

  return process.env.QSTASH_TOKEN ? 'workflow' : 'local';
};

export interface MemoryExtractionPrivateConfig {
  agentBenchmarkLoCoMo: MemoryAgentConfig;
  agentGateKeeper: MemoryAgentConfig;
  agentGateKeeperPreferredModels?: string[];
  agentGateKeeperPreferredProviders?: string[];
  agentLayerExtractor: MemoryLayerExtractorConfig;
  agentLayerExtractorPreferredModels?: string[];
  agentLayerExtractorPreferredProviders?: string[];
  agentPersonaWriter: MemoryAgentConfig;
  concurrency?: number;
  embedding: MemoryAgentConfig;
  embeddingPreferredModels?: string[];
  embeddingPreferredProviders?: string[];
  featureFlags: {
    enableBenchmarkLoCoMo: boolean;
  };
  observabilityS3?: {
    accessKeyId?: string;
    bucketName?: string;
    enabled: boolean;
    endpoint?: string;
    forcePathStyle?: boolean;
    pathPrefix?: string;
    region?: string;
    secretAccessKey?: string;
  };
  /**
   * Where user-initiated chat-topic extraction runs:
   * - `workflow`: Upstash Workflow (needs a working QStash token and a public callback URL)
   * - `local`: inside the app server process
   */
  runner: MemoryExtractionRunner;
  upstashWorkflowExtraHeaders?: Record<string, string>;
  webhook: {
    baseUrl?: string;
    headers?: Record<string, string>;
  };
  whitelistUsers?: string[];
  workflow?: {
    /** Hard cap on topics fanned out per user per run; guards against QStash backlog storms. */
    maxTopicsPerUserPerRun: number;
    /** Maximum active process-user-topics workflow workers across all users. */
    processUserTopicsParallelism: number;
  };
}

const parseGateKeeperAgent = (): MemoryAgentConfig => {
  const apiKey = process.env.MEMORY_USER_MEMORY_GATEKEEPER_API_KEY;
  const baseURL = process.env.MEMORY_USER_MEMORY_GATEKEEPER_BASE_URL;
  const model = process.env.MEMORY_USER_MEMORY_GATEKEEPER_MODEL || DEFAULT_MINI_MODEL;
  const provider = process.env.MEMORY_USER_MEMORY_GATEKEEPER_PROVIDER || DEFAULT_MINI_PROVIDER;
  const language = process.env.MEMORY_USER_MEMORY_GATEKEEPER_LANGUAGE || 'English';

  return {
    apiKey,
    baseURL,
    language,
    model,
    provider,
  };
};

const parseBenchmarkLoCoMoAgent = (fallback: MemoryAgentConfig): MemoryAgentConfig => {
  const model = process.env.MEMORY_USER_MEMORY_BENCHMARK_LOCOMO_AGENT_MODEL || fallback.model;
  const provider =
    process.env.MEMORY_USER_MEMORY_BENCHMARK_LOCOMO_AGENT_PROVIDER ||
    fallback.provider ||
    DEFAULT_MINI_PROVIDER;

  return {
    apiKey: process.env.MEMORY_USER_MEMORY_BENCHMARK_LOCOMO_AGENT_API_KEY ?? fallback.apiKey,
    baseURL: process.env.MEMORY_USER_MEMORY_BENCHMARK_LOCOMO_AGENT_BASE_URL ?? fallback.baseURL,
    language: process.env.MEMORY_USER_MEMORY_BENCHMARK_LOCOMO_AGENT_LANGUAGE ?? fallback.language,
    model,
    provider,
  };
};

const parseLayerExtractorAgent = (fallbackModel: string): MemoryLayerExtractorConfig => {
  const apiKey = process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_API_KEY;
  const baseURL = process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_BASE_URL;
  const model = process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_MODEL || fallbackModel;
  const provider = process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_PROVIDER || DEFAULT_MINI_PROVIDER;
  // Keep this below the model hard limit; see the headroom notice above.
  const contextLimit = parseTokenLimitEnv(
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_CONTEXT_LIMIT,
  );

  const layers = MEMORY_LAYERS.reduce<Record<GlobalMemoryLayer, string>>(
    (acc, layer) => {
      const envKey = `MEMORY_USER_MEMORY_LAYER_EXTRACTOR_${layer.toUpperCase()}_MODEL`;
      const override = (process.env as Record<string, string | undefined>)[envKey];
      acc[layer] = override || model;

      return acc;
    },
    {} as Record<GlobalMemoryLayer, string>,
  );

  return {
    apiKey,
    baseURL,
    contextLimit,
    layers,
    model,
    provider,
  };
};

/**
 * Embeddings default to `DEFAULT_USER_MEMORY_EMBEDDING_MODEL_ITEM` (OpenRouter), not to
 * the layer extractor's provider: the managed chat gateway (CheapVibeCode) serves no
 * embeddings route, so inheriting its provider and chat model made every memory
 * embedding 404. Only the `MEMORY_USER_MEMORY_EMBEDDING_*` env overrides the default.
 */
const parseEmbeddingAgent = (
  credentialSources: { apiKey?: string; provider?: string }[],
): MemoryAgentConfig => {
  const { model: defaultModel, provider: defaultProvider } =
    DEFAULT_USER_MEMORY_EMBEDDING_MODEL_ITEM;
  const model = process.env.MEMORY_USER_MEMORY_EMBEDDING_MODEL || defaultModel;
  const provider =
    process.env.MEMORY_USER_MEMORY_EMBEDDING_PROVIDER || defaultProvider || DEFAULT_MINI_PROVIDER;
  // Reuse another agent's key only when it belongs to the same provider; otherwise a
  // chat-gateway key would be sent to the embedding provider.
  const sharedApiKey = credentialSources.find(
    (source) => source.apiKey && source.provider === provider,
  )?.apiKey;

  return {
    // Embeddings stay on OpenRouter while chat runs on another gateway; its key is
    // a dedicated one (see `initEmbeddingRuntimeFromDB`).
    apiKey:
      process.env.MEMORY_USER_MEMORY_EMBEDDING_API_KEY ??
      sharedApiKey ??
      (provider === 'openrouter' ? process.env.AICO_EMBEDDING_OPENROUTER_API_KEY : undefined),
    baseURL: process.env.MEMORY_USER_MEMORY_EMBEDDING_BASE_URL,
    // Embedding providers often have a smaller per-input limit than chat models.
    // Keep this below the provider's single-input embedding window.
    contextLimit: parseTokenLimitEnv(process.env.MEMORY_USER_MEMORY_EMBEDDING_CONTEXT_LIMIT),
    model,
    provider,
  };
};

const parsePersonaWriterAgent = (
  fallbackModel: string,
  fallbackProvider?: string,
  fallbackApiKey?: string,
): MemoryAgentConfig => {
  const model = process.env.MEMORY_USER_MEMORY_PERSONA_WRITER_MODEL || fallbackModel;
  const provider =
    process.env.MEMORY_USER_MEMORY_PERSONA_WRITER_PROVIDER ||
    fallbackProvider ||
    DEFAULT_MINI_PROVIDER;

  return {
    apiKey: process.env.MEMORY_USER_MEMORY_PERSONA_WRITER_API_KEY ?? fallbackApiKey,
    baseURL: process.env.MEMORY_USER_MEMORY_PERSONA_WRITER_BASE_URL,
    // Keep this below the model hard limit; see the headroom notice above.
    contextLimit: parseTokenLimitEnv(process.env.MEMORY_USER_MEMORY_PERSONA_WRITER_CONTEXT_LIMIT),
    model,
    provider,
  };
};

const parseExtractorAgentObservabilityS3 = () => {
  const accessKeyId = process.env.MEMORY_USER_MEMORY_EXTRACTOR_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.MEMORY_USER_MEMORY_EXTRACTOR_S3_SECRET_ACCESS_KEY;
  const bucketName = process.env.MEMORY_USER_MEMORY_EXTRACTOR_S3_BUCKET_NAME;
  const region = process.env.MEMORY_USER_MEMORY_EXTRACTOR_S3_REGION;
  const endpoint = process.env.MEMORY_USER_MEMORY_EXTRACTOR_S3_ENDPOINT;
  const forcePathStyle = process.env.MEMORY_USER_MEMORY_EXTRACTOR_S3_FORCE_PATH_STYLE === 'true';
  const pathPrefix = process.env.MEMORY_USER_MEMORY_EXTRACTOR_S3_PATH_PREFIX;

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    return {
      enabled: false,
    };
  }

  return {
    accessKeyId,
    bucketName,
    enabled: true,
    endpoint,
    forcePathStyle,
    pathPrefix,
    region,
    secretAccessKey,
  };
};

const sanitizeAgent = (agent?: MemoryAgentConfig): MemoryAgentPublicConfig | undefined => {
  if (!agent) return undefined;
  const sanitized: MemoryAgentConfig = { ...agent };
  delete sanitized.apiKey;

  return sanitized as MemoryAgentPublicConfig;
};

const parsePreferredList = (value?: string) =>
  value
    ?.split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export const parseMemoryExtractionConfig = (): MemoryExtractionPrivateConfig => {
  const agentGateKeeper = parseGateKeeperAgent();
  const agentBenchmarkLoCoMo = parseBenchmarkLoCoMoAgent(agentGateKeeper);
  const agentLayerExtractor = parseLayerExtractorAgent(agentGateKeeper.model);
  const agentPersonaWriter = parsePersonaWriterAgent(agentGateKeeper.model);
  const embedding = parseEmbeddingAgent([agentGateKeeper, agentLayerExtractor]);
  const extractorObservabilityS3 = parseExtractorAgentObservabilityS3();
  const featureFlags = {
    enableBenchmarkLoCoMo: process.env.MEMORY_USER_MEMORY_FEATURE_FLAG_BENCHMARK_LOCOMO === 'true',
  };
  const concurrencyRaw = process.env.MEMORY_USER_MEMORY_CONCURRENCY;
  const concurrency =
    concurrencyRaw !== undefined
      ? Number.isInteger(Number(concurrencyRaw)) && Number(concurrencyRaw) > 0
        ? Number(concurrencyRaw)
        : undefined
      : undefined;
  const processUserTopicsParallelism = parsePositiveIntegerEnv(
    process.env.MEMORY_USER_MEMORY_WORKFLOW_PROCESS_USER_TOPICS_PARALLELISM,
    DEFAULT_WORKFLOW_PROCESS_USER_TOPICS_PARALLELISM,
  );
  const maxTopicsPerUserPerRun = parsePositiveIntegerEnv(
    process.env.MEMORY_USER_MEMORY_WORKFLOW_MAX_TOPICS_PER_USER_PER_RUN,
    DEFAULT_WORKFLOW_MAX_TOPICS_PER_USER_PER_RUN,
  );

  const whitelistUsers = process.env.MEMORY_USER_MEMORY_WHITELIST_USERS?.split(',')
    .filter(Boolean)
    .map((s) => s.trim());

  const webhookHeaders = process.env.MEMORY_USER_MEMORY_WEBHOOK_HEADERS?.split(',')
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, pair) => {
      const [key, value] = pair.split('=').map((s) => s.trim());
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});

  const upstashWorkflowExtraHeaders = process.env.MEMORY_USER_MEMORY_WORKFLOW_EXTRA_HEADERS?.split(
    ',',
  )
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, pair) => {
      const [key, value] = pair.split('=').map((s) => s.trim());
      if (key && value) {
        acc[key] = value;
      }
      return acc;
    }, {});

  const agentGateKeeperPreferredProviders = parsePreferredList(
    process.env.MEMORY_USER_MEMORY_GATEKEEPER_PREFERRED_PROVIDERS,
  );
  const agentGateKeeperPreferredModels = parsePreferredList(
    process.env.MEMORY_USER_MEMORY_GATEKEEPER_PREFERRED_MODELS,
  );
  const embeddingPreferredProviders = parsePreferredList(
    process.env.MEMORY_USER_MEMORY_EMBEDDING_PREFERRED_PROVIDERS,
  );
  const embeddingPreferredModels = parsePreferredList(
    process.env.MEMORY_USER_MEMORY_EMBEDDING_PREFERRED_MODELS,
  );
  const agentLayerExtractorPreferredProviders = parsePreferredList(
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_PREFERRED_PROVIDERS,
  );
  const agentLayerExtractorPreferredModels = parsePreferredList(
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_PREFERRED_MODELS,
  );

  return {
    agentBenchmarkLoCoMo,
    agentGateKeeper,
    agentGateKeeperPreferredModels,
    agentGateKeeperPreferredProviders,
    agentLayerExtractor,
    agentLayerExtractorPreferredModels,
    agentLayerExtractorPreferredProviders,
    agentPersonaWriter,
    concurrency,
    embedding,
    embeddingPreferredModels,
    embeddingPreferredProviders,
    featureFlags,
    observabilityS3: extractorObservabilityS3,
    runner: parseExtractionRunner(),
    upstashWorkflowExtraHeaders,
    webhook: {
      baseUrl: process.env.MEMORY_USER_MEMORY_WEBHOOK_BASE_URL,
      headers: webhookHeaders,
    },
    whitelistUsers,
    workflow: {
      maxTopicsPerUserPerRun,
      processUserTopicsParallelism,
    },
  };
};

export const getPublicMemoryExtractionConfig = (): GlobalMemoryExtractionConfig => {
  const privateConfig = parseMemoryExtractionConfig();

  return {
    agentGateKeeper: sanitizeAgent(privateConfig.agentGateKeeper)!,
    agentLayerExtractor: {
      ...sanitizeAgent(privateConfig.agentLayerExtractor),
      layers: privateConfig.agentLayerExtractor.layers,
    },
    concurrency: privateConfig.concurrency,
    embedding: sanitizeAgent(privateConfig.embedding),
  };
};
