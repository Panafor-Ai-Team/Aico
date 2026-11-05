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
