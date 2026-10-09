import { useEffect, useState, type RefObject } from "react";

/**
 * True while a marker placed just after a pinned element is below the bottom of the screen,
 * which is exactly when that element is being held in view rather than sitting in its own place.
 *
 * Measured afresh whenever the page scrolls, the window changes size or the content around the
 * marker changes height. (Watching only for the marker to cross the edge of the screen is not
 * enough: a jump straight past it, as a link to a section further down makes, crosses nothing.)
 */
export function useStuck(marker: RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const element = marker.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bottom = window.visualViewport?.height ?? window.innerHeight;
      setStuck(element.getBoundingClientRect().top > bottom + 0.5);
    };
    const later = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    window.visualViewport?.addEventListener("resize", later);
    // The card growing or shrinking moves the marker without any scrolling.
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    if (element.parentElement) sizes?.observe(element.parentElement);
    sizes?.observe(document.documentElement);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
      window.visualViewport?.removeEventListener("resize", later);
      sizes?.disconnect();
    };
  }, [marker]);
  return stuck;
}

/**
 * Keeps the CSS variable --keyboard-inset equal to the height the on-screen keyboard covers,
 * so anything pinned to the bottom of the screen sits above the keyboard instead of under it.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      root.style.setProperty("--keyboard-inset", `${covered}px`);
      // The keyboard has just covered part of the screen: bring the field being typed in back into view.
      if (covered > 0) document.activeElement?.closest(".address-field, .field")?.scrollIntoView({ block: "nearest" });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
