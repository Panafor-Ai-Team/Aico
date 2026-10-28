import { describe, expect, it } from 'vitest';

import {
  classifyLLMError,
  createLLMErrorClassifier,
  type LLMErrorCodeSpecLike,
} from './llmErrorClassifier';

const specsByCode: Record<string, LLMErrorCodeSpecLike> = {
  AgentRuntimeError: { code: 'AgentRuntimeError', retryable: false },
  ExceededToolLimit: { code: 'ExceededToolLimit', retryable: false },
  InvalidProviderAPIKey: { code: 'InvalidProviderAPIKey', retryable: false },
  RateLimitExceeded: { code: 'RateLimitExceeded', retryable: true },
};

const classifyWithSpecs = createLLMErrorClassifier({
  errorCodeSpecs: Object.values(specsByCode),
  getErrorCodeSpec: (code) =>
    code === 'QuotaLimitReached' ? specsByCode.RateLimitExceeded : specsByCode[code],
});

describe('llmErrorClassifier', () => {
  it('classifies error types from an injected spec table', () => {
    expect(
      classifyWithSpecs({ errorType: 'RateLimitExceeded', message: 'tokens per minute' }).kind,
    ).toBe('retry');
    expect(
      classifyWithSpecs({ errorType: 'ExceededToolLimit', message: 'tools exceeded' }).kind,
    ).toBe('stop');
    expect(
      classifyWithSpecs({ errorType: 'InvalidProviderAPIKey', message: 'key rejected' }).kind,
    ).toBe('stop');
  });

  it('resolves deprecated aliases through the injected spec lookup', () => {
    expect(
      classifyWithSpecs({ errorType: 'QuotaLimitReached', message: 'legacy rate limit' }).kind,
    ).toBe('retry');
  });

  it('keeps runtime retry overrides ahead of non-retryable specs', () => {
    expect(
      classifyWithSpecs({ errorType: 'AgentRuntimeError', message: 'fallback runtime error' }).kind,
    ).toBe('retry');
  });

  it('stops ProviderBizError invalid request shapes but retries transient ones', () => {
    expect(
      classifyWithSpecs({
        error: {
          error: {
            message: 'tools.0.custom.input_schema: Field required',
            type: 'invalid_request_error',
          },
          errorType: 'ProviderBizError',
        },
        errorType: 'ProviderBizError',
      }).kind,
    ).toBe('stop');

    expect(
      classifyWithSpecs({
        error: { message: '429 rate limit exceeded' },
        errorType: 'ProviderBizError',
      }).kind,
    ).toBe('retry');
  });

  it('falls back to numeric status and keyword classification without injected specs', () => {
    expect(classifyLLMError({ code: 401, message: 'upstream refused' }).kind).toBe('stop');
    expect(classifyLLMError({ code: 429, message: 'upstream refused' }).kind).toBe('retry');
    expect(classifyLLMError(new Error('unexpected upstream issue')).kind).toBe('retry');
  });

  it('stops on 413 because resending the same body cannot succeed', () => {
    expect(classifyLLMError({ code: 413, message: 'Request Entity Too Large' }).kind).toBe('stop');
    expect(classifyLLMError({ message: 'upstream said 413' }).kind).toBe('stop');
  });

  it("reads the chat route's numeric error type as an HTTP status", () => {
    // fetch-sse keeps the route's `errorType` as `type`; the message is translated UI text.
    expect(classifyLLMError({ message: 'translated text', type: 400 }).kind).toBe('stop');
    expect(classifyLLMError({ message: 'translated text', type: 403 }).kind).toBe('stop');
    expect(classifyLLMError({ message: 'translated text', type: 404 }).kind).toBe('stop');
    expect(classifyLLMError({ message: 'translated text', type: 429 }).kind).toBe('retry');
    expect(classifyLLMError({ message: 'translated text', type: 500 }).kind).toBe('retry');
    expect(classifyLLMError({ errorType: 400, message: 'MODEL_DISABLED:x' }).kind).toBe('stop');
  });

  it('still retries the chat start timeout (the budget caps it, not the classifier)', () => {
    expect(classifyLLMError(new Error('Chat start timed out: upstream-headers')).kind).toBe(
      'retry',
    );
  });

  it('preserves a valid result when provider error shapes contain non-string fields', () => {
    expect(
      classifyWithSpecs({ errorType: { nested: 'structured' }, message: 'structured type' }),
    ).toEqual({
      kind: 'retry',
      message: 'structured type',
    });

    expect(
      classifyWithSpecs({
        error: { error: { code: 401, message: 'proxy refused upstream' } },
      }).kind,
    ).toBe('stop');
  });
});
