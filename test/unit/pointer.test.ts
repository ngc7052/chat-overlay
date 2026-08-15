import { describe, expect, it, vi } from 'vitest';
import { pointerIsOver, watchPointer } from '../../src/main/pointer.js';

/**
 * The window's "is the pointer over me" signal. It used to be CSS `:hover`,
 * until the chat became a drag region — an app-region drag surface is treated
 * as window chrome, so the page stops seeing the mouse over it and the backdrop
 * only came up over the few no-drag pixels left.
 */

const bounds = { x: 100, y: 50, width: 400, height: 300 };

describe('pointerIsOver', () => {
  it('is true inside the window', () => {
    expect(pointerIsOver(bounds, { x: 300, y: 200 })).toBe(true);
  });

  it('includes the top-left corner and excludes the far edges', () => {
    // Half-open on purpose: the pixel at x + width belongs to whatever is next.
    expect(pointerIsOver(bounds, { x: 100, y: 50 })).toBe(true);
    expect(pointerIsOver(bounds, { x: 499, y: 349 })).toBe(true);
    expect(pointerIsOver(bounds, { x: 500, y: 200 })).toBe(false);
    expect(pointerIsOver(bounds, { x: 300, y: 350 })).toBe(false);
  });

  it('is false outside on every side', () => {
    for (const p of [{ x: 99, y: 200 }, { x: 300, y: 49 }, { x: 0, y: 0 }, { x: 900, y: 900 }]) {
      expect(pointerIsOver(bounds, p)).toBe(false);
    }
  });

  it('is false when either the window or the cursor is unknown', () => {
    expect(pointerIsOver(null, { x: 300, y: 200 })).toBe(false);
    expect(pointerIsOver(bounds, null)).toBe(false);
    expect(pointerIsOver(null, null)).toBe(false);
  });
});

describe('watchPointer', () => {
  function harness(cursors: ({ x: number; y: number } | null)[], boundsFn = () => bounds) {
    const changes: boolean[] = [];
    const timers: (() => void)[] = [];
    let i = 0;
    const cleared: unknown[] = [];
    const watch = watchPointer({
      bounds: boundsFn,
      cursor: () => cursors[Math.min(i++, cursors.length - 1)] ?? null,
      onChange: (over) => changes.push(over),
      setIntervalFn: (fn) => { timers.push(fn); return 'handle'; },
      clearIntervalFn: (h) => cleared.push(h),
    });
    return { watch, changes, tick: () => timers.forEach((f) => f()), cleared };
  }

  it('reports the first answer, whatever it is', () => {
    const h = harness([{ x: 300, y: 200 }]);
    h.tick();
    expect(h.changes).toEqual([true]);
  });

  it('reports only crossings, so the renderer is not spammed', () => {
    const h = harness([
      { x: 300, y: 200 },   // in
      { x: 310, y: 210 },   // still in
      { x: 900, y: 900 },   // out
      { x: 910, y: 910 },   // still out
      { x: 300, y: 200 },   // in again
    ]);
    for (let n = 0; n < 5; n++) h.tick();
    expect(h.changes).toEqual([true, false, true]);
  });

  it('treats a window that throws as not hovered, and keeps polling', () => {
    // getBounds() throws once the window is destroyed; the timer must survive.
    const h = harness([{ x: 300, y: 200 }], () => { throw new Error('destroyed'); });
    h.tick();
    h.tick();
    expect(h.changes).toEqual([false]);
  });

  it('stops the timer when asked', () => {
    const h = harness([{ x: 0, y: 0 }]);
    h.watch.stop();
    expect(h.cleared).toEqual(['handle']);
  });

  it('falls back to the real timers when none are injected', () => {
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(7 as never);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      watchPointer({ bounds: () => null, cursor: () => null, onChange: () => {} }).stop();
      expect(spy).toHaveBeenCalled();
      expect(clear).toHaveBeenCalledWith(7);
    } finally {
      spy.mockRestore();
      clear.mockRestore();
    }
  });
});
