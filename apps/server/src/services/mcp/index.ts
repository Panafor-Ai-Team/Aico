import { isDesktop } from '@lobechat/const';
import {
  type CheckMcpInstallResult,
  type CustomPluginMetadata,
  type LobeChatPluginApi,
  type ToolManifest,
  type ToolManifestSettings,
} from '@lobechat/types';
import { isLocalOrPrivateUrl, safeParseJSON } from '@lobechat/utils';
import { type DeploymentOption } from '@lobehub/market-sdk';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { TRPCError } from '@trpc/server';
import retry from 'async-retry';
import debug from 'debug';

import {
  type MCPClientParams,
  type McpPrompt,
  type McpResource,
  type McpTool,
  type StdioMCPParams,
} from '@/libs/mcp';
import { MCPClient } from '@/libs/mcp';
import { getMCPErrorLogMetadata, getMCPLogOrigin } from '@/libs/mcp/utils';

import { type ProcessContentBlocksFn } from './contentProcessor';
import { contentBlocksToString } from './contentProcessor';
import { mcpSystemDepsCheckService } from './deps';

const log = debug('lobe-mcp:service');

interface MCPConnectionLogMetadata {
  origin?: string;
  type: MCPClientParams['type'];
}

/**
 * MCP Tool call raw result type
 */
export interface MCPToolCallRawResult {
  content: any[];
  isError?: boolean;
}

/**
 * MCP Tool call processed result type
 */
export interface MCPToolCallProcessedResult {
  content: string;
  error?: Error;
  state: {
    content: any[];
    isError?: boolean;
  };
  success: boolean;
}

// Removed MCPConnection interface as it's no longer needed

export class MCPService {
  // Store instances of the custom MCPClient, keyed by serialized MCPClientParams
  private clients: Map<string, MCPClient> = new Map();

  /**
   * Process MCP tool call result with content blocks processing
   * This is a common utility method that can be used by both internal MCP calls and external services (e.g., Composio)
   */
  static async processToolCallResult(
    result: MCPToolCallRawResult,
    processContentBlocksFn?: ProcessContentBlocksFn,
  ): Promise<MCPToolCallProcessedResult> {
    // Process content blocks (upload images, etc.)

    const newContent =
      result.isError || !processContentBlocksFn
        ? result.content
        : await processContentBlocksFn(result.content);

    // Convert content blocks to string
    const content = contentBlocksToString(newContent);

    const state = { ...result, content: newContent };

    if (result.isError) {
      return { content, state, success: true };
    }

    return { content, state, success: true };
  }

  /**
   * Keep MCP logs allowlist-only so future connection fields cannot silently expose credentials.
   */
  private getConnectionLogMetadata = (params: MCPClientParams): MCPConnectionLogMetadata => {
    if (params.type === 'http') {
      return { origin: getMCPLogOrigin(params.url), type: params.type };
    }

    return { type: params.type };
  };

  // --- MCP Interaction ---

  // listTools now accepts MCPClientParams
  async listTools(params: MCPClientParams): Promise<LobeChatPluginApi[]> {
    const connection = this.getConnectionLogMetadata(params);

    return retry(
      async (bail, attemptNumber) => {
        // Skip cache on retry attempts
        const skipCache = attemptNumber > 1;
        const client = await this.getClient(params, skipCache);
        log('Listing MCP tools: %O', { attempt: attemptNumber, connection });

        try {
          const result = await client.listTools();
          log('MCP tools listed: %O', { connection, count: result.length });
          return result.map<LobeChatPluginApi>((item) => ({
            // Assuming identifier is the unique name/id
            description: item.description,
            name: item.name,
            parameters: item.inputSchema as ToolManifestSettings,
          }));
        } catch (error) {
          // Only retry for NoValidSessionId errors
          if ((error as Error).message !== 'NoValidSessionId') {
            console.error('MCP operation failed:', {
              connection,
              error: getMCPErrorLogMetadata(error),
              operation: 'listing tools',
            });
            bail(
              new TRPCError({
                cause: error,
                code: 'INTERNAL_SERVER_ERROR',
                message: `Error listing tools from MCP server: ${(error as Error).message}`,
              }),
            );
            return []; // This line will never be reached due to bail, but needed for type safety
          }
          throw error; // Rethrow to trigger retry
        }
      },
      { maxRetryTime: 1000, minTimeout: 100, retries: 3 },
    );
  }

