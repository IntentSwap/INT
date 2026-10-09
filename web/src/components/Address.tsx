import { addressParts } from "../lib/swap-logic.ts";

/**
 * A full address, wrapped rather than shortened, with its first and last six characters
 * emphasised: those are the ones people compare. What is copied is always the plain string.
 */
export function Address({ value }: { value: string }) {
  const { start, middle, end } = addressParts(value);
  return (
    <span className="address mono" translate="no">
      <span className="address-end">{start}</span>
      {middle}
      <span className="address-end">{end}</span>
    </span>
  );
}
