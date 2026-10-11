// The steps of the Rewards page's sign-in, apart from the browser, so that they can be tested:
// which of the wallets a browser offers can sign in at all, connecting to one, asking it once for
// one signature of one plain message, and saying afterwards which of three things went wrong.
//
// The wallets are Solana wallets that follow the standard they share (the "Wallet Standard"): each
// announces itself to the page with a name and a list of what it can do. This sign-in uses two of
// those things and no others: "standard:connect", which gives the address, and "solana:signMessage",
// which signs text. It never asks a wallet to sign or send a transaction, and nothing here names
// the features that would.

import { base58 } from "@scure/base";
import { checkAddress } from "../../../shared/addresses.ts";

/** Why a sign-in did not happen: the person said no, the wallet could not be reached, or anything else. */
export type SignInFailure = "refused" | "locked" | "failed";

/** What the page says for each. */
export const SIGN_IN_WORDS: Record<SignInFailure, string> = {
  refused: "Nothing was signed, so you are not signed in.",
  locked: "Open your wallet and unlock it, then sign in again.",
  failed: "The wallet could not be asked to sign. Try again, or use another wallet.",
};

/** What the page says where the browser has no Solana wallet that can sign a message. */
export const NO_WALLET_WORDS = "No Solana wallet was found in this browser. Install one, or open this page in your wallet's own browser.";

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

/** An error and whatever it says caused it, a few steps down: a wallet may wrap its own answer. */
function trail(error: unknown): Raised[] {
  const out: Raised[] = [];
  let at: unknown = error;
  for (let depth = 0; depth < 6 && typeof at === "object" && at !== null; depth++) {
    const one = at as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    out.push({ name: typeof one.name === "string" ? one.name : "", code: one.code, message: typeof one.message === "string" ? one.message : "" });
    at = one.cause;
  }
  return out;
}

/**
 * The name of what was raised, for the log, with the wallet's own code where it gave one:
 * "WalletSignMessageError(4001)". Letters, and a whole number: nothing else a wallet wrote can ride along.
 */
export function raisedName(error: unknown): string {
  if (error instanceof SignInError) return error.raised;
  const steps = trail(error);
  const name = steps[0]?.name.replace(/[^A-Za-z]/g, "").slice(0, 60) ?? "";
  const code = steps.map((step) => step.code).find((value): value is number => typeof value === "number" && Number.isSafeInteger(value));
  return `${name === "" ? "Unknown" : name}${code === undefined ? "" : `(${code})`}`;
}

/** Which of the three it was. The codes are the ones wallets answer with. */
export function failureOf(error: unknown): SignInFailure {
  if (error instanceof SignInError) return error.kind;
  const steps = trail(error);
  // The person closed the wallet's window or pressed its "no".
  if (steps.some((step) => step.code === 4001 || /^(UserRejectedRequestError|WalletSignMessageError|WalletConnectionError)$/.test(step.name) && /reject|denied|cancel|declin|closed/i.test(step.message) || /user (rejected|denied|cancel)|(rejected|denied|cancell?ed|declined) by (the )?user|rejected the request|request (was )?rejected|was rejected/i.test(step.message))) return "refused";
  // The wallet is locked, busy with a request it has not been answered, or gone.
  if (steps.some((step) => step.code === -32002 || step.code === 4100 || step.code === 4900 || /\b(locked|unlock|already pending|not connected|disconnected)\b/i.test(step.message))) return "locked";
  return "failed";
}

/** One account of a wallet, as the standard gives it: its address in base58 and the same key as bytes. */
export interface WalletAccount {
  address: string;
  publicKey: Uint8Array;
}

