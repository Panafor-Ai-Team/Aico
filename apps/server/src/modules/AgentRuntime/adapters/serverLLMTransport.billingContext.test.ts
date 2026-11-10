// @vitest-environment node
import { toLiveManagedModelId } from '@lobechat/business-const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerLLMTransport } from './ServerLLMTransport';

const mocks = vi.hoisted(() => ({
  getUserWallet: vi.fn(),
  initModelRuntimeFromDB: vi.fn(),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initModelRuntimeFromDB: mocks.initModelRuntimeFromDB,
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: class {
    getUserWallet = mocks.getUserWallet;
  },
}));

const serverDB = { tag: 'db' } as any;

const makeCtx = () =>
  ({
    operationId: 'op-1',
    serverDB,
    stepIndex: 0,
    stream: true,
    streamManager: { publishStreamChunk: vi.fn().mockResolvedValue(undefined) },
    userId: 'user-1',
    workspaceId: 'ws-1',
  }) as any;

const makeInput = (overrides: Record<string, unknown> = {}) =>
  ({
    attempt: 1,
    context: {
      messages: [{ content: 'hello', role: 'user' }],
      resolvedTools: { executorMap: {}, promptManifestMap: {}, sourceMap: {}, tools: [] },
    },
    events: [],
    maxAttempts: 6,
    model: 'openai/gpt-test',
    provider: 'openrouter',
    state: { metadata: {} },
    ...overrides,
  }) as any;

/** Runs `runAttempt` without streaming: only the runtime lookup is under test. */
const runAttempt = async (transport: ServerLLMTransport, input = makeInput()) => {
  vi.spyOn(transport as any, 'runAttemptWithRuntime').mockResolvedValue({ ok: true });
  await transport.runAttempt(input);
};

beforeEach(() => {
  mocks.getUserWallet.mockReset().mockResolvedValue(null);
  mocks.initModelRuntimeFromDB.mockReset().mockResolvedValue({ chat: vi.fn() });
});

describe('ServerLLMTransport billing context (Aico managed providers)', () => {
  // Bug: server-run agents (task runs, scheduled ticks) built the managed runtime
  // without a billing context, so every model call failed with
  // BILLING_CONTEXT_REQUIRED and no scheduled task could ever produce a reply.

  it('bills a managed call to the personal wallet by default and names the model', async () => {
    await runAttempt(new ServerLLMTransport(makeCtx()));

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      serverDB,
      'user-1',
      'openrouter',
      'ws-1',
      {
        billingContext: { source: 'personal' },
        modelId: toLiveManagedModelId('openai/gpt-test'),
      },
    );
  });

  it("uses the user's preferred organization budget", async () => {
    mocks.getUserWallet.mockResolvedValue({
      preferredBillingSource: 'organization',
      preferredOrganizationId: 'org-1',
    });

    await runAttempt(new ServerLLMTransport(makeCtx()));

    expect(mocks.initModelRuntimeFromDB.mock.calls[0][4]).toMatchObject({
      billingContext: { organizationId: 'org-1', source: 'organization' },
    });
  });

  it('bills the stream path (context compression, summaries) the same way', async () => {
    const chat = vi.fn().mockResolvedValue(new Response(''));
    mocks.initModelRuntimeFromDB.mockResolvedValue({ chat });
    const transport = new ServerLLMTransport(makeCtx());

    await transport
      .stream({ messages: [], model: 'openai/gpt-test', provider: 'openrouter' })
      .catch(() => undefined);

    expect(mocks.initModelRuntimeFromDB.mock.calls[0][4]).toEqual({
      billingContext: { source: 'personal' },
      modelId: toLiveManagedModelId('openai/gpt-test'),
    });
  });

  it('leaves a non-managed (BYOK) provider without a billing context', async () => {
    await runAttempt(new ServerLLMTransport(makeCtx()), makeInput({ provider: 'my-byok' }));

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledWith(
      serverDB,
      'user-1',
      'my-byok',
      'ws-1',
    );
    expect(mocks.getUserWallet).not.toHaveBeenCalled();
  });

  it('builds one runtime per model and looks the wallet up once', async () => {
    const transport = new ServerLLMTransport(makeCtx());

    await runAttempt(transport);
    await runAttempt(transport);
    await runAttempt(transport, makeInput({ model: 'openai/gpt-other' }));

    expect(mocks.initModelRuntimeFromDB).toHaveBeenCalledTimes(2);
    expect(mocks.initModelRuntimeFromDB.mock.calls.map((c) => c[4].modelId)).toEqual([
      toLiveManagedModelId('openai/gpt-test'),
      toLiveManagedModelId('openai/gpt-other'),
    ]);
    expect(mocks.getUserWallet).toHaveBeenCalledTimes(1);
  });
});
