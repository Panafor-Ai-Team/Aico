import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const BillingSourceSwitcher = () => null;

vi.mock('@/features/AicoBilling', () => ({
  BillingSourceSwitcher,
  useAicoBillingChatGate: () => ({ blockReason: undefined, blocked: false, showTrialCta: false }),
}));

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));

const { getBusinessGenerationSendAreaPrefix } =
  await import('./useBusinessChatInputSendAreaPrefix');

const readPromptInput = (mode: 'image' | 'video') =>
  readFileSync(
    path.join(process.cwd(), `src/routes/(main)/(create)/${mode}/features/PromptInput/index.tsx`),
    'utf8',
  );

describe('getBusinessGenerationSendAreaPrefix', () => {
  it('provides the wallet switcher so generations can pick a billing source', () => {
    const node = getBusinessGenerationSendAreaPrefix();

    expect(isValidElement(node)).toBe(true);
    expect((node as { type: unknown }).type).toBe(BillingSourceSwitcher);
  });

  it('keeps any existing prefix content alongside the wallet switcher', () => {
    const extra = { type: 'span' };
    const node = getBusinessGenerationSendAreaPrefix(extra as never) as {
      props: { children: unknown[] };
    };

    expect(node.props.children[0]).toMatchObject({ type: BillingSourceSwitcher });
    expect(node.props.children[1]).toBe(extra);
  });

  it.each(['image', 'video'] as const)('%s prompt input mounts the wallet switcher', (mode) => {
    expect(readPromptInput(mode)).toContain('getBusinessGenerationSendAreaPrefix()');
  });
});
