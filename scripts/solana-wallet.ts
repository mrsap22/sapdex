// A stand-in for a Solana wallet, for the walks of the Rewards page's sign-in (scripts/rewards-walk.ts).
//
// It is put into the page before the page's own code runs, and announces itself the way wallets
// that follow the shared standard do. Its key is a real Ed25519 key made from fixed text, so its
// address is nobody's and holds nothing. It signs what it is handed, inside the page, and writes
// down everything it is asked: that the page looked for wallets at all, each "connect", each
// message it was given to sign, and any call to a feature the site must never use (signing or
// sending a transaction, the wallet's own "sign in", events, disconnecting).
//
// The same file says how to tell the site's wallet code from its other files: by what a file
// contains, not by what it is called.

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { base58 } from "@scure/base";
import type { BrowserContext, Page } from "playwright-core";

/** One stand-in wallet: the name it announces, its address, and its key. */
export interface StandIn {
  name: string;
  /** The address: the 32 bytes of the public key, written in base58. */
  address: string;
  publicKey: Buffer;
  privateKey: KeyObject;
  /** The private key as the browser's own signing takes it (PKCS8), in hex. */
  pkcs8: string;
}

/** One thing a stand-in was asked, as it wrote it down. */
export interface Ask {
  /** The wallet that was asked, or null for the page's looking for wallets at all. */
  wallet: string | null;
  /** "found" (the page announced that it is looking for wallets), or the name of the feature called. */
  ask: string;
  /** How many inputs the call was given. */
  inputs?: number;
  /** For a message to sign: the address it was to be signed with, the bytes in hex, and the signature given (hex), if one was. */
  account?: string;
  message?: string;
  signature?: string;
}

/** What a sign-in may ask of a wallet: that it be found, that it connect, and that it sign one message. */
export const ALLOWED_ASKS: ReadonlySet<string> = new Set(["found", "standard:connect", "solana:signMessage"]);

/** The features a stand-in offers and must never be asked for. A call to any of them is written down and answered with a refusal. */
export const NEVER_ASKED = ["solana:signTransaction", "solana:signAndSendTransaction", "solana:signIn", "standard:disconnect", "standard:events"] as const;

/** The first bytes of an Ed25519 private key written as PKCS8: the 32 bytes of the seed follow. */
const PKCS8_HEAD = "302e020100300506032b657004220420";

/** A stand-in whose key is made from the text given: the same text always gives the same wallet. */
export function standIn(name: string, text: string): StandIn {
  const pkcs8 = PKCS8_HEAD + createHash("sha256").update(text).digest("hex");
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8, "hex"), format: "der", type: "pkcs8" });
  // The public key written out for exchange is twelve bytes of heading and then the key itself.
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12));
  return { name, address: base58.encode(publicKey), publicKey, privateKey, pkcs8 };
}

/** True when the signature is this stand-in's own signature of exactly these bytes. */
export function signedBy(wallet: StandIn, message: Uint8Array, signature: Uint8Array): boolean {
  return signature.length === 64 && verify(null, message, createPublicKey(wallet.privateKey), signature);
}

/**
 * Puts the stand-ins into every page of the context, before the page's own code. Signing is done in
 * the page with the browser's own Ed25519 where it has it; where it has not, the page hands the
 * bytes to this script, which signs them with the same key.
 */
export async function addStandIns(context: BrowserContext, wallets: readonly StandIn[]): Promise<void> {
  await context.exposeFunction("__standInSigns", (name: string, hex: string): string => {
    const wallet = wallets.find((one) => one.name === name);
    if (wallet === undefined) throw new Error("no such stand-in");
    return sign(null, Buffer.from(hex, "hex"), wallet.privateKey).toString("hex");
  });
  await context.addInitScript(standInScript(wallets));
}

