import { ComposioConnectedAccountNotFoundError, ComposioToolExecutionError } from '@composio/core';
import { describe, expect, it } from 'vitest';

import {
  isComposioConnectedAccountLookupNotFoundError,
  isComposioConnectedAccountNotFoundError,
  toComposioToolOutcome,
} from './index';

describe('isComposioConnectedAccountNotFoundError', () => {
  /** @example A normalized SDK error is recognized by its concrete class. */
  it('recognizes the Composio connected-account error class', () => {
    expect(
      isComposioConnectedAccountNotFoundError(new ComposioConnectedAccountNotFoundError()),
    ).toBe(true);
  });

  /** @example A raw tool HTTP 404 is not sufficient proof that the account is missing. */
  it('does not classify a direct HTTP 404 outside an account lookup', () => {
    // ROOT CAUSE:
    //
    // A valid tool can return HTTP 404 for a missing provider resource.
    // Treating every direct 404 as an account failure disables a healthy connector.
    //
    // Before: the shared predicate returned true for any direct status 404.
    // We fixed this by reserving raw HTTP matching for the account lookup boundary.
    expect(isComposioConnectedAccountNotFoundError({ status: 404 })).toBe(false);
  });

  /** @example connectedAccounts.get may expose the generated client's HTTP status directly. */
  it('recognizes a direct HTTP 404 at the connected-account lookup boundary', () => {
    expect(isComposioConnectedAccountLookupNotFoundError({ status: 404 })).toBe(true);
  });

  /** @example Unrelated wrapped errors are not recursively interpreted by this boundary. */
  it('does not classify unrelated or causally nested errors', () => {
    expect(isComposioConnectedAccountNotFoundError({ status: 500 })).toBe(false);
    expect(
      isComposioConnectedAccountNotFoundError(
        new ComposioToolExecutionError('tool failed', { cause: { status: 404 } }),
      ),
    ).toBe(false);
  });
});

// Regression: both executors read only `data` and dropped `successful` / `error`,
// so a failed upstream call (Composio resolves `{ successful: false }` instead of
// throwing) reached the model as an empty success.
describe('toComposioToolOutcome', () => {
  it('keeps a successful response as-is', () => {
    expect(
      toComposioToolOutcome({ data: { login: 'octocat' }, error: null, successful: true }),
    ).toEqual({ content: '{"login":"octocat"}', success: true });
  });

  it("reports a failed call with Composio's error text", () => {
    expect(toComposioToolOutcome({ data: {}, error: 'Not Found', successful: false })).toEqual({
      content: 'Not Found',
      error: 'Not Found',
      success: false,
    });
  });

  it('keeps the data Composio returned next to the error', () => {
    const outcome = toComposioToolOutcome({
      data: { message: 'Not Found', status: '404' },
      error: 'Request failed',
      successful: false,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.content).toBe('Request failed\n\n{"message":"Not Found","status":"404"}');
  });

  it('falls back to a generic message when a failure carries no error text', () => {
    expect(toComposioToolOutcome({ data: {}, error: null, successful: false })).toMatchObject({
      error: 'Composio tool execution failed',
      success: false,
    });
  });

  it('joins text blocks and passes plain strings through', () => {
    expect(
      toComposioToolOutcome({ data: [{ text: 'a', type: 'text' }, 'b'], successful: true }).content,
    ).toBe('a\nb');
    expect(toComposioToolOutcome('raw').content).toBe('raw');
  });
});
