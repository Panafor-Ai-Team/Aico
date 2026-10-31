import { inspect } from 'node:util';

import type * as LobeConst from '@lobechat/const';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCPClient, type MCPClientParams } from '@/libs/mcp';

import { MCPService } from './index';

const environment = vi.hoisted(() => ({ isDesktop: false }));
const debugLog = vi.hoisted(() => vi.fn());

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<typeof LobeConst>()),
  get isDesktop() {
    return environment.isDesktop;
  },
}));

vi.mock('debug', () => ({ default: () => debugLog }));

// Mock 依赖
vi.mock('@/libs/mcp');

const sensitiveHttpParams = {
  auth: {
    accessToken: 'oauth-access-token-secret',
    clientSecret: 'oauth-client-secret',
    refreshToken: 'oauth-refresh-token-secret',
    token: 'bearer-token-secret',
    type: 'oauth2' as const,
  },
  headers: {
    'Authorization': 'Bearer authorization-header-secret',
    'Cookie': 'session=cookie-header-secret',
    'X-Api-Key': 'custom-header-secret',
  },
  metadata: {
    nested: {
      auth: { token: 'nested-auth-secret' },
      env: { PRIVATE_KEY: 'nested-env-secret' },
      headers: { Cookie: 'nested-cookie-secret' },
    },
  },
  name: 'remote-connector',
  type: 'http' as const,
  url: 'https://url-user:url-password@mcp.example.com/path-token-secret?api_key=url-query-secret#fragment-secret',
} as unknown as MCPClientParams;

const sensitiveValues = [
  'oauth-access-token-secret',
  'oauth-client-secret',
  'oauth-refresh-token-secret',
  'bearer-token-secret',
  'authorization-header-secret',
  'cookie-header-secret',
  'custom-header-secret',
  'nested-auth-secret',
  'nested-env-secret',
  'nested-cookie-secret',
  'url-user',
  'url-password',
  'path-token-secret',
  'url-query-secret',
  'fragment-secret',
  'remote-generated-secret',
];

const expectLogsToBeRedacted = (logOutput: string) => {
  for (const sensitiveValue of sensitiveValues) {
    expect(logOutput).not.toContain(sensitiveValue);
  }
};

