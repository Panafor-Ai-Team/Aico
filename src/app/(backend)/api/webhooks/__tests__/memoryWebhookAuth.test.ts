import { beforeEach, describe, expect, it, vi } from 'vitest';

// The memory webhooks act on any `userId` in the request body, so they must reject every
// request unless the server has auth headers configured, and reject wrong headers when it does.

const mocks = vi.hoisted(() => ({
  config: { webhook: { headers: {} as Record<string, string> } },
  getServerDB: vi.fn(),
  memoryExtractionExecutorCreate: vi.fn(),
  triggerPersonaUpdate: vi.fn(),
  triggerProcessUsers: vi.fn(),
  upsertSource: vi.fn(),
}));

vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () => mocks.config,
}));

vi.mock('@/server/services/memory/userMemory/extract', () => ({
  buildWorkflowPayloadInput: vi.fn((params) => params),
  MemoryExtractionExecutor: { create: mocks.memoryExtractionExecutorCreate },
  memoryExtractionPayloadSchema: { parse: vi.fn((payload) => payload) },
  MemoryExtractionWorkflowService: {
    triggerPersonaUpdate: mocks.triggerPersonaUpdate,
    triggerProcessUsers: mocks.triggerProcessUsers,
  },
  normalizeMemoryExtractionPayload: vi.fn(() => ({ mode: 'workflow' })),
}));

vi.mock('@/server/services/memory/userMemory/persona/service', () => ({
  buildUserPersonaJobInput: vi.fn(),
  UserPersonaService: vi.fn(),
}));

vi.mock('@/database/models/userMemory/sources/benchmarkLoCoMo', () => ({
  UserMemorySourceBenchmarkLoCoMoModel: vi.fn().mockImplementation(() => ({
    replaceParts: vi.fn(),
    upsertSource: mocks.upsertSource,
  })),
}));

vi.mock('@lobechat/memory-user-memory', () => ({
  BenchmarkLocomoContextProvider: vi.fn(),
}));

vi.mock('@/database/server', () => ({ getServerDB: mocks.getServerDB }));

vi.mock('@upstash/workflow', () => ({ Client: vi.fn() }));

const routes = [
  {
    body: { userIds: ['user-1'] },
    load: () => import('../memory-extraction/route'),
    path: '/api/webhooks/memory-extraction',
  },
  {
    body: { sampleId: 'conv-1', sessions: [], userId: 'user-1' },
    load: () => import('../memory-extraction/benchmark-locomo/route'),
    path: '/api/webhooks/memory-extraction/benchmark-locomo',
  },
  {
    body: { userIds: ['user-1'] },
    load: () => import('../memory-user-memory/persona/update-writing/route'),
    path: '/api/webhooks/memory-user-memory/persona/update-writing',
  },
  {
    body: { taskId: '00000000-0000-4000-8000-000000000001' },
    load: () => import('../memory-user-memory/pipelines/extract/chat-topic/cancel/route'),
    path: '/api/webhooks/memory-user-memory/pipelines/extract/chat-topic/cancel',
  },
];

const createRequest = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://app.example.com${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });

const expectNoWorkStarted = () => {
  expect(mocks.triggerProcessUsers).not.toHaveBeenCalled();
  expect(mocks.triggerPersonaUpdate).not.toHaveBeenCalled();
  expect(mocks.memoryExtractionExecutorCreate).not.toHaveBeenCalled();
  expect(mocks.upsertSource).not.toHaveBeenCalled();
  expect(mocks.getServerDB).not.toHaveBeenCalled();
};

describe.each(routes)('memory webhook auth: $path', ({ body, load, path }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.webhook.headers = {};
    mocks.triggerProcessUsers.mockResolvedValue({ workflowRunId: 'run-1' });
    mocks.triggerPersonaUpdate.mockResolvedValue({ workflowRunId: 'run-1' });
  });

  it('rejects every request with 503 when no auth headers are configured', async () => {
    const { POST } = await load();

    const response = await POST(createRequest(path, body));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        'Memory webhook authentication is not configured. Set MEMORY_USER_MEMORY_WEBHOOK_HEADERS.',
    });
    expectNoWorkStarted();
  });

  it('rejects a request whose auth header is missing or wrong with 403', async () => {
    mocks.config.webhook.headers = { 'x-memory-secret': 'secret' };
    const { POST } = await load();

    const missing = await POST(createRequest(path, body));
    const wrong = await POST(createRequest(path, body, { 'x-memory-secret': 'not-the-secret' }));

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({
      error: "Unauthorized: Missing or invalid header 'x-memory-secret'",
    });
    expectNoWorkStarted();
  });
});
