import { describe, expect, it } from 'vitest';

import { videoGenerationSettingsConfirmAudit } from './confirmation';

describe('videoGenerationSettingsConfirmAudit', () => {
  it('asks before every interactive generation, whatever the approval mode', async () => {
    for (const approvalMode of ['manual', 'allow-list', 'auto-run', undefined]) {
      await expect(videoGenerationSettingsConfirmAudit({}, { approvalMode })).resolves.toBe(true);
    }
  });

  it('never asks in headless runs, which have no card to answer', async () => {
    await expect(
      videoGenerationSettingsConfirmAudit({}, { approvalMode: 'headless' }),
    ).resolves.toBe(false);
  });
});
