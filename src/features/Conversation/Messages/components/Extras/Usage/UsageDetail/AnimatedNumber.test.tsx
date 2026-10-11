import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AnimatedNumber from './AnimatedNumber';

// Deterministic frame clock: collect every painted value through the formatter.
let rafId = 0;
let pending = new Map<number, FrameRequestCallback>();
let painted: number[] = [];

const runFrames = (times: number[]) => {
  // act() flushes the setDisplayValue calls RAF callbacks schedule.
  act(() => {
    for (const t of times) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb(t);
    }
  });
};

const renderCounter = (value: number, duration = 1000) => {
  painted = [];
  return render(
    <AnimatedNumber
      duration={duration}
      value={value}
      formatter={(v) => {
        painted.push(v);
        return String(Math.round(v));
      }}
    />,
  );
};

describe('AnimatedNumber', () => {
  beforeEach(() => {
    rafId = 0;
    pending = new Map();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafId += 1;
      pending.set(rafId, cb);
      return rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pending.delete(id);
    });
    vi.stubGlobal('performance', { now: () => 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('settles exactly on the target value', () => {
    const view = renderCounter(0);
    view.rerender(
      <AnimatedNumber
        duration={1000}
        value={250}
        formatter={(v) => {
          painted.push(v);
          return String(Math.round(v));
        }}
      />,
    );
    runFrames([200, 400, 600, 800, 1000, 1200]);

    expect(painted.at(-1)).toBe(250);
  });

  it('never snaps backward when a downward correction lands mid-flight', () => {
    // BUG-3: streaming usage climbs, then revises down before finalizing.
    // The counter must glide down from the painted value — not jump back to
    // a stale leg start and re-climb.
    const view = renderCounter(0);
    view.rerender(
      <AnimatedNumber
        duration={1000}
        value={100}
        formatter={(v) => {
          painted.push(v);
          return String(Math.round(v));
        }}
      />,
    );
    // Climb partway: easeOutCubic hits ~87.5 at half duration.
    runFrames([0, 500]);

    const peak = painted.at(-1)!;
    expect(peak).toBeGreaterThan(50);

    // Downward correction mid-flight.
    view.rerender(
      <AnimatedNumber
        duration={1000}
        value={60}
        formatter={(v) => {
          painted.push(v);
          return String(Math.round(v));
        }}
      />,
    );
    const before = painted.length;
    runFrames([600, 700, 800, 1000, 1500, 2500]);

    const leg = painted.slice(before);
    // A downward leg glides from the peak toward the target: no frame may
    // dip below the target (a stale restart repaints from ~0 upward).
    for (const v of leg) expect(v).toBeGreaterThanOrEqual(60 - 1);
    expect(painted.at(-1)).toBe(60);
  });

  it('continues forward when an upward revision lands mid-flight', () => {
    const view = renderCounter(0);
    view.rerender(
      <AnimatedNumber
        duration={1000}
        value={100}
        formatter={(v) => {
          painted.push(v);
          return String(Math.round(v));
        }}
      />,
    );
    runFrames([0, 500]);
    const mid = painted.at(-1)!;

    view.rerender(
      <AnimatedNumber
        duration={1000}
        value={300}
        formatter={(v) => {
          painted.push(v);
          return String(Math.round(v));
        }}
      />,
    );
    const before = painted.length;
    runFrames([600, 800, 1000, 1500, 2500]);

    const leg = painted.slice(before);
    for (let i = 1; i < leg.length; i++) {
      // Never steps back below where the revision started.
      expect(leg[i]).toBeGreaterThanOrEqual(Math.min(mid, 300) - 1);
    }
    expect(painted.at(-1)).toBe(300);
  });
});