describe('MCPService transport boundary', () => {
  const stdioParams = {
    args: ['serve'],
    command: 'local-mcp',
    name: 'local-connector',
    type: 'stdio' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    environment.isDesktop = false;
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '');
    vi.mocked(MCPClient.prototype.listTools).mockResolvedValue([]);
    vi.mocked(MCPClient.prototype.callTool).mockResolvedValue({ content: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    environment.isDesktop = false;
  });

  it('rejects connector tool sync on the web before initializing a stdio client', async () => {
    await expect(new MCPService().listRawTools(stdioParams)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Stdio MCP type is not supported in web environment.',
    });
    expect(MCPClient).not.toHaveBeenCalled();
  });

  it('rejects server-side stdio tool execution without initializing a client', async () => {
    await expect(
      new MCPService().callTool({
        argsStr: '{}',
        clientParams: stdioParams,
        toolName: 'read_file',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(MCPClient).not.toHaveBeenCalled();
  });

  it('rejects stdio on the web even when a client for the same params is cached', async () => {
    environment.isDesktop = true;
    const service = new MCPService();
    await service.listRawTools(stdioParams);
    expect(MCPClient).toHaveBeenCalledOnce();

    environment.isDesktop = false;
    await expect(service.listRawTools(stdioParams)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(MCPClient.prototype.listTools).toHaveBeenCalledOnce();
  });

  it('keeps stdio available on Desktop', async () => {
    environment.isDesktop = true;

    await expect(new MCPService().listRawTools(stdioParams)).resolves.toEqual([]);
    expect(MCPClient.prototype.initialize).toHaveBeenCalledOnce();
  });

  it('keeps public HTTP MCP available on the web', async () => {
    await expect(
      new MCPService().listRawTools({
        name: 'remote-connector',
        type: 'http',
        url: 'https://mcp.example.com',
      }),
    ).resolves.toEqual([]);
    expect(MCPClient.prototype.initialize).toHaveBeenCalledOnce();
  });

  it.each(['http://localhost:3020/mcp', 'http://127.0.0.1:8080', 'http://10.0.0.5/mcp'])(
    'rejects the private-network HTTP endpoint %s on the web',
    async (url) => {
      await expect(
        new MCPService().callTool({
          argsStr: '{}',
          clientParams: { name: 'lan', type: 'http', url },
          toolName: 'read',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(MCPClient).not.toHaveBeenCalled();
    },
  );

  it('allows private-network HTTP endpoints when the SSRF allow switch is set', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '1');

    await expect(
      new MCPService().listRawTools({ name: 'lan', type: 'http', url: 'http://10.0.0.5/mcp' }),
    ).resolves.toEqual([]);
  });

  it('allows private-network HTTP endpoints on Desktop', async () => {
    environment.isDesktop = true;

    await expect(
      new MCPService().listRawTools({ name: 'lan', type: 'http', url: 'http://localhost:3000' }),
    ).resolves.toEqual([]);
  });

  it('never runs installation dependency checks on the web', async () => {
    const result = await new MCPService().checkMcpInstall({
      deploymentOptions: [{ installationMethod: 'npm' } as any],
    });

    expect(result.success).toBe(false);
  });
});

describe('MCPService log redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environment.isDesktop = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      invoke: (service: MCPService) => service.listTools(sensitiveHttpParams),
      operationName: 'listing tools',
    },
    {
      invoke: (service: MCPService) => service.listResources(sensitiveHttpParams),
      operationName: 'listing resources',
    },
    {
      invoke: (service: MCPService) => service.listPrompts(sensitiveHttpParams),
      operationName: 'listing prompts',
    },
    {
      invoke: (service: MCPService) =>
        service.callTool({
          argsStr: '{}',
          clientParams: sensitiveHttpParams,
          toolName: 'read_records',
        }),
      operationName: 'calling tool "read_records"',
    },
  ])('redacts credentials when $operationName fails', async ({ invoke, operationName }) => {
    const service = new MCPService();
    const failure = new Error('Connection failed with remote-generated-secret');
    const mockClient = {
      callTool: vi.fn().mockRejectedValue(failure),
      listPrompts: vi.fn().mockRejectedValue(failure),
      listResources: vi.fn().mockRejectedValue(failure),
      listTools: vi.fn().mockRejectedValue(failure),
    };
    vi.spyOn(service as any, 'getClient').mockResolvedValue(mockClient);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(invoke(service)).rejects.toThrow(TRPCError);

    const logOutput = inspect([debugLog.mock.calls, consoleError.mock.calls], { depth: null });
    expectLogsToBeRedacted(logOutput);
    expect(logOutput).toContain(operationName);
    expect(logOutput).toContain('https://mcp.example.com');
    expect(logOutput).toContain("type: 'http'");
  });

  it('redacts credentials from client initialization failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(MCPClient.prototype.initialize).mockRejectedValueOnce(
      new Error('Initialization failed with remote-generated-secret'),
    );

    await expect(new MCPService().listRawTools(sensitiveHttpParams)).rejects.toThrow(TRPCError);

    const logOutput = inspect([debugLog.mock.calls, consoleError.mock.calls], { depth: null });
    expectLogsToBeRedacted(logOutput);
    expect(logOutput).toContain('https://mcp.example.com');
    expect(logOutput).toContain("name: 'Error'");
  });

  it('redacts stdio environment variables from failed Desktop operations', async () => {
    // On the web a stdio config is refused before anything is logged (transport boundary
    // tests above); on Desktop a failing stdio server must still never log its env.
    environment.isDesktop = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(MCPClient.prototype.initialize).mockRejectedValueOnce(new Error('spawn failed'));

    await expect(
      new MCPService().listRawTools({
        args: ['serve'],
        command: 'local-mcp',
        env: { PRIVATE_KEY: 'stdio-env-secret' },
        name: 'local-connector',
        type: 'stdio',
      }),
    ).rejects.toThrow(TRPCError);

    const logOutput = inspect([debugLog.mock.calls, consoleError.mock.calls], { depth: null });
    expect(logOutput).not.toContain('stdio-env-secret');
    expect(logOutput).toContain("type: 'stdio'");
  });

  it('does not log tool argument or result values', async () => {
    const service = new MCPService();
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ text: 'tool-result-secret', type: 'text' }],
      }),
    };
    vi.spyOn(service as any, 'getClient').mockResolvedValue(mockClient);

    await service.callTool({
      argsStr: JSON.stringify({ apiKey: 'tool-argument-secret' }),
      clientParams: sensitiveHttpParams,
      toolName: 'read_records',
    });

    const logOutput = inspect(debugLog.mock.calls, { depth: null });
    expect(logOutput).not.toContain('tool-argument-secret');
    expect(logOutput).not.toContain('tool-result-secret');
    expectLogsToBeRedacted(logOutput);
  });
});

