// Following a transfer after a wallet has sent it: is it in a block, did it fail, or did the
// wallet put another transaction in its place (a speed-up or a cancel)? Asked through the site's
// own chain route, a few small questions at a time. No wallet or chain library is needed, so a
// transfer can be followed again after a reload without loading any.

/** One read of the chain: a method name and its arguments in, the plain result out. Throws when the route cannot be reached. */
export type ChainRead = (method: string, params: unknown[]) => Promise<unknown>;

export type Sighting = "pending" | "mined" | "reverted" | "replaced";

/** What has been learned about the transfer so far: who sent it and under which number. */
export interface Known {
  from: string | null;
  nonce: bigint | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const quantity = (value: unknown): bigint | null => (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : null);

function verdict(receipt: unknown): Sighting | null {
  if (!isObject(receipt)) return null;
  // Only an explicit success counts as one. Anything else in a receipt is a failure.
  return receipt.status === "0x1" ? "mined" : "reverted";
}

/**
 * One look at a transfer.
 *
 * A wallet numbers its transactions. If the sender's count of included transactions has passed
 * this one's number and this one has no receipt, another transaction took its number: it was
 * replaced. Whether by a faster copy or by a cancel cannot be told from here.
 */
export async function lookAt(read: ChainRead, hash: string, known: Known): Promise<{ sighting: Sighting; known: Known }> {
  const first = verdict(await read("eth_getTransactionReceipt", [hash]));
  if (first !== null) return { sighting: first, known };

  let { from, nonce } = known;
  if (from === null || nonce === null) {
    const tx = await read("eth_getTransactionByHash", [hash]);
    if (isObject(tx) && typeof tx.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(tx.from)) {
      from = tx.from;
      nonce = quantity(tx.nonce);
    }
  }
  if (from === null || nonce === null) return { sighting: "pending", known: { from, nonce } };

  const included = quantity(await read("eth_getTransactionCount", [from, "latest"]));
  if (included === null || included <= nonce) return { sighting: "pending", known: { from, nonce } };
  // The number has been used. By this transfer, in the moment since the first question? Ask once more.
  const second = verdict(await read("eth_getTransactionReceipt", [hash]));
  return { sighting: second ?? "replaced", known: { from, nonce } };
}

export const WATCH_EVERY_MS = 5000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Follows a transfer until it is included, fails or is replaced. Stops without an answer when
 * `signal` is aborted. A look that cannot reach the chain is simply tried again.
 *
 * "Replaced" is only said when two looks in a row say so. The two questions behind it (the
 * receipt, and the sender's count) may be answered by different nodes, and one that is a block
 * ahead of the other would otherwise make a transfer that was just included look replaced.
 */
export async function watchTransfer(options: { read: ChainRead; hash: string; signal: AbortSignal; wait?(ms: number): Promise<void> }): Promise<Exclude<Sighting, "pending"> | null> {
  const wait = options.wait ?? pause;
  let known: Known = { from: null, nonce: null };
  let replacedBefore = false;
  while (!options.signal.aborted) {
    try {
      const look = await lookAt(options.read, options.hash, known);
      known = look.known;
      if (look.sighting === "mined" || look.sighting === "reverted") return options.signal.aborted ? null : look.sighting;
      if (look.sighting === "replaced" && replacedBefore) return options.signal.aborted ? null : "replaced";
      replacedBefore = look.sighting === "replaced";
    } catch {
      // The chain could not be asked just now.
    }
    await wait(WATCH_EVERY_MS);
  }
  return null;
}

/**
 * Keeps asking for a transfer's receipt, and nothing else, until there is one. Used after a
 * transfer has been called replaced: if it turns out to have been included after all, the page
 * must learn of it, however sure the earlier answer looked.
 */
export async function watchReceipt(options: { read: ChainRead; hash: string; signal: AbortSignal; wait?(ms: number): Promise<void> }): Promise<"mined" | "reverted" | null> {
  const wait = options.wait ?? pause;
  while (!options.signal.aborted) {
    try {
      const seen = verdict(await options.read("eth_getTransactionReceipt", [options.hash]));
      if (seen === "mined" || seen === "reverted") return options.signal.aborted ? null : seen;
    } catch {
      // The chain could not be asked just now.
    }
    await wait(WATCH_EVERY_MS);
  }
  return null;
}

/**
 * One last question about an earlier transfer, asked at the moment before a second one would be
 * sent. "included": it went through after all, so nothing more may be sent. "clear": it has no
 * receipt, or it failed. "unknown": the chain could not be asked, and a second transfer is not
 * sent on a guess.
 */
export async function lastLook(read: ChainRead, hash: string): Promise<"included" | "clear" | "unknown"> {
  try {
    return verdict(await read("eth_getTransactionReceipt", [hash])) === "mined" ? "included" : "clear";
  } catch {
    return "unknown";
  }
}

