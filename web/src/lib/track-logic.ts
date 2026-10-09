// "Track order": working out what was pasted into the one field. An order's link, an order's
// ID, or the deposit address that was paid. Nothing here talks to the server.

import { DEPOSIT_ADDRESS_SHAPE } from "../../../shared/chains.ts";

const ORDER_ID = /^[A-Za-z0-9_-]{27}$/;

export interface TrackInput {
  /** An order ID to look for, when the text could be one. */
  id: string | null;
  /** A deposit address to look for, when the text could be one. */
  address: string | null;
}

/**
 * Reads the field. A link to an order gives its ID. Some text could be either an ID or an
 * address (both are plain runs of letters and digits): then both are tried, the ID first.
 */
export function readTrackInput(text: string): TrackInput {
  const value = text.trim();
  if (value === "" || value.length > 300) return { id: null, address: null };
  const link = /\/order\/([A-Za-z0-9_-]{27})(?:[/?#].*)?$/.exec(value);
  if (link) return { id: link[1] ?? null, address: null };
  // A web address, or anything that tries to climb out of a folder, is no deposit address, whatever its letters.
  const address = DEPOSIT_ADDRESS_SHAPE.test(value) && !/:\/\/|\.\.|^\/|^www\./i.test(value);
  return { id: ORDER_ID.test(value) ? value : null, address: address ? value : null };
}

export type TrackOutcome = { kind: "found"; id: string } | { kind: "none" } | { kind: "wait" } | { kind: "offline" };

/** What the page says after a look that found nothing. One sentence for every kind of miss, so a miss tells nothing. */
export const TRACK_WORDS = {
  none: "No order matches that. Check it and try again. An order that was never paid is removed a day after its deadline.",
  wait: "Too many tries. Wait a minute, then try again.",
  offline: "Can't reach the service. Check your connection, then try again.",
} as const;

/**
 * Looks for the order. `lookUp` asks the server and answers "found" (with the ID), "none", "wait"
 * or "offline". A miss as an ID is followed by a try as an address, when the text could be both.
 */
export async function findOrder(input: TrackInput, lookUp: { byId(id: string): Promise<TrackOutcome>; byAddress(address: string): Promise<TrackOutcome> }): Promise<TrackOutcome> {
  if (input.id === null && input.address === null) return { kind: "none" };
  if (input.id !== null) {
    const first = await lookUp.byId(input.id);
    if (first.kind !== "none" || input.address === null) return first;
  }
  return input.address !== null ? lookUp.byAddress(input.address) : { kind: "none" };
}
