// The Rewards page's own state: what anyone may see (the week, its total of points, the pool), and, after a sign-in,
// one address's own points. The sign-in is kept in this page's memory only, never written down:
// closing or reloading the page ends it, and it ends by itself after half an hour.

import { create } from "zustand";
import { failureOf, raisedName, SIGN_IN_WORDS } from "../lib/sign-in-logic.ts";
import { partFailedToLoad } from "../lib/stale.ts";
import { toChecksumAddress } from "../../../shared/addresses.ts";
import { isSignInMessage, type RewardsPublic, type RewardsView } from "../../../shared/rewards.ts";
import { api, ApiError } from "../api.ts";

export type SignInStep = "idle" | "asking" | "signing" | "checking";

export interface RewardsState {
  summary: RewardsPublic | null;
  /** How far this device's clock is from the server's, in milliseconds, so that the countdown is right on a device whose clock is not. */
  clockOffset: number;
  summaryFailed: boolean;
  session: { address: string; token: string; expiresAt: number } | null;
  mine: RewardsView | null;
  step: SignInStep;
  /** One sentence for what went wrong, in plain words. */
  error: string | null;
  loadSummary(): Promise<void>;
  /** Signs in with the connected wallet's address: one message, one signature. */
  signIn(address: string): Promise<void>;
  signOut(): void;
  /** Reads the signed-in address's points again. Ends the sign-in when it has run out. */
  refresh(): Promise<void>;
}

export const useRewards = create<RewardsState>((set, get) => ({
  summary: null,
  clockOffset: 0,
  summaryFailed: false,
  session: null,
  mine: null,
  step: "idle",
  error: null,
  async loadSummary() {
    try {
      const summary = await api.rewards();
      const offset = Date.parse(summary.serverNow) - Date.now();
      set({ summary, summaryFailed: false, clockOffset: Number.isFinite(offset) ? offset : 0 });
    } catch {
      set({ summaryFailed: true });
    }
  },
  async signIn(address) {
    if (get().step !== "idle") return;
    set({ step: "asking", error: null });
    try {
      // The server sends the message to sign, and with it the parts it is made of.
      const code: { message: string; nonce: string; expiresAt: string; issuedAt?: unknown } = await api.rewardsCode(address);
      // Before the wallet is opened, the message is put together again here, for the site this page
      // is on and the address that is connected. If it is not, character for character, what the
      // server sent, the wallet is not asked to sign anything.
      const asking = /^0x[0-9a-fA-F]{40}$/.test(address) ? toChecksumAddress(address) : "";
      if (!isSignInMessage(code.message, { host: window.location.host, address: asking, nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt })) {
        set({ step: "idle", error: "That sign-in did not work. Try again." });
        return;
      }
      set({ step: "signing" });
      // The only signature this site asks for. The module that asks is loaded here and nowhere else.
      // If that module cannot be fetched (a page left open across a new version of the site), nothing is
      // said of the sign-in, which was never tried: the page loads itself again, or asks to be reloaded.
      let signPlainMessage: (message: string, address: string) => Promise<string>;
      try {
        ({ signPlainMessage } = await import("../wallet/sign-in.ts"));
      } catch {
        partFailedToLoad();
        set({ step: "idle", error: null });
        return;
      }
      let signature: string;
      try {
        signature = await signPlainMessage(code.message, address);
      } catch (error) {
        // Three things are told apart: the person said no, the wallet could not be reached, or it could not be asked.
        // What was raised is named in the console by its name alone, never with an address, so that it can be found.
        const kind = failureOf(error);
        // eslint-disable-next-line no-console -- the one line this site writes to the console: the name of what stopped a sign-in
        if (kind !== "refused") console.warn(`Rewards sign-in: ${raisedName(error)}`);
        set({ step: "idle", error: SIGN_IN_WORDS[kind] });
        return;
      }
      set({ step: "checking" });
      const session = await api.rewardsSession(code.nonce, signature);
      const mine = await api.rewardsMine(session.token);
      const lifetime = Date.parse(session.expiresAt) - Date.now() - get().clockOffset;
      set({ session: { address: session.address, token: session.token, expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 0) }, mine, step: "idle" });
      // The share is this address's points out of the week's total: the total is read again now, so that the two are of the same moment.
      void get().loadSummary();
    } catch (error) {
      const message = error instanceof ApiError && error.code === "rate_limited" ? "Too many tries. Wait a minute, then sign in again." : error instanceof ApiError && error.code === "network" ? "Can't reach the service. Check your connection, then sign in again." : "That sign-in did not work. Try again.";
      set({ step: "idle", error: message });
    }
  },
  signOut() {
    set({ session: null, mine: null, step: "idle", error: null });
  },
  async refresh() {
    const session = get().session;
    if (session === null) return;
    if (Date.now() >= session.expiresAt) {
      set({ session: null, mine: null });
      return;
    }
    try {
      const mine = await api.rewardsMine(session.token);
      if (get().session?.token === session.token) set({ mine });
    } catch (error) {
      if (error instanceof ApiError && error.code === "session") set({ session: null, mine: null });
    }
  },
}));
