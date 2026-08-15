/**
 * Is the pointer over the window?
 *
 * The renderer used to answer this with CSS `:hover`, which stopped working
 * once the chat became a drag region: an app-region drag surface is handled as
 * window chrome, so the page never sees the mouse over it. Watching the cursor
 * against the window's own bounds is independent of that, and of which parts
 * of the page happen to be draggable today.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export function pointerIsOver(bounds: Rect | null, point: Point | null): boolean {
  if (!bounds || !point) return false;
  return point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

export interface PointerWatchDeps {
  bounds(): Rect | null;
  cursor(): Point | null;
  /** Called only when the answer changes, so the renderer is not spammed. */
  onChange(over: boolean): void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  intervalMs?: number;
}

export const POINTER_POLL_MS = 120;

/** Polls the cursor and reports crossings of the window's edge. */
export function watchPointer(deps: PointerWatchDeps): { stop(): void } {
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let last: boolean | null = null;

  const tick = (): void => {
    let over = false;
    try {
      over = pointerIsOver(deps.bounds(), deps.cursor());
    } catch {
      // A destroyed window throws when asked for its bounds; treat that as
      // "not over" rather than letting the timer die.
      over = false;
    }
    if (over === last) return;
    last = over;
    deps.onChange(over);
  };

  const handle = setIntervalFn(tick, deps.intervalMs ?? POINTER_POLL_MS);
  return { stop: () => clearIntervalFn(handle) };
}
