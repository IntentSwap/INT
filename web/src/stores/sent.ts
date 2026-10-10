// A note, kept in this browser only, that a transfer was sent from a wallet for an order: the
// order's ID, the transaction's hash and when. The server learns of a transfer only once it can
// see it on the chain, which may be a little later than a reload. With this note, a reload in
// that moment follows the transfer instead of offering to send it a second time.
// In Ghost mode no wallet is connected, so nothing is sent from one and there is no note to keep or to read.

import { dropKept, KEPT, readKept, writeKept } from "../lib/kept.ts";

const MAX = 20;

export interface SentNote {
  /** The transfer that was sent. Null when the wallet was asked and has not (yet) answered this page. */
  hash: string | null;
  /** When it was sent, or when the wallet was asked. */
  at: number;
  /** Set while the wallet's window is open: the wallet has been asked and has not answered. */
  asking?: true;
}

/** A wallet that was asked longer ago than this has answered, one way or the other, or been closed. */
export const ASKING_LASTS_MS = 30 * 60_000;

type Notes = Record<string, SentNote>;

function isNote(value: unknown): value is SentNote {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const hash = v.hash === null || (typeof v.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(v.hash));
  const asking = v.asking === undefined || v.asking === true;
  // A note says that something was sent, or that the wallet is being asked, or both. Never neither.
  return hash && asking && (v.hash !== null || v.asking === true) && typeof v.at === "number" && Number.isFinite(v.at) && v.at > 0;
}

/** Reads the notes, dropping anything that is not in the expected shape. */
export function readSent(raw: string | null): Notes {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const notes: Notes = {};
    for (const [id, note] of Object.entries(parsed)) if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && isNote(note)) notes[id] = { hash: note.hash, at: note.at, ...(note.asking === true ? { asking: true as const } : {}) };
    return notes;
  } catch {
    return {};
  }
}

/** Adds or replaces the note for one order, and keeps only the newest few. */
export function withSent(notes: Notes, orderId: string, note: SentNote): Notes {
  const kept = Object.entries({ ...notes, [orderId]: note })
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX);
  return Object.fromEntries(kept);
}

function load(): Notes {
  return readSent(readKept(KEPT.sent));
}

/** Without storage the note lasts only as long as this page. */
function save(notes: Notes): void {
  if (Object.keys(notes).length === 0) dropKept(KEPT.sent);
  else writeKept(KEPT.sent, JSON.stringify(notes));
}

/** The transfer sent for this order from this browser, if there was one. */
export function sentFor(orderId: string): SentNote | null {
  return load()[orderId] ?? null;
}

export function rememberSent(orderId: string, hash: string, at: number): void {
  save(withSent(load(), orderId, { hash, at }));
}

/** Written down just before the wallet is opened: from here until it answers, a reload cannot know what it did. */
export function rememberAsking(orderId: string, at: number): void {
  const earlier = load()[orderId];
  save(withSent(load(), orderId, { hash: earlier?.hash ?? null, at, asking: true }));
}

/** The wallet answered without sending (the person said no, or it could not send): back to what was known before. */
export function doneAsking(orderId: string): void {
  const notes = load();
  const note = notes[orderId];
  if (note === undefined || note.asking !== true) return;
  if (note.hash === null) delete notes[orderId];
  else notes[orderId] = { hash: note.hash, at: note.at };
  save(notes);
}

/** Whether the wallet was being asked when the page was last here, recently enough to matter. */
export function wasAsking(note: SentNote | null, now: number): boolean {
  return note !== null && note.asking === true && now - note.at < ASKING_LASTS_MS;
}

/** Dropped once the transfer is known to have failed: nothing is on its way any more. */
export function forgetSent(orderId: string): void {
  const notes = load();
  if (!(orderId in notes)) return;
  delete notes[orderId];
  save(notes);
}
