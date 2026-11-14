import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetChunkErrorStateForTest,
  DEFERRED_RELOAD_POLL_MS,
  notifyChunkError,
  registerChunkReloadBlocker,
} from './chunkError';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('@lobehub/ui/base-ui', () => ({ toast: { error: toastError } }));

vi.mock('i18next', () => ({
  t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? 'refresh',
}));

const reload = vi.fn();
const chunkError = () => new Error('Failed to fetch dynamically imported module: /_spa/a.js');

describe('notifyChunkError', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
      writable: true,
    });
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetChunkErrorStateForTest();
    vi.useRealTimers();
    sessionStorage.clear();
    reload.mockClear();
    toastError.mockClear();
  });

  it('reloads immediately when no work is in flight', () => {
    notifyChunkError(chunkError());

    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('lobe-chunk-reload')).toBe('1');
  });

  it('does not reload while a send or reply is in flight, then reloads once it settles', () => {
    let busy = true;
    registerChunkReloadBlocker(() => busy);

    notifyChunkError(chunkError());
    vi.advanceTimersByTime(DEFERRED_RELOAD_POLL_MS * 10);

    // The send that was just saved must survive: no reload while busy.
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('lobe-chunk-reload')).toBeNull();

    busy = false;
    vi.advanceTimersByTime(DEFERRED_RELOAD_POLL_MS);
    // One idle tick is not enough (it can fall before the next send starts).
    expect(reload).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFERRED_RELOAD_POLL_MS);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('restarts the idle count when work starts again before the reload fires', () => {
    let busy = true;
    registerChunkReloadBlocker(() => busy);

    notifyChunkError(chunkError());
    busy = false;
    vi.advanceTimersByTime(DEFERRED_RELOAD_POLL_MS);
    busy = true;
    vi.advanceTimersByTime(DEFERRED_RELOAD_POLL_MS * 5);

    expect(reload).not.toHaveBeenCalled();
  });

  it('schedules a single reload for repeated distinct errors while deferred', () => {
    let busy = true;
    registerChunkReloadBlocker(() => busy);

    notifyChunkError(chunkError());
    notifyChunkError(chunkError());
    busy = false;
    vi.advanceTimersByTime(DEFERRED_RELOAD_POLL_MS * 4);

    expect(reload).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('ignores a blocker that throws', () => {
    registerChunkReloadBlocker(() => {
      throw new Error('broken check');
    });

    notifyChunkError(chunkError());

    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows the refresh toast instead of reloading again in the same session', () => {
    sessionStorage.setItem('lobe-chunk-reload', '1');

    notifyChunkError(chunkError());

    expect(reload).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledOnce();
  });
});