  // listTools now accepts MCPClientParams
  async listRawTools(params: MCPClientParams): Promise<McpTool[]> {
    const client = await this.getClient(params); // Get client using params
    const connection = this.getConnectionLogMetadata(params);
    log('Listing MCP tools: %O', connection);

    try {
      const result = await client.listTools();
      log('MCP tools listed: %O', { connection, count: result.length });
      return result;
    } catch (error) {
      console.error('MCP operation failed:', {
        connection,
        error: getMCPErrorLogMetadata(error),
        operation: 'listing tools',
      });
      // Propagate a TRPCError for better handling upstream
      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: `Error listing tools from MCP server: ${(error as Error).message}`,
      });
    }
  }

  // listResources now accepts MCPClientParams
  async listResources(params: MCPClientParams): Promise<McpResource[]> {
    const client = await this.getClient(params); // Get client using params
    const connection = this.getConnectionLogMetadata(params);
    log('Listing MCP resources: %O', connection);

    try {
      const result = await client.listResources();
      log('MCP resources listed: %O', { connection, count: result.length });
      return result;
    } catch (error) {
      console.error('MCP operation failed:', {
        connection,
        error: getMCPErrorLogMetadata(error),
        operation: 'listing resources',
      });
      // Propagate a TRPCError for better handling upstream
      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: `Error listing resources from MCP server: ${(error as Error).message}`,
      });
    }
  }

  // listPrompts now accepts MCPClientParams
  async listPrompts(params: MCPClientParams): Promise<McpPrompt[]> {
    const client = await this.getClient(params); // Get client using params
    const connection = this.getConnectionLogMetadata(params);
    log('Listing MCP prompts: %O', connection);

    try {
      const result = await client.listPrompts();
      log('MCP prompts listed: %O', { connection, count: result.length });
      return result;
    } catch (error) {
      console.error('MCP operation failed:', {
        connection,
        error: getMCPErrorLogMetadata(error),
        operation: 'listing prompts',
      });
      // Propagate a TRPCError for better handling upstream
      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: `Error listing prompts from MCP server: ${(error as Error).message}`,
      });
    }
  }

  // callTool now accepts an object with clientParams, toolName, argsStr, and processContentBlocks
  async callTool(options: {
    argsStr: any;
    clientParams: MCPClientParams;
    processContentBlocks?: ProcessContentBlocksFn;
    toolName: string;
  }): Promise<any> {
    const {
      clientParams,
      toolName,
      argsStr,
      processContentBlocks: processContentBlocksFn,
    } = options;

    const client = await this.getClient(clientParams); // Get client using params

    const args = safeParseJSON(argsStr);
    const connection = this.getConnectionLogMetadata(clientParams);

    log('Calling MCP tool: %O', { connection, toolName });

    try {
      // Delegate the call to the MCPClient instance
      const result = await client.callTool(toolName, args); // Pass args directly

      // Use the common processing method
      const processedResult = await MCPService.processToolCallResult(
        result,
        processContentBlocksFn,
      );

      log('MCP tool call completed: %O', {
        contentBlockCount: Array.isArray(processedResult.state.content)
          ? processedResult.state.content.length
          : 0,
        isError: processedResult.state.isError === true,
        toolName,
      });

      return processedResult;
    } catch (error) {
      if (error instanceof McpError) {
        const mcpError = error as McpError;

        return {
          content: mcpError.message,
          error,
          state: {
            content: [{ text: mcpError.message, type: 'text' }],
            isError: true,
          },
          success: false,
        };
      }

      console.error('MCP operation failed:', {
        connection,
        error: getMCPErrorLogMetadata(error),
        operation: `calling tool "${toolName}"`,
      });
      // Propagate a TRPCError
      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: `Error calling tool "${toolName}" on MCP server: ${(error as Error).message}`,
      });
    }
  }

  // Private method to get or initialize a client based on parameters
  private async getClient(params: MCPClientParams, skipCache = false): Promise<MCPClient> {
    // Every server caller (including connector sync and agent tool execution)
    // must enforce the same Desktop-only stdio boundary, even for cached clients.
    if (params.type === 'stdio' && !isDesktop) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Stdio MCP type is not supported in web environment.',
      });
    }

    // A shared web server must not fetch user-supplied loopback / private-network
    // MCP endpoints on the user's behalf. Self-hosters who deliberately run MCP
    // servers on their LAN can opt in with the existing SSRF allow switch.
    if (
      params.type === 'http' &&
      !isDesktop &&
      process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS !== '1' &&
      isLocalOrPrivateUrl(params.url)
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Local or private-network MCP endpoints are not supported in web environment.',
      });
    }

    const key = this.serializeParams(params); // Use custom serialization

    if (!skipCache && this.clients.has(key)) {
      return this.clients.get(key)!;
    }

    const connection = this.getConnectionLogMetadata(params);
    log(`No cached client found, Initializing new client.`);
    try {
      const client = new MCPClient(params);
      await client.initialize({
        onProgress: (progress) => {
          log(`New client initializing... ${progress.progress}/${progress.total}`);
        },
      }); // Initialization logic should be within MCPClient
      this.clients.set(key, client);
      log('New MCP client initialized and cached: %O', connection);
      return client;
    } catch (error) {
      const errorLog = getMCPErrorLogMetadata(error);
      console.error('Failed to initialize MCP client:', { connection, error: errorLog });

      if (typeof error === 'object' && !!error && 'data' in error) {
        throw new TRPCError({
          cause: error,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Failed to initialize MCP client',
        });
      }

      // Log detailed error information for debugging
      log('Detailed initialization error: %O', {
        connection,
        error: errorLog,
      });

      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        // DATA-015: generic client message; details stay in server logs above
        message: 'Failed to initialize MCP client',
      });
    }
  }

  // Custom serialization function to ensure consistent keys
  private serializeParams(params: MCPClientParams): string {
    const sortedKeys = Object.keys(params).sort();
    const sortedParams: Record<string, any> = {};

    for (const key of sortedKeys) {
      const value = (params as any)[key];
      // Sort the 'args' array if it exists
      if (key === 'args' && Array.isArray(value)) {
        sortedParams[key] = JSON.stringify(key);
      } else {
        sortedParams[key] = value;
      }
    }

    return JSON.stringify(sortedParams);
  }

  async getStreamableMcpServerManifest(
    identifier: string,
    url: string,
    metadata?: CustomPluginMetadata,
    auth?: {
      accessToken?: string;
      token?: string;
      type: 'none' | 'bearer' | 'oauth2';
    },
    headers?: Record<string, string>,
  ): Promise<ToolManifest> {
    const mcpParams = { name: identifier, type: 'http' as const, url };

    // Add authentication info to parameters if available
    if (auth) {
      (mcpParams as any).auth = auth;
    }

    // Add headers info to parameters if available
    if (headers) {
      (mcpParams as any).headers = headers;
    }

    const tools = await this.listTools(mcpParams);

    return {
      api: tools,
      identifier,
      // @ts-ignore
      mcpParams,
      meta: {
        avatar: metadata?.avatar || 'MCP_AVATAR',
        description:
          metadata?.description ||
          `${identifier} MCP server has ${tools.length} tools, like "${tools[0]?.name}"`,
        title: identifier,
      },
      // TODO: temporary
      type: 'mcp' as any,
    };
  }

  async getStdioMcpServerManifest(
    params: Omit<StdioMCPParams, 'type'>,
    metadata?: CustomPluginMetadata,
  ): Promise<ToolManifest> {
    const mcpParams = {
      args: params.args,
      command: params.command,
      env: params.env,
      name: params.name,
      type: 'stdio' as const,
    };

    const client = await this.getClient(mcpParams); // Get client using params

    const manifest = await client.listManifests();

    const identifier = params.name;

    return {
      api: manifest.tools ? this.transformMCPToolToLobeAPI(manifest.tools) : [],
      identifier,
      meta: {
        avatar: metadata?.avatar || 'MCP_AVATAR',
        description:
          metadata?.description ||
          `${identifier} MCP server has ` +
            Object.entries(manifest)
              .filter(([key]) => ['tools', 'prompts', 'resources'].includes(key))
              .map(([key, item]) => `${(item as Array<any>)?.length} ${key}`)
              .join(','),
        title: metadata?.name || identifier,
      },
      ...manifest,
      // @ts-ignore
      mcpParams,
      // TODO: temporary
      type: 'mcp' as any,
    } as ToolManifest;
  }

  /**
   * Check MCP plugin installation status
   */
  async checkMcpInstall(input: {
    deploymentOptions: DeploymentOption[];
  }): Promise<CheckMcpInstallResult> {
    // The dependency checks run the manifest's check commands in a shell, which only
    // makes sense on the user's own machine (Desktop). Never run them on the web server.
    if (!isDesktop) {
      return {
        error: 'MCP installation checks are only available on Desktop.',
        platform: process.platform,
        success: false,
      };
    }

    try {
      log(
        'Checking MCP plugin installation status for %d option(s)',
        input.deploymentOptions.length,
      );
      const results = [];

      // Check each deployment option
      for (const option of input.deploymentOptions) {
        // Use system dependency check service to check deployment option
        const result = await mcpSystemDepsCheckService.checkDeployOption(option);
        results.push(result);
      }

      // Find the recommended or first installable option
      const recommendedResult = results.find((r) => r.isRecommended && r.allDependenciesMet);
      const firstInstallableResult = results.find((r) => r.allDependenciesMet);

      // Return the recommended result, or the first installable result, or the first result
      const bestResult = recommendedResult || firstInstallableResult || results[0];

      log('MCP plugin installation check completed: %O', {
        allDependenciesMet: bestResult?.allDependenciesMet === true,
        hasResult: Boolean(bestResult),
        isRecommended: bestResult?.isRecommended === true,
        needsConfig: bestResult?.needsConfig === true,
      });

      // Construct return result, ensure configuration check information is included
      const checkResult: CheckMcpInstallResult = {
        ...bestResult,
        allOptions: results,
        platform: process.platform,
        success: true,
      };

      // If the best result requires configuration, ensure related fields are set at the top level
      if (bestResult?.needsConfig) {
        checkResult.needsConfig = true;
        checkResult.configSchema = bestResult.configSchema;
        log('Configuration is required for the selected MCP deployment option');
      }

      return checkResult;
    } catch (error) {
      log('MCP plugin installation check failed: %O', getMCPErrorLogMetadata(error));
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown error when checking MCP plugin installation status',
        platform: process.platform,
        success: false,
      };
    }
  }

  private transformMCPToolToLobeAPI = (data: McpTool[]) => {
    return data.map<LobeChatPluginApi>((item) => ({
      // Assuming identifier is the unique name/id
      description: item.description,
      name: item.name,
      parameters: item.inputSchema as ToolManifestSettings,
    }));
  };
}

// Export a singleton instance
export const mcpService = new MCPService();
