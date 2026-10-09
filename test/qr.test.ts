import { describe, expect, it } from "vitest";
import { QUIET_ZONE, qrDrawing } from "../web/src/lib/qr.ts";

// Turns the drawing back into a grid of dark and light modules, to look at what was drawn.
function grid(text: string): boolean[][] {
  const { size, path } = qrDrawing(text);
  const cells = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, width, back] = match.slice(1).map(Number) as [number, number, number, number];
    expect(back).toBe(width);
    for (let i = 0; i < width; i++) cells[y]![x + i] = true;
  }
  return cells;
}

const ADDRESS = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";

describe("the QR code of a deposit address", () => {
  it("is square, with four modules of white all round", () => {
    const cells = grid(ADDRESS);
    const size = cells.length;
    expect(QUIET_ZONE).toBe(4);
    // A 42-character address at medium correction is a version 3 or 4 code: 29 or 33 modules, plus the border.
    expect([29 + 8, 33 + 8]).toContain(size);
    for (let i = 0; i < size; i++) {
      for (let edge = 0; edge < QUIET_ZONE; edge++) {
        expect(cells[edge]![i], `top ${edge},${i}`).toBe(false);
        expect(cells[size - 1 - edge]![i], `bottom ${edge},${i}`).toBe(false);
        expect(cells[i]![edge], `left ${i},${edge}`).toBe(false);
        expect(cells[i]![size - 1 - edge], `right ${i},${edge}`).toBe(false);
      }
    }
  });

  it("has the three corner squares every scanner looks for", () => {
    const cells = grid(ADDRESS);
    const size = cells.length;
    const finder = (top: number, left: number) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(cells[top + r]![left + c], `finder at ${top},${left}: ${r},${c}`).toBe(ring || core);
        }
      }
    };
    finder(QUIET_ZONE, QUIET_ZONE);
    finder(QUIET_ZONE, size - QUIET_ZONE - 7);
    finder(size - QUIET_ZONE - 7, QUIET_ZONE);
  });

  it("is the same every time, and differs when one character of the address differs", () => {
    expect(qrDrawing(ADDRESS)).toEqual(qrDrawing(ADDRESS));
    expect(qrDrawing(ADDRESS).path).not.toBe(qrDrawing(ADDRESS.toLowerCase()).path);
    expect(qrDrawing(ADDRESS).path).not.toBe(qrDrawing(`${ADDRESS.slice(0, -1)}4`).path);
  });

  it("takes the longest address the site accepts", () => {
    const long = `addr1${"q".repeat(98)}`;
    expect(qrDrawing(long).size).toBeGreaterThan(41);
  });
});
