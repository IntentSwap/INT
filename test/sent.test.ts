import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASKING_LASTS_MS, doneAsking, forgetSent, readSent, rememberAsking, rememberSent, sentFor, wasAsking, withSent } from "../web/src/stores/sent.ts";

const HASH = `0x${"ab".repeat(32)}`;
const ID = "A".repeat(27);

describe("the browser's note of a transfer it sent", () => {
  it("reads back what was written", () => {
    const notes = withSent({}, ID, { hash: HASH, at: 1_790_000_000_000 });
    expect(readSent(JSON.stringify(notes))).toEqual({ [ID]: { hash: HASH, at: 1_790_000_000_000 } });
  });

  it("takes nothing on trust from storage: anything out of shape is dropped", () => {
    for (const raw of [null, "", "not json", "[]", "5", '"x"', "null"]) expect(readSent(raw), String(raw)).toEqual({});
    const bad = {
      [ID]: { hash: "0x1234", at: 5 },
      "B/../x": { hash: HASH, at: 5 },
      C: { hash: HASH, at: "yesterday" },
      D: { hash: HASH, at: -1 },
      E: { hash: `${HASH}00`, at: 5 },
      F: null,
      G: { hash: HASH, at: 7, address: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83" },
    };
    // Only the well-formed one survives, and only its two known fields.
    expect(readSent(JSON.stringify(bad))).toEqual({ G: { hash: HASH, at: 7 } });
  });

  it("can say that the wallet was being asked, with or without an earlier transfer, but never nothing at all", () => {
    const asking = withSent({}, ID, { hash: null, at: 5, asking: true });
    expect(readSent(JSON.stringify(asking))).toEqual({ [ID]: { hash: null, at: 5, asking: true } });
    const both = withSent({}, ID, { hash: HASH, at: 5, asking: true });
    expect(readSent(JSON.stringify(both))).toEqual({ [ID]: { hash: HASH, at: 5, asking: true } });
    expect(readSent(JSON.stringify({ [ID]: { hash: null, at: 5 } }))).toEqual({});
    expect(readSent(JSON.stringify({ [ID]: { hash: null, at: 5, asking: "yes" } }))).toEqual({});
  });

  it("counts a wallet as still being asked for half an hour, and no longer", () => {
    expect(wasAsking({ hash: null, at: 1000, asking: true }, 2000)).toBe(true);
    expect(wasAsking({ hash: null, at: 1000, asking: true }, 1000 + ASKING_LASTS_MS)).toBe(false);
    expect(wasAsking({ hash: HASH, at: 1000 }, 2000)).toBe(false);
    expect(wasAsking(null, 2000)).toBe(false);
  });

  it("keeps one note per order, the latest, and only the newest twenty orders", () => {
    let notes = withSent({}, ID, { hash: HASH, at: 1 });
    notes = withSent(notes, ID, { hash: `0x${"cd".repeat(32)}`, at: 2 });
    expect(notes).toEqual({ [ID]: { hash: `0x${"cd".repeat(32)}`, at: 2 } });
    for (let i = 0; i < 30; i++) notes = withSent(notes, `order${i}`, { hash: HASH, at: 100 + i });
    expect(Object.keys(notes)).toHaveLength(20);
    expect(notes.order29).toBeDefined();
    expect(notes.order9).toBeUndefined();
    expect(notes[ID]).toBeUndefined();
  });
});

describe("the note, as the pay step writes it", () => {
  // The browser's storage, stood in for by a plain map.
  const kept = new Map<string, string>();
  const real = (globalThis as { localStorage?: unknown }).localStorage;
  beforeEach(() => {
    kept.clear();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), removeItem: (key: string) => void kept.delete(key) } });
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
  });

  it("asking the wallet a second time does not forget the first transfer", () => {
    rememberSent(ID, HASH, 100);
    expect(sentFor(ID)).toEqual({ hash: HASH, at: 100 });
    // The wallet is opened again (a deliberate second send): the first hash is still on the note.
    rememberAsking(ID, 200);
    expect(sentFor(ID)).toEqual({ hash: HASH, at: 200, asking: true });
    // The wallet answers without sending: back to what was known before, the first transfer.
    doneAsking(ID);
    expect(sentFor(ID)).toEqual({ hash: HASH, at: 200 });
    // So a reload at any of these moments finds a transfer on record, and does not offer a plain Send.
    expect(sentFor(ID)?.hash).toBe(HASH);
  });

  it("asking with nothing sent before leaves nothing behind when the wallet says no", () => {
    rememberAsking(ID, 300);
    expect(sentFor(ID)).toEqual({ hash: null, at: 300, asking: true });
    doneAsking(ID);
    expect(sentFor(ID)).toBeNull();
    expect(kept.size).toBe(0);
    // Saying "done" when nothing was being asked changes nothing.
    rememberSent(ID, HASH, 400);
    doneAsking(ID);
    expect(sentFor(ID)).toEqual({ hash: HASH, at: 400 });
    forgetSent(ID);
    expect(sentFor(ID)).toBeNull();
  });
});

