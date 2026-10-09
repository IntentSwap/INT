import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; busy?: boolean };

/**
 * The one primary button. Its label is always the next step or the reason
 * nothing can happen yet, so it is never disabled without an explanation.
 */
export function PrimaryButton({ children, busy = false, disabled, ...rest }: Props) {
  return (
    <button type="button" className="button-primary" disabled={disabled} aria-disabled={disabled || undefined} aria-busy={busy || undefined} data-busy={busy || undefined} {...rest}>
      {children}
    </button>
  );
}

export function SecondaryButton({ children, busy = false, ...rest }: Props) {
  return (
    <button type="button" className="button-secondary" aria-busy={busy || undefined} {...rest}>
      {children}
    </button>
  );
}

/** A quiet text button, 36 high with a 44 hit area. */
export function TextButton({ children, ...rest }: Props) {
  return (
    <button type="button" className="button-text" {...rest}>
      {children}
    </button>
  );
}

/** A square icon button. `label` is read out; the icon itself is decorative. */
export function IconButton({ children, label, ...rest }: Props & { label: string }) {
  return (
    <button type="button" className="button-icon" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
