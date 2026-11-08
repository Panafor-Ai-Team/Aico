import { DEFAULT_EMBEDDING_MODEL } from '@lobechat/const';
import { afterEach, describe, expect, it } from 'vitest';

import { parseMemoryExtractionConfig } from './parseMemoryExtractionConfig';

const WORKFLOW_PARALLELISM_ENV = 'MEMORY_USER_MEMORY_WORKFLOW_PROCESS_USER_TOPICS_PARALLELISM';

const originalWorkflowParallelism = process.env[WORKFLOW_PARALLELISM_ENV];

describe('parseMemoryExtractionConfig', () => {
  afterEach(() => {
    if (originalWorkflowParallelism === undefined) {
      delete process.env[WORKFLOW_PARALLELISM_ENV];
      return;
    }

    process.env[WORKFLOW_PARALLELISM_ENV] = originalWorkflowParallelism;
  });

  it('defaults process-user-topics workflow parallelism to 25', () => {
    delete process.env[WORKFLOW_PARALLELISM_ENV];

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(25);
  });

  it('parses process-user-topics workflow parallelism from env', () => {
    process.env[WORKFLOW_PARALLELISM_ENV] = '17';

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(17);
  });

  it('falls back to 25 when process-user-topics workflow parallelism env is invalid', () => {
    process.env[WORKFLOW_PARALLELISM_ENV] = '0';

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(25);

    process.env[WORKFLOW_PARALLELISM_ENV] = 'abc';

    expect(parseMemoryExtractionConfig().workflow?.processUserTopicsParallelism).toBe(25);
  });
});

describe('parseMemoryExtractionConfig runner', () => {
  const originalRunner = process.env.MEMORY_USER_MEMORY_EXTRACTION_RUNNER;
  const originalQstashToken = process.env.QSTASH_TOKEN;

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    restore('MEMORY_USER_MEMORY_EXTRACTION_RUNNER', originalRunner);
    restore('QSTASH_TOKEN', originalQstashToken);
  });

  it('runs locally when QStash is not configured', () => {
    delete process.env.MEMORY_USER_MEMORY_EXTRACTION_RUNNER;
    delete process.env.QSTASH_TOKEN;

    expect(parseMemoryExtractionConfig().runner).toBe('local');
  });

  it('uses the workflow when a QStash token is set', () => {
    delete process.env.MEMORY_USER_MEMORY_EXTRACTION_RUNNER;
    process.env.QSTASH_TOKEN = 'token';

    expect(parseMemoryExtractionConfig().runner).toBe('workflow');
  });

  it('lets the env force local even with a QStash token set', () => {
    process.env.MEMORY_USER_MEMORY_EXTRACTION_RUNNER = 'local';
    process.env.QSTASH_TOKEN = 'rejected-token';

    expect(parseMemoryExtractionConfig().runner).toBe('local');
  });
});

describe('parseMemoryExtractionConfig embedding agent', () => {
  const KEYS = [
    'AICO_EMBEDDING_OPENROUTER_API_KEY',
    'MEMORY_USER_MEMORY_EMBEDDING_API_KEY',
    'MEMORY_USER_MEMORY_EMBEDDING_MODEL',
    'MEMORY_USER_MEMORY_EMBEDDING_PROVIDER',
    'MEMORY_USER_MEMORY_GATEKEEPER_API_KEY',
    'MEMORY_USER_MEMORY_LAYER_EXTRACTOR_API_KEY',
    'MEMORY_USER_MEMORY_LAYER_EXTRACTOR_MODEL',
    'MEMORY_USER_MEMORY_LAYER_EXTRACTOR_PROVIDER',
  ] as const;
  const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  const useChatGatewayExtractor = () => {
    for (const key of KEYS) delete process.env[key];
    // The chat gateway (CheapVibeCode) serves no embeddings route.
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_PROVIDER = 'cheapvibecode';
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_MODEL = 'glm-5.3-flash';
  };

  it('keeps embeddings on the embedding default instead of the layer extractor provider', () => {
    useChatGatewayExtractor();
    process.env.AICO_EMBEDDING_OPENROUTER_API_KEY = 'embedding-key';

    const { embedding } = parseMemoryExtractionConfig();

    expect(embedding.provider).toBe('openrouter');
    expect(embedding.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(embedding.apiKey).toBe('embedding-key');
  });

  it('does not send the layer extractor key to a different embedding provider', () => {
    useChatGatewayExtractor();
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_API_KEY = 'gateway-key';
    process.env.AICO_EMBEDDING_OPENROUTER_API_KEY = 'embedding-key';

    expect(parseMemoryExtractionConfig().embedding.apiKey).toBe('embedding-key');
  });

  it('lets the embedding env override provider and model', () => {
    useChatGatewayExtractor();
    process.env.MEMORY_USER_MEMORY_EMBEDDING_PROVIDER = 'openai';
    process.env.MEMORY_USER_MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_PROVIDER = 'openai';
    process.env.MEMORY_USER_MEMORY_LAYER_EXTRACTOR_API_KEY = 'openai-key';

    const { embedding } = parseMemoryExtractionConfig();

    expect(embedding.provider).toBe('openai');
    expect(embedding.model).toBe('text-embedding-3-small');
    // Same provider as the layer extractor, so its key is reused.
    expect(embedding.apiKey).toBe('openai-key');
  });
});
