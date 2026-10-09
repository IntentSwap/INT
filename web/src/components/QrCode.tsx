import { useMemo } from "react";
import { qrDrawing } from "../lib/qr.ts";

/**
 * A QR code of an address, for scanning with a phone wallet. Always black on white with a white
 * border, in both themes: that is what scanners read best.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const drawing = useMemo(() => qrDrawing(value), [value]);
  return (
    <svg className="qr" viewBox={`0 0 ${drawing.size} ${drawing.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="qr-paper" width={drawing.size} height={drawing.size} />
      <path className="qr-ink" d={drawing.path} />
    </svg>
  );
}
