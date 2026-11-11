import type { WorkSummaryItem } from '@lobechat/types';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import WorkPreview from './WorkPreview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { ns?: string }) => (options?.ns ? `${options.ns}:${key}` : key),
  }),
}));

const taskItem = (status: string | null, itemStatus: string | null = null) =>
  ({
    id: 'work_1',
    resourceId: 'task_1',
    resourceType: 'task',
    status: itemStatus,
    task: {
      identifier: 'T-1',
      instruction: 'Bring one short article every morning',
      name: 'Daily learning',
      priority: null,
      status,
    },
    taskDeleted: false,
    type: 'task',
  }) as unknown as WorkSummaryItem;

describe('WorkPreview task status', () => {
  it('shows the translated task status instead of the raw enum value', () => {
    const { getByText, queryByText } = render(
      <WorkPreview item={taskItem('running')} title={'Daily learning'} />,
    );

    expect(getByText('chat:taskDetail.status.running')).toBeTruthy();
    expect(queryByText('running')).toBeNull();
  });

  it('keeps a status the work row carries itself as-is', () => {
    const { getByText } = render(
      <WorkPreview item={taskItem('running', 'Shipped')} title={'Daily learning'} />,
    );

    expect(getByText('Shipped')).toBeTruthy();
  });

  it('renders no status tag when the task has no status', () => {
    const { container } = render(<WorkPreview item={taskItem(null)} title={'Daily learning'} />);

    expect(container.textContent).not.toContain('taskDetail.status');
  });
});
