// The Rewards page's own state: what anyone may see (the week, its total of points, the pool), and, after a sign-in,
// one address's own points. The sign-in is kept in this page's memory only, never written down:
// closing or reloading the page ends it, and it ends by itself after half an hour.

import { create } from "zustand";
import { ghostHolds } from "../lib/kept.ts";
import { connectFor, failureOf, NO_WALLET_WORDS, raisedName, signFor, SIGN_IN_WORDS, type SignInWallet } from "../lib/sign-in-logic.ts";
import { partFailedToLoad } from "../lib/stale.ts";
import { isSignInMessage, type RewardsPublic, type RewardsView } from "../../../shared/rewards.ts";
import { api, ApiError } from "../api.ts";

/** Where a sign-in stands: nothing under way, a choice of wallets on show, the wallet being connected, the wallet asked to sign, the server checking. */
export type SignInStep = "idle" | "choosing" | "connecting" | "signing" | "checking";

export interface RewardsState {
  summary: RewardsPublic | null;
  /** How far this device's clock is from the server's, in milliseconds, so that the countdown is right on a device whose clock is not. */
  clockOffset: number;
  summaryFailed: boolean;
  session: { address: string; token: string; expiresAt: number } | null;
  mine: RewardsView | null;
  step: SignInStep;
  /** The wallets to choose from, by name, while more than one could sign in. Empty at every other time. */
  wallets: string[];
  /** One sentence for what went wrong, in plain words. */
  error: string | null;
  loadSummary(): Promise<void>;
  /** Starts a sign-in: finds the Solana wallets in this browser. With one, it is asked; with several, they are offered by name. */
  signIn(): Promise<void>;
  /** Signs in with the wallet of that name, from the ones offered: one message, one signature. */
  choose(name: string): Promise<void>;
  signOut(): void;
  /** Reads the signed-in address's points again. Ends the sign-in when it has run out. */
  refresh(): Promise<void>;
}

/** The wallets found by the last press of "Sign in", kept while one is chosen. In memory only. */
let found: SignInWallet[] = [];

export const useRewards = create<RewardsState>((set, get) => {
  /** The sign-in itself, with one wallet: connect, the server's message for the address, one signature, the server's check. */
  async function signInWith(wallet: SignInWallet): Promise<void> {
    set({ step: "connecting", error: null, wallets: [] });
    try {
      let signature: string;
      let nonce: string;
      try {
        const account = await connectFor(wallet);
        // The server sends the message to sign, and with it the parts it is made of.
        const code = await api.rewardsCode(account.address);
        // Before the wallet is asked, the message is put together again here, for the site this page
        // is on and the address the wallet gave. If it is not, character for character, what the
        // server sent, the wallet is not asked to sign anything.
        if (!isSignInMessage(code.message, { host: window.location.host, address: account.address, nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt })) {
          set({ step: "idle", error: "That sign-in did not work. Try again." });
          return;
        }
        // The mode may have been turned on while the wallet or the server was being asked: nothing is signed then.
        if (ghostHolds()) {
          set({ step: "idle", error: null });
          return;
        }
        set({ step: "signing" });
        signature = await signFor(wallet, account, code.message);
        nonce = code.nonce;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // Three things are told apart: the person said no, the wallet could not be reached, or it could not be asked.
        // What was raised is named in the console by its name alone, never with an address, so that it can be found.
        const kind = failureOf(error);
        // eslint-disable-next-line no-console -- the one line this site writes to the console: the name of what stopped a sign-in
        if (kind !== "refused") console.warn(`Rewards sign-in: ${raisedName(error)}`);
        set({ step: "idle", error: SIGN_IN_WORDS[kind] });
        return;
      }
      set({ step: "checking" });
      const session = await api.rewardsSession(nonce, signature);
      const mine = await api.rewardsMine(session.token);
      const lifetime = Date.parse(session.expiresAt) - Date.now() - get().clockOffset;
      set({ session: { address: session.address, token: session.token, expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 0) }, mine, step: "idle" });
      // The share is this address's points out of the week's total: the total is read again now, so that the two are of the same moment.
      void get().loadSummary();
    } catch (error) {
      const message = error instanceof ApiError && error.code === "rate_limited" ? "Too many tries. Wait a minute, then sign in again." : error instanceof ApiError && error.code === "network" ? "Can't reach the service. Check your connection, then sign in again." : "That sign-in did not work. Try again.";
      set({ step: "idle", error: message });
    }
  }

  return {
    summary: null,
    clockOffset: 0,
    summaryFailed: false,
    session: null,
    mine: null,
    step: "idle",
    wallets: [],
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
    async signIn() {
      // In Ghost mode no wallet is spoken to, and the code that would is not fetched: nothing is asked of the server either.
      if (ghostHolds()) return;
      if (get().step !== "idle" && get().step !== "choosing") return;
      set({ error: null });
      let findWallets: () => SignInWallet[];
      try {
        ({ findWallets } = await import("../solana/sign-in.ts"));
      } catch {
        partFailedToLoad();
        return;
      }
      // The mode may have been turned on while the code was on its way: no wallet is looked for then.
      if (ghostHolds()) return;
      found = findWallets();
      if (found.length === 0) {
        set({ step: "idle", wallets: [], error: NO_WALLET_WORDS });
        return;
      }
      if (found.length === 1) {
        await signInWith(found[0]!);
        return;
      }
      set({ step: "choosing", wallets: found.map((wallet) => wallet.name) });
    },
    async choose(name) {
      if (ghostHolds() || get().step !== "choosing") return;
      const wallet = found.find((one) => one.name === name);
      if (wallet === undefined) return;
      await signInWith(wallet);
    },
    signOut() {
      found = [];
      set({ session: null, mine: null, step: "idle", wallets: [], error: null });
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
  };
});
