// The one place on this site where a wallet is spoken to at all: the sign-in of the Rewards page,
// by which a person shows that a Solana address is theirs before its points are shown to them.
// It is one plain message, made by the server and shown by the wallet in words. It is not a
// transaction: it moves nothing, approves nothing and costs no network fee.
//
// This file is fetched only when "Sign in" is pressed on the Rewards page, and never in Ghost mode
// (a test holds both). It loads no library and asks no address for anything: wallets that follow
// the shared standard announce themselves to the page, and this listens for them. What may be
// asked of a wallet is decided in lib/sign-in-logic.ts: to connect, and to sign text.

import { signInWallets, type SignInWallet } from "../lib/sign-in-logic.ts";

/** The two events of the standard: the page says it is ready, and a wallet says it is there. */
const APP_READY = "wallet-standard:app-ready";
const REGISTER = "wallet-standard:register-wallet";

/** Everything that has announced itself to this page as a wallet, in the order it did. */
const announced: unknown[] = [];
let listening = false;

function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  // What a wallet is handed to register itself with. It can add itself to the list, and that is all.
  const api = Object.freeze({
    register: (...wallets: unknown[]) => {
      for (const wallet of wallets) if (!announced.includes(wallet)) announced.push(wallet);
      return () => undefined;
    },
  });
  // A wallet that loads after the page announces itself with an event that carries a function: it is called with the way to register.
  window.addEventListener(REGISTER, (event) => {
    const hand: unknown = (event as CustomEvent<unknown>).detail;
    try {
      if (typeof hand === "function") (hand as (given: typeof api) => void)(api);
    } catch {
      // A wallet that fails to register is simply not on the list.
    }
  });
  // A wallet that loaded before the page is told the page is ready, and registers then.
  try {
    window.dispatchEvent(new CustomEvent(APP_READY, { detail: api }));
  } catch {
    // Nothing answers: there is no wallet.
  }
}

/** The Solana wallets in this browser that can sign in, by name. Empty when there is none. */
export function findWallets(): SignInWallet[] {
  listen();
  return signInWallets(announced);
}
