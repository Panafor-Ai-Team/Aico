import { describe, expect, it } from 'vitest';

import { inferCrudType } from './utils';

describe('inferCrudType', () => {
  it('classifies prefixed MCP tool names by their verb segment', () => {
    expect(inferCrudType('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER')).toBe('read');
    expect(inferCrudType('GITHUB_CHECK_IF_A_PULL_REQUEST_HAS_BEEN_MERGED')).toBe('read');
    expect(inferCrudType('GITHUB_COMPARE_TWO_COMMITS')).toBe('read');
    expect(inferCrudType('linear_list_issues')).toBe('read');
    expect(inferCrudType('GITHUB_CREATE_A_CHECK_RUN')).toBe('write');
    expect(inferCrudType('GITHUB_DELETE_A_REPOSITORY')).toBe('delete');
    expect(inferCrudType('GITHUB_UPDATE_AN_ISSUE')).toBe('update');
  });

  it('keeps classifying unprefixed names', () => {
    expect(inferCrudType('getReactions')).toBe('read');
    expect(inferCrudType('sendEmail')).toBe('write');
  });
});
