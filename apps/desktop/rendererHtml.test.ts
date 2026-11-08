import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const parseHtml = (file: string) => {
  const window = new Window();
  window.document.write(readFileSync(path.resolve(__dirname, file), 'utf8'));
  return window.document;
};

describe('desktop renderer HTML entries', () => {
  it.each(['index.html', 'popup.html'])(
    '%s keeps #root outside the static #loading-screen',
    (file) => {
      // The app removes #loading-screen once it renders (removeStaticLoadingScreen).
      // If #root sits inside it, the whole app is removed with the splash and the
      // window stays blank.
      const document = parseHtml(file);
      const root = document.getElementById('root');

      expect(root).not.toBeNull();
      expect(document.getElementById('loading-screen')).not.toBeNull();
      expect(root!.closest('#loading-screen')).toBeNull();
    },
  );
});
