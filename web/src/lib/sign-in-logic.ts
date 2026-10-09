// The steps of the Rewards page's sign-in, apart from the wallet library, so that they can be
// tested: wait for a connection that is being restored, connect where there is none, ask the
// wallet once, and say afterwards which of three things went wrong.
//
// A plain message needs no particular network. The wallet library checks the wallet's network
// before it asks anything, and stops there if the two disagree; the wallet is then asked directly,
// on whatever network it is, and is never asked to change it.

/** Why a sign-in did not happen: the person said no, the wallet could not be reached, or anything else. */
export type SignInFailure = "refused" | "locked" | "failed";

/** What the page says for each. */
export const SIGN_IN_WORDS: Record<SignInFailure, string> = {
  refused: "Nothing was signed, so you are not signed in.",
  locked: "Open your wallet and unlock it, then sign in again.",
  failed: "The wallet could not be asked to sign. Reconnect it and try again.",
};

/** A sign-in that did not happen, with its kind and the name of what was raised (never an address or a message). */
export class SignInError extends Error {
  readonly kind: SignInFailure;
  readonly raised: string;
  constructor(kind: SignInFailure, raised: string) {
    super(SIGN_IN_WORDS[kind]);
    this.name = "SignInError";
    this.kind = kind;
    this.raised = raised;
  }
}

interface Raised {
  name: string;
  code: unknown;
  message: string;
}

/** An error and whatever it says caused it, a few steps down: wallet libraries wrap the wallet's own answer. */
function trail(error: unknown): Raised[] {
  const out: Raised[] = [];
  let at: unknown = error;
  for (let depth = 0; depth < 6 && typeof at === "object" && at !== null; depth++) {
    const one = at as { name?: unknown; code?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    out.push({ name: typeof one.name === "string" ? one.name : "", code: one.code, message: `${typeof one.shortMessage === "string" ? one.shortMessage : ""} ${typeof one.message === "string" ? one.message : ""}` });
    at = one.cause;
  }
  return out;
}

/**
 * The name of what was raised, for the log, with the wallet's own code where it gave one:
 * "InvalidInputRpcError(-32000)". Letters, and a whole number: nothing else a wallet wrote can ride along.
 */
export function raisedName(error: unknown): string {
  if (error instanceof SignInError) return error.raised;
  const steps = trail(error);
  const name = steps[0]?.name.replace(/[^A-Za-z]/g, "").slice(0, 60) ?? "";
  const code = steps.map((step) => step.code).find((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  return `${name === "" ? "Unknown" : name}${code === undefined ? "" : `(${code})`}`;
}

/** True when a wallet threw the request out as badly formed, before asking the person anything. */
export function invalidInput(error: unknown): boolean {
  return trail(error).some((step) => step.code === -32000 || step.code === -32602 || /^(InvalidInputRpcError|InvalidParamsRpcError)$/.test(step.name));
}

/** Which of the three it was. The codes are the ones wallets answer with (EIP-1193 and JSON-RPC). */
export function failureOf(error: unknown): SignInFailure {
  if (error instanceof SignInError) return error.kind;
  const steps = trail(error);
  // The person closed the wallet's window or pressed its "no".
  if (steps.some((step) => step.code === 4001 || step.code === "ACTION_REJECTED" || step.name === "UserRejectedRequestError" || /user (rejected|denied|cancel)|(rejected|denied|cancell?ed|declined) by (the )?user|rejected the request|request (was )?rejected|was rejected|denied (message|request)|\bcancell?ed\b/i.test(step.message))) return "refused";
  // The wallet is locked, busy with a request it has not been answered, or gone.
  if (steps.some((step) => step.code === -32002 || step.code === 4100 || step.code === 4900 || step.code === 4901 || /^(ProviderDisconnectedError|ChainDisconnectedError|UnauthorizedProviderError|ResourceUnavailableRpcError)$/.test(step.name) || /\b(locked|unlock)\b|already pending|not been authorized/i.test(step.message))) return "locked";
  return "failed";
}

/** What the sign-in needs of a wallet. The real one is in wallet/sign-in.ts; a test hands in its own. */
export interface SignInWallet {
  /** "connected", "reconnecting", "connecting" or "disconnected". */
  status(): string;
  /** Resolves once a connection that is being made or restored has come to rest, one way or the other. */
  settled(): Promise<void>;
  /** Opens the way to connect a wallet, and resolves when the person is done with it. */
  connect(): Promise<void>;
  /** The wallet library's own way of asking for the signature. */
  direct(): Promise<string>;
  /** The connection's own wallet asked for the same signature, whatever network it is on. */
  ask(): Promise<string>;
  /** The connection's own wallet asked to sign the same sign-in in plain sentences. Null where the server sent none. */
  askPlain?: (() => Promise<string>) | null;
}

/**
 * Signs in: the signature, or a SignInError that says which of the three things went wrong.
 * The wallet is asked a second time only when the first asking failed for a reason other than
 * the person's own "no".
 */
export async function signInWith(wallet: SignInWallet): Promise<string> {
  // An address on the page may come from a connection that is still being restored: it is waited for.
  await wallet.settled();
  if (wallet.status() !== "connected") {
    await wallet.connect();
    await wallet.settled();
    if (wallet.status() !== "connected") throw new SignInError("failed", "NotConnected");
  }
  try {
    return await wallet.direct();
  } catch (first) {
    if (failureOf(first) === "refused") throw new SignInError("refused", raisedName(first));
    try {
      return await wallet.ask();
    } catch (second) {
      if (failureOf(second) === "refused") throw new SignInError("refused", raisedName(second));
      // The wallet threw the message out as badly formed, unseen: it reads messages of that layout and did not
      // like a line of it. It is asked once more, to sign the same sign-in in plain sentences.
      if (wallet.askPlain && (invalidInput(first) || invalidInput(second))) {
        try {
          return await wallet.askPlain();
        } catch (third) {
          throw new SignInError(failureOf(third), `${raisedName(first)}Then${raisedName(second)}Then${raisedName(third)}`);
        }
      }
      throw new SignInError(failureOf(second), `${raisedName(first)}Then${raisedName(second)}`);
    }
  }
}
