import { type GlobalState } from '@/store/global/initialState';
import { initialState } from '@/store/global/initialState';
import { merge } from '@/utils/merge';

import { globalGeneralSelectors } from './general';

describe('settingsSelectors', () => {
  describe('currentLanguage', () => {
    it('should return the correct language setting', () => {
      const s: GlobalState = merge(initialState, {
        status: { language: 'fr' },
      });

      const result = globalGeneralSelectors.currentLanguage(s);

      expect(result).toBe('fr');
    });

    it('should resolve `auto` to the first supported browser language', () => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['xx-YY', 'fr-CA']);
      const s: GlobalState = merge(initialState, { status: { language: 'auto' } });

      expect(globalGeneralSelectors.currentLanguage(s)).toBe('fr-FR');
    });

    it('should resolve `auto` to Persian when the browser language is unsupported', () => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['xx-YY']);
      const s: GlobalState = merge(initialState, { status: { language: 'auto' } });

      expect(globalGeneralSelectors.currentLanguage(s)).toBe('fa-IR');
    });
  });

  describe('language', () => {
    it('should default to Persian on web until the user picks a language', () => {
      const s: GlobalState = merge(initialState, { status: { language: undefined } });

      expect(globalGeneralSelectors.language(s)).toBe('fa-IR');
    });

    it('should keep an explicit `auto` choice', () => {
      const s: GlobalState = merge(initialState, { status: { language: 'auto' } });

      expect(globalGeneralSelectors.language(s)).toBe('auto');
    });
  });
});
