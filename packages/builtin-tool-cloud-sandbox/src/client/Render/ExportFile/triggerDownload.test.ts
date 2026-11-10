// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { triggerFileDownload } from './triggerDownload';

describe('triggerFileDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('downloads file proxy URLs through an attachment link without fetching or opening a tab', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    await triggerFileDownload('https://app.example.com/f/file_abc', 'report.pdf');

    expect(clicked).toHaveLength(1);
    expect(clicked[0].href).toBe('https://app.example.com/f/file_abc?download=1');
    expect(clicked[0].download).toBe('report.pdf');
    expect(clicked[0].target).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
