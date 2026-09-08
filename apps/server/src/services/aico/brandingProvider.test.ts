import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { AicoManagedPolicy } from './managedPolicy';

/**
 * `BRANDING_PROVIDER` is a provider **id**, compared against real provider keys
 * — not a display name. It previously defaulted to `'official'`, which matched
 * no provider anywhere, so every `provider === BRANDING_PROVIDER` guard was
 * permanently false: the deprecated-managed-model rejection in the image/video
 * routers never fired, `noRetryProviders` never matched, and managed pricing
 * checks never applied.
 *
 * Nothing else catches that, because a wrong id fails silently — the guards just
 * never run. This pins the default to an id the managed layer actually knows.
 */
describe('BRANDING_PROVIDER is a real managed provider id', () => {
  it('is recognised by the managed-provider guard', () => {
    expect(AicoManagedPolicy.isManagedProvider(BRANDING_PROVIDER)).toBe(true);
  });

  it('resolves to a runtime provider that can actually serve traffic', () => {
    expect(AicoManagedPolicy.resolveRuntimeProvider(BRANDING_PROVIDER)).toBe('openrouter');
  });

  it('defaults to the branded alias rather than the raw upstream provider', () => {
    // Guards against silently collapsing the branded alias into 'openrouter',
    // which would change what aicoBilling persists as providerId.
    expect(BRANDING_PROVIDER).toBe('aico');
  });
});
