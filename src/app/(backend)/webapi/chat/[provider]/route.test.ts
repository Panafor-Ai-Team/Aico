// @vitest-environment node
import { type LobeRuntimeAI } from '@lobechat/model-runtime';
import { ModelRuntime } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/auth';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { POST } from './route';

vi.mock('@/app/(backend)/middleware/auth/utils', () => ({
  checkAuthMethod: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: vi.fn(),
  createTraceOptions: vi.fn().mockReturnValue({}),
}));

vi.mock('@/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

// `vi.mock` factories run at import time, before top-level consts initialise,
// so the spies have to be hoisted alongside them.
const { getUserRemaining, recordUsage, syncMemberCycleUsage } = vi.hoisted(() => ({
  getUserRemaining: vi.fn(),
  recordUsage: vi.fn(),
  syncMemberCycleUsage: vi.fn(),
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn(() => ({ recordUsage })),
}));

vi.mock('@/server/services/openrouter/keyService', () => ({
  AicoOpenRouterKeyService: vi.fn(() => ({ getUserRemaining, syncMemberCycleUsage })),
}));

// Hits the database for the platform multiplier; irrelevant to this route's logic.
vi.mock('@/server/services/aico/usageMultiplier', () => ({
  resolveManagedPricingContext: vi
    .fn()
    .mockResolvedValue({ costMultiplierBp: 10_000, plan: 'aico', scope: 'personal' }),
}));

const ledger = vi.hoisted(() => ({ mode: 'off' as 'enforce' | 'off' | 'shadow' }));

vi.mock('@/server/services/aico/ledger/config', () => ({
  getLedgerConfig: () => ({ mode: ledger.mode }),
}));

const billing = { source: 'personal' as const };

const makeRequest = (body: Record<string, unknown>) =>
  new Request(new URL('https://test.com'), {
    method: 'POST',
    body: JSON.stringify({ aicoBilling: billing, ...body }),
  });

// 模拟请求和响应
let request: Request;
beforeEach(() => {
  request = makeRequest({ model: 'test-model' });

  getUserRemaining.mockResolvedValue({
    remainingMicroUsd: 0,
    usageKnown: true,
    usageMicroUsd: 0,
  });
  syncMemberCycleUsage.mockResolvedValue(undefined);

  // Default: valid session
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {} as any,
    user: { id: 'test-user-id' } as any,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST handler', () => {
  describe('init chat model', () => {
    it('should initialize ModelRuntime correctly with valid session', async () => {
      const mockParams = Promise.resolve({ provider: 'openrouter' });

      const mockChatResponse = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      await POST(request as unknown as Request, { params: mockParams });

      expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        'openrouter',
        undefined,
        { billingContext: billing, modelId: 'test-model' },
      );
    });

    it('rejects direct (BYOK) providers', async () => {
      const mockParams = Promise.resolve({ provider: 'openai' });

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        body: { error: 'DIRECT_PROVIDER_NOT_ALLOWED', provider: 'openai' },
      });
      expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
    });

    it('should return Unauthorized error when no session exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const mockParams = Promise.resolve({ provider: 'openrouter' });

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('chat', () => {
    it('should correctly handle chat completion with valid payload', async () => {
      const mockParams = Promise.resolve({ provider: 'openrouter' });
      const mockChatPayload = { message: 'Hello, world!' };
      request = makeRequest(mockChatPayload);

      const mockChatResponse: any = { success: true, message: 'Reply from agent' };
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const response = await POST(request as unknown as Request, { params: mockParams });

      expect(response).toEqual(mockChatResponse);
      // `aicoBilling` only tells this route who pays. Forwarding it upstream
      // fails strict APIs: OpenAI-style Responses rejects it as an unsupported
      // parameter, which broke every GPT-5.x model behind CheapVibeCode.
      expect(mockRuntime.chat).toHaveBeenCalledWith(mockChatPayload, {
        // Managed traffic uses identity cost multiplier — margin is at top-up (π yield).
        pricingContext: { costMultiplierBp: 10_000, plan: 'aico', scope: 'personal' },
        user: 'test-user-id',
        signal: expect.anything(),
      });
    });

    it('should return an error response when chat completion fails', async () => {
      const mockParams = Promise.resolve({ provider: 'openrouter' });
      const mockChatPayload = { message: 'Hello, world!' };
      request = makeRequest(mockChatPayload);

      const mockErrorResponse = {
        errorType: ChatErrorType.InternalServerError,
        error: { errorMessage: 'Something went wrong', errorType: 500 },
        errorMessage: 'Something went wrong',
      };

      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockRejectedValue(mockErrorResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        body: {
          errorMessage: 'Something went wrong',
          error: {
            errorMessage: 'Something went wrong',
            errorType: 500,
          },
          provider: 'openrouter',
        },
        errorType: 500,
      });
    });
  });

  describe('personal usage settlement', () => {
    it('persists the settled figure after the response, not only on a billing-page visit', async () => {
      const mockParams = Promise.resolve({ provider: 'openrouter' });
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(new Response('ok')),
      };
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      await POST(makeRequest({ model: 'test-model' }), { params: mockParams });
      // recordManagedUsage is fired with `void`; let its microtasks drain.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Without `persist` the wallet only falls when the user opens billing,
      // so spend would look free until then.
      expect(getUserRemaining).toHaveBeenCalledWith('test-user-id', { persist: true });
    });

    it('leaves usage to the hold settle under ledger enforce', async () => {
      ledger.mode = 'enforce';
      try {
        const mockRuntime: LobeRuntimeAI = {
          baseURL: 'abc',
          chat: vi.fn().mockResolvedValue(new Response('ok')),
        };
        vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

        await POST(makeRequest({ model: 'test-model' }), {
          params: Promise.resolve({ provider: 'openrouter' }),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getUserRemaining).not.toHaveBeenCalled();
      } finally {
        ledger.mode = 'off';
      }
    });

    it('logs a placeholder row only while the ledger is off', async () => {
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(new Response('ok')),
      };
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      await POST(makeRequest({ model: 'test-model' }), {
        params: Promise.resolve({ provider: 'openrouter' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(recordUsage).toHaveBeenCalledTimes(1);
    });

    it('keeps settling spend but leaves the priced row to the shadow hold', async () => {
      ledger.mode = 'shadow';
      try {
        const mockRuntime: LobeRuntimeAI = {
          baseURL: 'abc',
          chat: vi.fn().mockResolvedValue(new Response('ok')),
        };
        vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

        await POST(makeRequest({ model: 'test-model' }), {
          params: Promise.resolve({ provider: 'openrouter' }),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Regression: shadow wrote a zero-cost row beside the hold's priced one.
        expect(getUserRemaining).toHaveBeenCalledWith('test-user-id', { persist: true });
        expect(recordUsage).not.toHaveBeenCalled();
      } finally {
        ledger.mode = 'off';
      }
    });
  });
});
