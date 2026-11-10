import { describe, expect, it } from 'vitest';

import { getSaveErrorMessage } from './saveError';

const t = (key: string, opts?: any) => (opts?.reason ? `${key}|${opts.reason}` : key);

describe('getSaveErrorMessage', () => {
  it('shows the server reason for a 400', () => {
    const error = Object.assign(new Error('OAuth setup failed: X'), { data: { httpStatus: 400 } });

    expect(getSaveErrorMessage(error, t)).toBe('dev.saveErrorWithReason|OAuth setup failed: X');
  });

  it('shows the sign-in hint when the server requires authorization', () => {
    const error = Object.assign(new Error('MCP_AUTH_REQUIRED'), { data: { httpStatus: 412 } });

    expect(getSaveErrorMessage(error, t)).toBe('error.mcpAuthRequired');
  });

  it('shows messages from user-facing client errors', () => {
    const error = Object.assign(new Error('Authorization failed'), { userFacing: true });

    expect(getSaveErrorMessage(error, t)).toBe('dev.saveErrorWithReason|Authorization failed');
  });

  it('keeps the generic message for an unexplained 500', () => {
    const error = Object.assign(new Error('boom'), { data: { httpStatus: 500 } });

    expect(getSaveErrorMessage(error, t)).toBe('dev.saveError');
  });
});
