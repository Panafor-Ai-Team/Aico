import { describe, expect, it, vi } from 'vitest';

import type { ISandboxService } from '../types';
import { CloudSandboxExecutionRuntime } from './index';

const createRuntime = (url: string) => {
  const sandboxService = {
    callTool: vi.fn(),
    exportAndUploadFile: vi.fn(async () => ({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 10,
      success: true,
      url,
    })),
  } as unknown as ISandboxService;

  return new CloudSandboxExecutionRuntime(sandboxService);
};

describe('CloudSandboxExecutionRuntime.exportFile', () => {
  it('returns a direct-download URL to the model and the render state', async () => {
    const runtime = createRuntime('https://app.example.com/f/file_abc');

    const output = await runtime.exportFile({ path: '/mnt/data/report.pdf' });

    expect(output.content).toContain('Download URL: https://app.example.com/f/file_abc?download=1');
    expect(output.state).toMatchObject({
      downloadUrl: 'https://app.example.com/f/file_abc?download=1',
      success: true,
    });
  });
});
