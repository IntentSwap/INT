// Reads a response body with a hard byte cap, so a huge or endless reply
// from any outside service cannot fill memory.

export class TooLargeError extends Error {
  constructor() {
    super("response too large");
    this.name = "TooLargeError";
  }
}

export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLargeError();
  }
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCapped(res, maxBytes));
}