/** A Solana wallet as this sign-in sees one: its name, and the two things it is asked to do. */
export interface SignInWallet {
  name: string;
  connect(): Promise<readonly WalletAccount[]>;
  signMessage(account: WalletAccount, message: Uint8Array): Promise<{ signedMessage: Uint8Array; signature: Uint8Array }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

/** The two features this sign-in uses, by the names the standard gives them. */
export const CONNECT_FEATURE = "standard:connect";
export const SIGN_MESSAGE_FEATURE = "solana:signMessage";

/** A wallet's name as the page shows it: letters, digits, spaces and a few marks, forty characters at most. Whatever else a wallet called itself is not shown. */
export function walletName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const plain = name.replace(/[^\p{L}\p{N} ._()-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return plain === "" ? null : plain;
}

/**
 * Of whatever announced itself to the page as a wallet, the ones this sign-in can use: a Solana
 * wallet with a name that can connect and can sign a message. Each is wrapped so that only those
 * two things can be asked of it from here on; a wallet's other features are out of reach.
 */
export function signInWallets(announced: readonly unknown[]): SignInWallet[] {
  const out: SignInWallet[] = [];
  for (const wallet of announced) {
    if (!isRecord(wallet) || !isRecord(wallet.features)) continue;
    const name = walletName(wallet.name);
    const chains = Array.isArray(wallet.chains) ? (wallet.chains as unknown[]) : [];
    const connect = wallet.features[CONNECT_FEATURE];
    const sign = wallet.features[SIGN_MESSAGE_FEATURE];
    if (name === null || !chains.some((chain) => chain === "solana:mainnet")) continue;
    if (!isRecord(connect) || typeof connect.connect !== "function" || !isRecord(sign) || typeof sign.signMessage !== "function") continue;
    // Two wallets of one name are one choice: the first stands.
    if (out.some((held) => held.name === name)) continue;
    const doConnect = connect.connect as (input?: unknown) => Promise<unknown>;
    const doSign = sign.signMessage as (...inputs: unknown[]) => Promise<unknown>;
    out.push({
      name,
      async connect() {
        const answer = await doConnect.call(connect);
        const accounts = isRecord(answer) && Array.isArray(answer.accounts) ? (answer.accounts as unknown[]) : [];
        return accounts.filter((account): account is WalletAccount => isRecord(account) && typeof account.address === "string" && isBytes(account.publicKey));
      },
      async signMessage(account, message) {
        const answer = await doSign.call(sign, { account, message });
        const first: unknown = Array.isArray(answer) ? answer[0] : null;
        if (!isRecord(first) || !isBytes(first.signedMessage) || !isBytes(first.signature)) throw new SignInError("failed", "NoSignature");
        return { signedMessage: first.signedMessage, signature: first.signature };
      },
    });
  }
  return out;
}

/**
 * The first of a wallet's accounts that is plainly a Solana address: one that passes the site's own
 * check, and whose key, written out, is that very address. Null when there is none.
 */
export function signInAccount(accounts: readonly WalletAccount[]): WalletAccount | null {
  for (const account of accounts) {
    const check = checkAddress("sol", account.address);
    if (!check.ok || check.address !== account.address) continue;
    if (account.publicKey.length !== 32 || base58.encode(account.publicKey) !== account.address) continue;
    return account;
  }
  return null;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Bytes in base64, as the server takes a signature. */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/**
 * Connects to a wallet and gives the account that will sign in. A SignInError says which of the
 * three things went wrong.
 */
export async function connectFor(wallet: SignInWallet): Promise<WalletAccount> {
  let accounts: readonly WalletAccount[];
  try {
    accounts = await wallet.connect();
  } catch (error) {
    throw new SignInError(failureOf(error), raisedName(error));
  }
  const account = signInAccount(accounts);
  if (account === null) throw new SignInError("failed", "NoSolanaAccount");
  return account;
}

/**
 * Asks the wallet, once, to sign the server's message with the account, and gives the signature in
 * base64. The message is handed over as its bytes and nothing else. What the wallet says it signed
 * must be those same bytes: a wallet that signed anything else has not signed in, and its answer
 * is not sent anywhere.
 */
export async function signFor(wallet: SignInWallet, account: WalletAccount, message: string): Promise<string> {
  const bytes = new TextEncoder().encode(message);
  let answer: { signedMessage: Uint8Array; signature: Uint8Array };
  try {
    answer = await wallet.signMessage(account, bytes);
  } catch (error) {
    throw new SignInError(failureOf(error), raisedName(error));
  }
  if (!sameBytes(answer.signedMessage, bytes)) throw new SignInError("failed", "OtherMessageSigned");
  if (answer.signature.length !== 64) throw new SignInError("failed", "NoSignature");
  return toBase64(answer.signature);
}
