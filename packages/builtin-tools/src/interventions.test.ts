import { describe, expect, it } from 'vitest';

import { isConfirmOnlyIntervention, registerConfirmOnlyInterventions } from './interventions';

describe('confirm-only interventions', () => {
  it('marks only the registered APIs as confirm-only', () => {
    registerConfirmOnlyInterventions({ 'lobe-video-generation': ['generateVideo'] });

    expect(isConfirmOnlyIntervention('lobe-video-generation', 'generateVideo')).toBe(true);
    expect(isConfirmOnlyIntervention('lobe-video-generation', 'listVideoModels')).toBe(false);
    expect(isConfirmOnlyIntervention('lobe-local-system', 'runCommand')).toBe(false);
    expect(isConfirmOnlyIntervention(undefined, 'generateVideo')).toBe(false);
  });
});
