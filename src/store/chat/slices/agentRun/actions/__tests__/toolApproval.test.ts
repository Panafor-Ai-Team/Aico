import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';

import { useChatStore } from '../../../../store';
import { messageMapKey } from '../../../../utils/messageMapKey';
import { findRequestRootUserMessageId } from '../state/toolApproval';
import { createMockMessage, TEST_IDS } from './fixtures';
import { resetTestEnvironment } from './helpers';

// Keep zustand mock as it's needed globally
vi.mock('zustand/traditional');

const chatKey = messageMapKey({ agentId: TEST_IDS.SESSION_ID, topicId: TEST_IDS.TOPIC_ID });

// user-1 → assistant-1 → tool-1 (request 1); user-2 → assistant-2 → tool-2 (request 2)
const requestMessages = [
  createMockMessage({ id: 'user-1', parentId: undefined, role: 'user' }),
  createMockMessage({ id: 'assistant-1', parentId: 'user-1', role: 'assistant' }),
  createMockMessage({ id: 'tool-1', parentId: 'assistant-1', role: 'tool' }),
  createMockMessage({ id: 'user-2', parentId: 'tool-1', role: 'user' }),
  createMockMessage({ id: 'assistant-2', parentId: 'user-2', role: 'assistant' }),
  createMockMessage({ id: 'tool-2', parentId: 'assistant-2', role: 'tool' }),
];

const setTopicMetadata = (metadata: Record<string, unknown>) => {
  useChatStore.setState({
    topicDataMap: {
      [TEST_IDS.SESSION_ID]: {
        items: [{ id: TEST_IDS.TOPIC_ID, metadata, title: 'Topic' } as any],
        total: 1,
      } as any,
    },
  });
};

const setUserApprovalMode = (approvalMode: 'auto-run' | 'manual') => {
  useUserStore.setState({
    settings: { tool: { humanIntervention: { allowList: ['a/b'], approvalMode } } },
  } as any);
};

beforeEach(() => {
  resetTestEnvironment();
  useChatStore.setState({
    dbMessagesMap: { [chatKey]: requestMessages },
    toolApprovalRequestGrants: {},
    topicDataMap: {},
  });
  setUserApprovalMode('manual');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findRequestRootUserMessageId', () => {
  const byId = new Map(requestMessages.map((m) => [m.id, m]));

  it('walks the parent chain to the user message that started the request', () => {
    expect(findRequestRootUserMessageId(byId, 'tool-2')).toBe('user-2');
    expect(findRequestRootUserMessageId(byId, 'tool-1')).toBe('user-1');
  });

  it('returns undefined when the chain is broken', () => {
    expect(findRequestRootUserMessageId(byId, 'missing')).toBeUndefined();
  });
});

describe('ToolApproval actions', () => {
  it('keeps the user setting when nothing was granted', () => {
    const { result } = renderHook(() => useChatStore());

    expect(
      result.current.resolveUserInterventionConfig({
        anchorMessageId: 'tool-2',
        topicId: TEST_IDS.TOPIC_ID,
      }),
    ).toEqual({ allowList: ['a/b'], approvalMode: 'manual' });
  });

  it('auto-runs the rest of a request once one of its tool calls is approved', () => {
    const { result } = renderHook(() => useChatStore());

    act(() => {
      result.current.grantToolApproval('request', {
        anchorMessageId: 'tool-1',
        topicId: TEST_IDS.TOPIC_ID,
      });
    });

    expect(result.current.toolApprovalRequestGrants).toEqual({ 'user-1': true });
    // a later resume of the same request
    expect(
      result.current.resolveUserInterventionConfig({ anchorMessageId: 'assistant-1' }).approvalMode,
    ).toBe('auto-run');
    // the next request asks again
    expect(
      result.current.resolveUserInterventionConfig({ anchorMessageId: 'tool-2' }).approvalMode,
    ).toBe('manual');
  });

  it('auto-runs every request of a chat that was approved for the whole chat', () => {
    const { result } = renderHook(() => useChatStore());
    const updateTopicMetadata = vi
      .spyOn(result.current, 'updateTopicMetadata')
      .mockResolvedValue(undefined);

    act(() => {
      result.current.grantToolApproval('chat', {
        anchorMessageId: 'tool-1',
        topicId: TEST_IDS.TOPIC_ID,
      });
    });

    expect(updateTopicMetadata).toHaveBeenCalledWith(TEST_IDS.TOPIC_ID, { autoApproveTools: true });

    setTopicMetadata({ autoApproveTools: true });
    expect(
      result.current.resolveUserInterventionConfig({
        anchorMessageId: 'tool-2',
        topicId: TEST_IDS.TOPIC_ID,
      }).approvalMode,
    ).toBe('auto-run');
    // another chat is not affected
    expect(
      result.current.resolveUserInterventionConfig({
        anchorMessageId: 'tool-2',
        topicId: 'other-topic',
      }).approvalMode,
    ).toBe('manual');
  });

  it('stops auto-running a chat once its grant is turned off', () => {
    const { result } = renderHook(() => useChatStore());
    setTopicMetadata({ autoApproveTools: false });

    expect(result.current.isChatToolApprovalGranted(TEST_IDS.TOPIC_ID)).toBe(false);
    expect(
      result.current.resolveUserInterventionConfig({
        anchorMessageId: 'tool-2',
        topicId: TEST_IDS.TOPIC_ID,
      }).approvalMode,
    ).toBe('manual');
  });

  it('leaves an auto-run user setting unchanged', () => {
    const { result } = renderHook(() => useChatStore());
    setUserApprovalMode('auto-run');

    expect(result.current.resolveUserInterventionConfig({ anchorMessageId: 'tool-2' })).toEqual({
      allowList: ['a/b'],
      approvalMode: 'auto-run',
    });
  });
});
