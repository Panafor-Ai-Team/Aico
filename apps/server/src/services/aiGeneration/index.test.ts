// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as ModelRuntimeModule from '@/server/modules/ModelRuntime';

import { AiGenerationService } from './index';

const getUserWallet = vi.hoisted(() => vi.fn());
vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn().mockImplementation(() => ({ getUserWallet })),
}));

describe('AiGenerationService.generateObject', () => {
  const generateObject = vi.fn();
  const initSpy = vi.spyOn(ModelRuntimeModule, 'initModelRuntimeFromDB');

  beforeEach(() => {
    generateObject.mockReset();
    initSpy.mockReset();
    initSpy.mockResolvedValue({ generateObject } as any);
  });

  it('initialises the runtime from DB with the caller-supplied provider', async () => {
    generateObject.mockResolvedValue({ ok: true });
    const ai = new AiGenerationService({} as any, 'user-1');
    await ai.generateObject({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'gpt-4o',
      provider: 'openai',
    });
    expect(initSpy).toHaveBeenCalledWith({}, 'user-1', 'openai', undefined);
  });

  // A managed provider refuses a call without these (BILLING_CONTEXT_REQUIRED / MODEL_ID_REQUIRED).
  it('bills a managed provider with the user preferred source and the model id', async () => {
    generateObject.mockResolvedValue({ ok: true });
    getUserWallet.mockResolvedValue(null);
    const ai = new AiGenerationService({} as any, 'user-1', 'ws-1');
    await ai.generateObject({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'synthetic/managed-model',
      provider: 'aico',
    });
    expect(initSpy).toHaveBeenCalledWith({}, 'user-1', 'aico', 'ws-1', {
      billingContext: { source: 'personal' },
      modelId: 'synthetic/managed-model',
    });
    expect(generateObject.mock.calls[0][0].model).toBe('synthetic/managed-model');
  });

  it('forwards messages / model / schema / tools / thinking verbatim to the runtime', async () => {
    generateObject.mockResolvedValue({ name: 'Atlas' });
    const schema = {
      name: 'Person',
      schema: {
        properties: { name: { type: 'string' } },
        required: ['name'],
        type: 'object' as const,
      },
    };

    const ai = new AiGenerationService({} as any, 'user-1');
    await ai.generateObject({
      messages: [{ content: 'pick a name', role: 'user' }],
      model: 'gpt-4o',
      provider: 'openai',
      schema,
      thinking: { type: 'disabled' },
    });

    const [payload] = generateObject.mock.calls[0];
    expect(payload).toEqual({
      messages: [{ content: 'pick a name', role: 'user' }],
      model: 'gpt-4o',
      schema,
      thinking: { type: 'disabled' },
      tools: undefined,
    });
  });

  it('forwards both options.metadata and options.tracing through to ModelRuntime.generateObject', async () => {
    generateObject.mockResolvedValue({});
    const ai = new AiGenerationService({} as any, 'user-1');
    await ai.generateObject(
      {
        messages: [],
        model: 'gpt-4o',
        provider: 'openai',
      },
      {
        metadata: { trigger: 'chat' },
        tracing: {
          promptVersion: 'v1.0',
          scenario: 'input_completion',
        },
      },
    );
    const [, options] = generateObject.mock.calls[0];
    expect(options).toMatchObject({
      metadata: { trigger: 'chat' },
      tracing: {
        promptVersion: 'v1.0',
        scenario: 'input_completion',
      },
    });
  });

  it('returns the runtime result with the typed cast applied', async () => {
    generateObject.mockResolvedValue({ completion: 'hello world' });
    const ai = new AiGenerationService({} as any, 'user-1');
    const result = await ai.generateObject<{ completion: string }>({
      messages: [],
      model: 'gpt-4o',
      provider: 'openai',
    });
    expect(result.completion).toBe('hello world');
  });
});
