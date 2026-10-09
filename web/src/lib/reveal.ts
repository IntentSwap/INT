// Things that happen once, when a part of the page first comes into view: a section's entrance,
// a number counting up, a drawing starting. Nothing here ever runs a second time for the same
// element, and nothing moves the page: the stylesheets change transform and opacity only.

import { useEffect, useRef, useState, type RefObject } from "react";

/** True where the system asks for less movement. Read as the page is used, because it can be changed while the page is open. */
export function prefersLessMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The same, as something a component can follow. */
export function useLessMotion(): boolean {
  const [less, setLess] = useState(prefersLessMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const follow = () => setLess(query.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  return less;
}

/**
 * Says when an element has first come into view, and never takes it back. `margin` is how far inside
 * the screen its edge must be first (a share of the screen's height), so that an entrance is seen
 * rather than finished just below the fold.
 */
export function useSeen<T extends Element>(margin = 0.12): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null || seen) return;
    // A browser without the means to watch shows everything at once.
    if (typeof IntersectionObserver !== "function") {
      setSeen(true);
      return;
    }
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          watcher.disconnect();
        }
      },
      { rootMargin: `0px 0px -${Math.round(margin * 100)}% 0px` },
    );
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [seen, margin]);
  return [ref, seen];
}

/** The step of a count from nothing to `target` at a share `t` of the way (0 to 1), easing out. Whole numbers only. */
export function countAt(target: number, t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return target;
  return Math.round(target * (1 - (1 - t) ** 3));
}

/**
 * A number that counts up to its value once, when `go` first becomes true. Where less movement is
 * asked for, and whenever the value changes later, the number is simply shown.
 */
export function useCountUp(target: number, go: boolean, durationMs = 700): number {
  const [shown, setShown] = useState(0);
  const done = useRef(false);
  useEffect(() => {
    if (!go) return;
    if (done.current || prefersLessMotion() || typeof requestAnimationFrame !== "function") {
      done.current = true;
      setShown(target);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / durationMs);
      setShown(countAt(target, t));
      if (t < 1) frame = requestAnimationFrame(step);
      else done.current = true;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [go, target, durationMs]);
  return go ? shown : 0;
}