/** The stand-ins as the page runs them. Plain text, because it runs before anything else does. */
function standInScript(wallets: readonly StandIn[]): string {
  const given = JSON.stringify(wallets.map((wallet) => ({ name: wallet.name, address: wallet.address, publicKey: wallet.publicKey.toString("hex"), pkcs8: wallet.pkcs8 })));
  return `(() => {
    if (window.top !== window) return;
    const state = { mode: "accept", log: [] };
    window.__standIn = state;
    const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (pair) => parseInt(pair, 16));
    const refusal = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
    const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#444"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>');
    const signWith = async (spec, bytes) => {
      try {
        const key = await crypto.subtle.importKey("pkcs8", fromHex(spec.pkcs8), { name: "Ed25519" }, false, ["sign"]);
        return new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes));
      } catch {
        return fromHex(await window.__standInSigns(spec.name, toHex(bytes)));
      }
    };
    const made = ${given}.map((spec) => {
      const account = Object.freeze({ address: spec.address, publicKey: fromHex(spec.publicKey), chains: Object.freeze(["solana:mainnet"]), features: Object.freeze(["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction", "solana:signIn"]) });
      const never = (feature, call) => ({ version: "1.0.0", [call]: async (...inputs) => { state.log.push({ wallet: spec.name, ask: feature, inputs: inputs.length }); throw refusal(); } });
      return Object.freeze({
        version: "1.0.0",
        name: spec.name,
        icon,
        chains: Object.freeze(["solana:mainnet"]),
        accounts: Object.freeze([]),
        features: Object.freeze({
          "standard:connect": { version: "1.0.0", connect: async (...inputs) => { state.log.push({ wallet: spec.name, ask: "standard:connect", inputs: inputs.length }); return { accounts: [account] }; } },
          "solana:signMessage": {
            version: "1.1.0",
            signMessage: async (...inputs) => {
              const entries = inputs.map((input) => ({ wallet: spec.name, ask: "solana:signMessage", inputs: inputs.length, account: input && input.account ? input.account.address : "", message: input && input.message instanceof Uint8Array ? toHex(input.message) : "" }));
              state.log.push(...entries);
              if (inputs.length === 0) state.log.push({ wallet: spec.name, ask: "solana:signMessage", inputs: 0 });
              if (state.mode === "reject") throw refusal();
              const answers = [];
              for (const [index, input] of inputs.entries()) {
                const signature = await signWith(spec, input.message);
                entries[index].signature = toHex(signature);
                answers.push({ signedMessage: input.message, signature });
              }
              return answers;
            },
          },
          "solana:signTransaction": never("solana:signTransaction", "signTransaction"),
          "solana:signAndSendTransaction": never("solana:signAndSendTransaction", "signAndSendTransaction"),
          "solana:signIn": never("solana:signIn", "signIn"),
          "standard:disconnect": never("standard:disconnect", "disconnect"),
          "standard:events": { version: "1.0.0", on: (...inputs) => { state.log.push({ wallet: spec.name, ask: "standard:events", inputs: inputs.length }); return () => undefined; } },
        }),
      });
    });
    const hand = (api) => { api.register(...made); };
    // A page that says it is ready for wallets is one that is looking for them: written down, and answered.
    window.addEventListener("wallet-standard:app-ready", (event) => { state.log.push({ wallet: null, ask: "found" }); try { hand(event.detail); } catch {} });
    // And the wallet says that it is there, as one does on loading. Nothing is written down for a page that is not listening.
    const announce = () => window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api) => { state.log.push({ wallet: null, ask: "found" }); hand(api); } }));
    try { announce(); } catch {}
  })();`;
}

/** Everything the stand-ins on this page have been asked so far. Empty on a page that has none. */
export function asked(page: Page): Promise<Ask[]> {
  return page.evaluate(() => (window as unknown as { __standIn?: { log: Ask[] } }).__standIn?.log ?? []);
}

/** Tells the stand-ins to say yes, or to refuse as a person pressing "no" in a wallet's window does (error 4001). */
export function answerWith(page: Page, mode: "accept" | "reject"): Promise<void> {
  return page.evaluate((to) => {
    const state = (window as unknown as { __standIn?: { mode: string } }).__standIn;
    if (state !== undefined) state.mode = to;
  }, mode);
}

/** What only the code that speaks to a wallet contains: the names of the standard's two events. */
const WALLET_MARK = /wallet-standard:(app-ready|register-wallet)/;
const looked = new Map<string, Promise<boolean>>();

/**
 * Of the addresses given, the built scripts that hold the code that speaks to a wallet. Each
 * script is read (once) and judged by what it contains, whatever it is called.
 */
export async function walletCodeAmong(urls: Iterable<string>): Promise<string[]> {
  const found: string[] = [];
  for (const url of new Set(urls)) {
    const bare = url.split("?")[0] ?? url;
    if (!/\/assets\/[^/]+\.js$/.test(new URL(bare).pathname)) continue;
    let answer = looked.get(bare);
    if (answer === undefined) {
      answer = fetch(bare).then(async (reply) => WALLET_MARK.test(await reply.text()), () => false);
      looked.set(bare, answer);
    }
    if (await answer) found.push(new URL(bare).pathname);
  }
  return found;
}
