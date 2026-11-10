import { describe, expect, it } from 'vitest';

import { isConfirmCancelIntervention, registerConfirmCancelInterventions } from './interventions';

describe('confirm / cancel interventions', () => {
  it('marks only the registered APIs as confirm / cancel', () => {
    registerConfirmCancelInterventions({ 'lobe-video-generation': ['generateVideo'] });

    expect(isConfirmCancelIntervention('lobe-video-generation', 'generateVideo')).toBe(true);
    expect(isConfirmCancelIntervention('lobe-video-generation', 'listVideoModels')).toBe(false);
    expect(isConfirmCancelIntervention('lobe-local-system', 'runCommand')).toBe(false);
    expect(isConfirmCancelIntervention(undefined, 'generateVideo')).toBe(false);
  });
});
