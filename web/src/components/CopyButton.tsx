import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Copies a plain string. What goes to the clipboard is always the raw value, never the
 * shortened or grouped form on screen. The button says "Copied" for a second and a half.
 */
export function CopyButton({ value, label = "Copy", what }: { value: string; label?: string; what: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    navigator.clipboard
      .writeText(value)
      .then(() => setState("copied"))
      .catch(() => setState("failed"))
      .finally(() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1500);
      });
  };

  return (
    <button type="button" className="button-chip" onClick={copy}>
      {state === "copied" ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.5} aria-hidden="true" />}
      {/* The name read aloud is the word on the button followed by what it copies ("Copy the amount"),
          so it always begins with what is shown. */}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}</span>
      <span className="sr-only"> {what}</span>
    </button>
  );
}