describe('MCPService', () => {
  let mcpService: any;
  let mockClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // 动态导入服务实例
    const { mcpService: importedService } = await import('./index');
    mcpService = importedService;

    // 创建 mock 客户端
    mockClient = {
      callTool: vi.fn(),
      listTools: vi.fn(),
    };

    // Mock getClient 方法返回 mock 客户端
    vi.spyOn(mcpService as any, 'getClient').mockResolvedValue(mockClient);
  });

  describe('callTool', () => {
    const mockParams = {
      name: 'test-mcp',
      type: 'stdio' as const,
      command: 'test-command',
      args: ['--test'],
    };

    it('should return MCPToolCallResult when content array is empty', async () => {
      mockClient.callTool.mockResolvedValue({
        content: [],
        isError: false,
      });

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe('');
      expect(result.success).toBe(true);
      expect(result.state).toEqual({ content: [], isError: false });
    });

    it('should handle null content', async () => {
      mockClient.callTool.mockResolvedValue({
        content: null,
        isError: false,
      });

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe('');
      expect(result.success).toBe(true);
    });

    it('should return JSON string when single element contains valid JSON', async () => {
      const jsonData = { message: 'Hello World', status: 'success' };
      mockClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(jsonData) }],
        isError: false,
      });

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe(JSON.stringify(jsonData));
      expect(result.success).toBe(true);
    });

    it('should return plain text when single element contains non-JSON text', async () => {
      const textData = 'Hello World';
      mockClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: textData }],
        isError: false,
      });

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe(textData);
      expect(result.success).toBe(true);
      expect(result.state.content).toEqual([{ type: 'text', text: textData }]);
    });

    it('should return empty content when single element has no text', async () => {
      const contentData = [{ type: 'text', text: '' }];
      mockClient.callTool.mockResolvedValue({
        content: contentData,
        isError: false,
      });

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe('');
      expect(result.success).toBe(true);
      expect(result.state.content).toEqual(contentData);
    });

    it('should join multiple text elements with double newlines', async () => {
      const multipleContent = [
        { type: 'text', text: 'First message' },
        { type: 'text', text: 'Second message' },
        { type: 'text', text: '{"json": "data"}' },
      ];

      mockClient.callTool.mockResolvedValue({
        content: multipleContent,
        isError: false,
      });

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe('First message\n\nSecond message\n\n{"json": "data"}');
      expect(result.success).toBe(true);
      expect(result.state.content).toEqual(multipleContent);
    });

    it('should join two text elements with double newline', async () => {
      const twoContent = [
        { type: 'text', text: 'First message' },
        { type: 'text', text: 'Second message' },
      ];

      mockClient.callTool.mockResolvedValue({
        content: twoContent,
        isError: false,
      });

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe('First message\n\nSecond message');
      expect(result.success).toBe(true);
      expect(result.state.content).toEqual(twoContent);
    });

    it('should return error result when isError is true', async () => {
      const errorResult = {
        content: [{ type: 'text', text: 'Error occurred' }],
        isError: true,
      };

      mockClient.callTool.mockResolvedValue(errorResult);

      const result = await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: '{}',
      });

      expect(result.content).toBe('Error occurred');
      expect(result.success).toBe(true);
      expect(result.state).toEqual(errorResult);
    });

    it('should throw TRPCError when client throws error', async () => {
      const error = new Error('MCP client error');
      mockClient.callTool.mockRejectedValue(error);

      await expect(
        mcpService.callTool({
          clientParams: mockParams,
          toolName: 'testTool',
          argsStr: '{}',
        }),
      ).rejects.toThrow(TRPCError);
    });

    it('should parse args string correctly', async () => {
      const argsObject = { param1: 'value1', param2: 'value2' };
      const argsString = JSON.stringify(argsObject);

      mockClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      });

      await mcpService.callTool({
        clientParams: mockParams,
        toolName: 'testTool',
        argsStr: argsString,
      });

      expect(mockClient.callTool).toHaveBeenCalledWith('testTool', argsObject);
    });
  });

  describe('listTools', () => {
    const mockParams = {
      name: 'test-mcp',
      type: 'stdio' as const,
      command: 'test-command',
      args: ['--test'],
    };

    it('should successfully list tools and transform to LobeChatPluginApi format', async () => {
      const mockTools = [
        {
          name: 'tool1',
          description: 'First test tool',
          inputSchema: {
            type: 'object',
            properties: { param1: { type: 'string' } },
          },
        },
        {
          name: 'tool2',
          description: 'Second test tool',
          inputSchema: {
            type: 'object',
            properties: { param2: { type: 'number' } },
          },
        },
      ];

      mockClient.listTools.mockResolvedValue(mockTools);

      const result = await mcpService.listTools(mockParams);

      expect(mockClient.listTools).toHaveBeenCalled();
      expect(result).toEqual([
        {
          name: 'tool1',
          description: 'First test tool',
          parameters: {
            type: 'object',
            properties: { param1: { type: 'string' } },
          },
        },
        {
          name: 'tool2',
          description: 'Second test tool',
          parameters: {
            type: 'object',
            properties: { param2: { type: 'number' } },
          },
        },
      ]);
    });

    it('should return empty array when no tools available', async () => {
      mockClient.listTools.mockResolvedValue([]);

      const result = await mcpService.listTools(mockParams);

      expect(result).toEqual([]);
    });

    it('should retry with skipCache when NoValidSessionId error occurs (first retry)', async () => {
      const mockTools = [
        {
          name: 'tool1',
          description: 'Test tool',
          inputSchema: { type: 'object' },
        },
      ];

      // First call fails with NoValidSessionId
      mockClient.listTools.mockRejectedValueOnce(new Error('NoValidSessionId'));
      // Second call (with skipCache=true) succeeds
      mockClient.listTools.mockResolvedValueOnce(mockTools);

      const result = await mcpService.listTools(mockParams);

      expect(mockClient.listTools).toHaveBeenCalledTimes(2);
      expect(result).toEqual([
        {
          name: 'tool1',
          description: 'Test tool',
          parameters: { type: 'object' },
        },
      ]);
    });

    it('should retry up to 3 times for NoValidSessionId error', async () => {
      const mockTools = [
        {
          name: 'tool1',
          description: 'Test tool',
          inputSchema: { type: 'object' },
        },
      ];

      // Fail 3 times, succeed on 4th
      mockClient.listTools
        .mockRejectedValueOnce(new Error('NoValidSessionId'))
        .mockRejectedValueOnce(new Error('NoValidSessionId'))
        .mockRejectedValueOnce(new Error('NoValidSessionId'))
        .mockResolvedValueOnce(mockTools);

      const result = await mcpService.listTools(mockParams);

      expect(mockClient.listTools).toHaveBeenCalledTimes(4);
      expect(result).toHaveLength(1);
    });

    it('should throw original error when NoValidSessionId retry exceeds limit', async () => {
      // Fail more than 3 times
      mockClient.listTools.mockRejectedValue(new Error('NoValidSessionId'));

      await expect(mcpService.listTools(mockParams)).rejects.toThrow('NoValidSessionId');
      // async-retry: 1 initial + 3 retries = 4 attempts
      expect(mockClient.listTools).toHaveBeenCalledTimes(4);
    });

    it('should throw TRPCError on other errors without retry', async () => {
      const error = new Error('Connection failed');
      mockClient.listTools.mockRejectedValue(error);

      await expect(mcpService.listTools(mockParams)).rejects.toThrow(TRPCError);
      expect(mockClient.listTools).toHaveBeenCalledTimes(1);
    });

    it('should throw TRPCError with correct error message', async () => {
      const error = new Error('Custom error message');
      mockClient.listTools.mockRejectedValue(error);

      await expect(mcpService.listTools(mockParams)).rejects.toMatchObject({
        message: 'Error listing tools from MCP server: Custom error message',
        code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });
});
