// A QR code as a drawing: which squares are dark. The drawing itself is done in components/QrCode.tsx.

import qrcode from "qrcode-generator";

/** Modules of white around the code. Scanners need it; the standard asks for four. */
export const QUIET_ZONE = 4;

export interface QrDrawing {
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** One SVG path covering every dark module. */
  path: string;
}

/**
 * The QR code of a piece of text. The text is stored byte for byte, with medium error correction:
 * an address must come out of a scanner exactly as it went in, capitals included.
 */
export function qrDrawing(text: string): QrDrawing {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row++) {
    // Runs of dark modules in a row become one rectangle each: fewer shapes, no hairlines between squares.
    let start = -1;
    for (let col = 0; col <= count; col++) {
      const dark = col < count && code.isDark(row, col);
      if (dark && start === -1) start = col;
      if (!dark && start !== -1) {
        parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`);
        start = -1;
      }
    }
  }
  return { size: count + 2 * QUIET_ZONE, path: parts.join("") };
}
