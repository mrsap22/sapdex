// The Rewards page's sign-in, from the wallet's side: which of the wallets a browser offers can
// sign in at all, connecting to one, asking it once for one signature of one plain message, and
// what is said when it does not happen. The wallets here are stand-ins that sign with real keys,
// so that what the page would send is checked by the server's own check.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { base58 } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { holdableKey, signedBy } from "../server/rewards.ts";
import { isSignInMessage, signInMessage, SIGN_IN_STATEMENT } from "../shared/rewards.ts";
import { connectFor, CONNECT_FEATURE, failureOf, NO_WALLET_WORDS, raisedName, SIGN_IN_WORDS, SIGN_MESSAGE_FEATURE, signFor, signInAccount, SignInError, signInWallets, toBase64, walletName } from "../web/src/lib/sign-in-logic.ts";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/** A Solana key made from fixed text, so it is nobody's: its address, its key as bytes, and a way to sign with it. */
function keyOf(label: string) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, createHash("sha256").update(`saplingdex sign-in test ${label}`).digest()]), format: "der", type: "pkcs8" });
  const publicKey = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12));
  return { address: base58.encode(publicKey), publicKey, sign: (bytes: Uint8Array) => new Uint8Array(sign(null, Buffer.from(bytes), privateKey)) };
}

const ALICE = keyOf("alice");
const BOB = keyOf("bob");

/** A wallet as it announces itself to a page by the shared standard. What it was asked is written down. */
function standardWallet(options: { name?: unknown; chains?: unknown; key?: ReturnType<typeof keyOf>; connect?: () => Promise<unknown>; signMessage?: (...inputs: unknown[]) => Promise<unknown>; features?: Record<string, unknown> } = {}) {
  const key = options.key ?? ALICE;
  const asked: string[] = [];
  const account = { address: key.address, publicKey: key.publicKey, chains: ["solana:mainnet"], features: [SIGN_MESSAGE_FEATURE] };
  const wallet = {
    version: "1.0.0",
    name: options.name === undefined ? "Stand-in Wallet" : options.name,
    icon: "data:image/svg+xml;base64,AAAA",
    chains: options.chains === undefined ? ["solana:mainnet", "solana:devnet"] : options.chains,
    accounts: [],
    features: {
      [CONNECT_FEATURE]: {
        version: "1.0.0",
        connect:
          options.connect ??
          (async () => {
            asked.push("connect");
            return { accounts: [account] };
          }),
      },
      [SIGN_MESSAGE_FEATURE]: {
        version: "1.0.0",
        signMessage:
          options.signMessage ??
          (async (...inputs: unknown[]) => {
            asked.push("signMessage");
            return inputs.map((input) => {
              const { message } = input as { message: Uint8Array };
              return { signedMessage: message, signature: key.sign(message) };
            });
          }),
      },
      // What a real wallet can also do. None of it is ever asked for here.
      "solana:signTransaction": { version: "1.0.0", signTransaction: async () => void asked.push("signTransaction") },
      "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: async () => void asked.push("signAndSendTransaction") },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => void asked.push("disconnect") },
      ...options.features,
    },
  };
  return { wallet, asked, account };
}

const PARTS = { host: "saplingdex.example", nonce: "ab".repeat(16), issuedAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-05T00:05:00.000Z" };
const messageFor = (address: string) => signInMessage({ ...PARTS, address });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("which wallets can sign in", () => {
  it("a Solana wallet that follows the shared standard, with a name, that can connect and can sign a message", () => {
    const { wallet } = standardWallet();
    const found = signInWallets([wallet]);
    expect(found.map((one) => one.name)).toEqual(["Stand-in Wallet"]);
    // What the page holds of it is its name and two things to ask: nothing else of the wallet can be reached through it.
    expect(Object.keys(found[0]!).sort()).toEqual(["connect", "name", "signMessage"]);
  });

  it("anything else that announces itself is left out: no name, not on Solana, or without either of the two features", () => {
    const without = (feature: string) => {
      const { wallet } = standardWallet();
      delete (wallet.features as Record<string, unknown>)[feature];
      return wallet;
    };
    const broken = (feature: string) => {
      const { wallet } = standardWallet();
      (wallet.features as Record<string, unknown>)[feature] = { version: "1.0.0" };
      return wallet;
    };
    const none = [null, undefined, "wallet", 7, [], {}, { name: "Empty", chains: ["solana:mainnet"] }, standardWallet({ name: "" }).wallet, standardWallet({ name: 5 }).wallet, standardWallet({ name: "<>&\"'" }).wallet, standardWallet({ chains: ["eip155:1"] }).wallet, standardWallet({ chains: ["solana:devnet"] }).wallet, standardWallet({ chains: "solana:mainnet" }).wallet, without(CONNECT_FEATURE), without(SIGN_MESSAGE_FEATURE), broken(CONNECT_FEATURE), broken(SIGN_MESSAGE_FEATURE)];
    expect(signInWallets(none)).toEqual([]);
    // One that can sign transactions but not messages is not a wallet this sign-in can use, and is never asked to sign one in its place.
    const { wallet: onlyTransactions, asked } = standardWallet();
    delete (onlyTransactions.features as Record<string, unknown>)[SIGN_MESSAGE_FEATURE];
    expect(signInWallets([onlyTransactions])).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("a wallet's name is shown as plain words: nothing it calls itself can bring markup, and two of one name are one choice", () => {
    expect(walletName("Phantom")).toBe("Phantom");
    expect(walletName("  Trust   Wallet (beta) ")).toBe("Trust Wallet (beta)");
    expect(walletName('<img src=x onerror="alert(1)">')).toBe("img srcx onerroralert(1)");
    expect(walletName("x".repeat(200))).toHaveLength(40);
    for (const not of [null, undefined, 5, {}, "", "   ", "<>"]) expect(walletName(not)).toBeNull();
    expect(signInWallets([standardWallet({ name: "Same" }).wallet, standardWallet({ name: "Same", key: BOB }).wallet, standardWallet({ name: "Other" }).wallet]).map((one) => one.name)).toEqual(["Same", "Other"]);
  });

  it("the account that signs in is plainly a Solana address: one that passes the site's own check, and whose key, written out, is that very address", () => {
    expect(signInAccount([{ address: ALICE.address, publicKey: ALICE.publicKey }])?.address).toBe(ALICE.address);
    // The first that is one, when a wallet gives several.
    expect(signInAccount([{ address: "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", publicKey: ALICE.publicKey }, { address: BOB.address, publicKey: BOB.publicKey }])?.address).toBe(BOB.address);
    // An address that is not its own key is no account: a wallet cannot sign in as an address it only names.
    expect(signInAccount([{ address: ALICE.address, publicKey: BOB.publicKey }])).toBeNull();
    expect(signInAccount([{ address: ALICE.address, publicKey: ALICE.publicKey.slice(0, 31) }])).toBeNull();
    expect(signInAccount([{ address: ` ${ALICE.address}`, publicKey: ALICE.publicKey }])).toBeNull();
    // A program's own address is nobody's wallet.
    expect(signInAccount([{ address: "11111111111111111111111111111111", publicKey: new Uint8Array(32) }])).toBeNull();
    expect(signInAccount([])).toBeNull();
  });
});

describe("the Rewards sign-in, step by step", () => {
  it("the wallet is asked to connect, then once to sign the server's message, and what it signed is what the server's own check accepts", async () => {
    const { wallet, asked } = standardWallet();
    const [found] = signInWallets([wallet]);
    const account = await connectFor(found!);
    expect(account.address).toBe(ALICE.address);
    const message = messageFor(account.address);
    expect(isSignInMessage(message, { ...PARTS, address: account.address })).toBe(true);
    const signature = await signFor(found!, account, message);
    expect(asked).toEqual(["connect", "signMessage"]);
    expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(signedBy(ALICE.address, message, signature)).toBe(true);
    // It is that address's signature of that text, and of nothing else.
    expect(signedBy(BOB.address, message, signature)).toBe(false);
    expect(signedBy(ALICE.address, `${message} `, signature)).toBe(false);
    expect(signedBy(ALICE.address, messageFor(BOB.address), signature)).toBe(false);
  });

  it("the message goes to the wallet as its own bytes and nothing else, with the account the wallet gave", async () => {
    const seen: unknown[][] = [];
    const { wallet, account } = standardWallet({
      signMessage: async (...inputs: unknown[]) => {
        seen.push(inputs);
        const { message } = inputs[0] as { message: Uint8Array };
        return [{ signedMessage: message, signature: ALICE.sign(message) }];
      },
    });
    const [found] = signInWallets([wallet]);
    const message = messageFor(ALICE.address);
    await signFor(found!, account, message);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    const input = seen[0]![0] as { account: unknown; message: Uint8Array };
    expect(Object.keys(input).sort()).toEqual(["account", "message"]);
    expect(input.account).toBe(account);
    expect(new TextDecoder().decode(input.message)).toBe(message);
    // The text begins with words. A Solana transaction is bytes that begin with a count of signatures: this cannot be taken for one.
    expect(message.startsWith("Sign in to SaplingDex at ")).toBe(true);
    expect(message).toContain(SIGN_IN_STATEMENT);
  });

  it("a wallet that says it signed anything other than the message has not signed in, and its answer goes nowhere", async () => {
    const other = new TextEncoder().encode(messageFor(BOB.address));
    const changed = standardWallet({ signMessage: async () => [{ signedMessage: other, signature: ALICE.sign(other) }] });
    const [found] = signInWallets([changed.wallet]);
    await expect(signFor(found!, changed.account, messageFor(ALICE.address))).rejects.toMatchObject({ name: "SignInError", kind: "failed", raised: "OtherMessageSigned" });
    // A longer text that only begins with the message is another text.
    const longer = new TextEncoder().encode(`${messageFor(ALICE.address)}\nAlso: something else`);
    const padded = standardWallet({ signMessage: async () => [{ signedMessage: longer, signature: ALICE.sign(longer) }] });
    await expect(signFor(signInWallets([padded.wallet])[0]!, padded.account, messageFor(ALICE.address))).rejects.toMatchObject({ raised: "OtherMessageSigned" });
  });

  it("an answer that is no signature is no sign-in: nothing, the wrong shape, or the wrong length", async () => {
    const message = messageFor(ALICE.address);
    const bytes = new TextEncoder().encode(message);
    for (const answer of [undefined, null, [], [{}], [{ signedMessage: bytes }], [{ signedMessage: bytes, signature: "abc" }], [{ signedMessage: Array.from(bytes), signature: ALICE.sign(bytes) }], { signedMessage: bytes, signature: ALICE.sign(bytes) }]) {
      const { wallet, account } = standardWallet({ signMessage: async () => answer });
      await expect(signFor(signInWallets([wallet])[0]!, account, message), JSON.stringify(answer)?.slice(0, 60)).rejects.toMatchObject({ kind: "failed", raised: "NoSignature" });
    }
    const short = standardWallet({ signMessage: async () => [{ signedMessage: bytes, signature: ALICE.sign(bytes).slice(0, 63) }] });
    await expect(signFor(signInWallets([short.wallet])[0]!, short.account, message)).rejects.toMatchObject({ kind: "failed", raised: "NoSignature" });
  });

  it("a wallet that gives no Solana account of its own cannot sign in", async () => {
    for (const accounts of [[], [{ address: "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", publicKey: new Uint8Array(20) }], [{ address: ALICE.address, publicKey: BOB.publicKey }], [{ address: ALICE.address }], "none"]) {
      const { wallet } = standardWallet({ connect: async () => ({ accounts }) });
      await expect(connectFor(signInWallets([wallet])[0]!)).rejects.toMatchObject({ kind: "failed", raised: "NoSolanaAccount" });
    }
    const { wallet } = standardWallet({ connect: async () => undefined });
    await expect(connectFor(signInWallets([wallet])[0]!)).rejects.toMatchObject({ raised: "NoSolanaAccount" });
  });

  it("a person who says no is told so, once, and is not asked again", async () => {
    const raised = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(typeof extra.message === "string" ? extra.message : name), { name, ...extra });
    let asks = 0;
    const saysNo = standardWallet({
      signMessage: async () => {
        asks += 1;
        throw raised("WalletSignMessageError", { code: 4001, message: "User rejected the request." });
      },
    });
    const failure = await signFor(signInWallets([saysNo.wallet])[0]!, saysNo.account, messageFor(ALICE.address)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SignInError);
    expect(failure).toMatchObject({ kind: "refused", raised: "WalletSignMessageError(4001)", message: SIGN_IN_WORDS.refused });
    expect(asks).toBe(1);
    // The same at the first step: closing the wallet's window before it connects.
    const closes = standardWallet({ connect: async () => Promise.reject(raised("Error", { message: "User rejected the request." })) });
    await expect(connectFor(signInWallets([closes.wallet])[0]!)).rejects.toMatchObject({ kind: "refused" });
  });

  it("tells a wallet that is locked or gone from one that could not be asked, and names what was raised without anything a wallet wrote", () => {
    const raised = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(typeof extra.message === "string" ? extra.message : name), { name, ...extra });
    expect(failureOf(raised("Error", { message: "Wallet is locked" }))).toBe("locked");
    expect(failureOf(raised("Error", { code: -32002, message: "Request already pending" }))).toBe("locked");
    expect(failureOf(raised("Error", { code: 4900, message: "Disconnected" }))).toBe("locked");
    expect(failureOf(raised("TypeError", { message: "x is not a function" }))).toBe("failed");
    expect(failureOf("nothing at all")).toBe("failed");
    expect(failureOf(new SignInError("locked", "Whatever"))).toBe("locked");
    // What is logged is a name, and the wallet's own code as a whole number: letters and digits, and nothing else it wrote.
    expect(raisedName(raised(`${ALICE.address} <b>`))).toMatch(/^[A-Za-z]{1,60}$/);
    expect(raisedName(raised("WalletSignMessageError", { code: -32603, message: ALICE.address }))).toBe("WalletSignMessageError(-32603)");
    expect(raisedName(raised("Outer", { cause: raised("Inner", { code: 4001 }) }))).toBe("Outer(4001)");
    expect(raisedName(null)).toBe("Unknown");
    expect(raisedName(raised("X", { code: "4001; drop" }))).toBe("X");
  });

  it("knows a refusal in the words wallets use for one, so that nobody who said no is told their wallet failed", () => {
    for (const words of ["User rejected the request.", "User denied message signature", "Request rejected", "The request was rejected by the user", "Transaction cancelled by user", "Approval was rejected", "user cancelled"]) expect(failureOf(new Error(words)), words).toBe("refused");
    expect(failureOf(Object.assign(new Error("anything"), { code: 4001 }))).toBe("refused");
    expect(failureOf(new Error("Something went wrong"))).toBe("failed");
  });

  it("says one of three things, and none of them blames the person for what a wallet did; and a fourth where there is no wallet", () => {
    expect(Object.keys(SIGN_IN_WORDS).sort()).toEqual(["failed", "locked", "refused"]);
    for (const words of [...Object.values(SIGN_IN_WORDS), NO_WALLET_WORDS]) {
      expect(words).toMatch(/^[A-Z].*\.$/);
      expect(words).not.toMatch(/you (failed|must|did not)|error|invalid|0x|transaction/i);
      expect(words.length).toBeLessThanOrEqual(120);
    }
    expect(NO_WALLET_WORDS).toMatch(/No Solana wallet was found/);
  });

  it("writes a signature out as the server reads one", () => {
    expect(toBase64(new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]))).toBe(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]).toString("base64"));
    const signature = ALICE.sign(new TextEncoder().encode("x"));
    expect(toBase64(signature)).toBe(Buffer.from(signature).toString("base64"));
  });
});

describe("the server's check of a signature", () => {
  const message = messageFor(ALICE.address);
  const good = toBase64(ALICE.sign(new TextEncoder().encode(message)));

  it("passes only that address's own signature of exactly that text", () => {
    expect(signedBy(ALICE.address, message, good)).toBe(true);
    expect(signedBy(BOB.address, message, good)).toBe(false);
    expect(signedBy(ALICE.address, message.replace("Code: ab", "Code: ac"), good)).toBe(false);
    expect(signedBy(ALICE.address, message.toLowerCase(), good)).toBe(false);
    expect(signedBy(ALICE.address, "", good)).toBe(false);
    // Bob's own signature of a message that names Alice signs nobody in as Alice.
    expect(signedBy(ALICE.address, message, toBase64(BOB.sign(new TextEncoder().encode(message))))).toBe(false);
  });

  it("refuses whatever is not a signature of the right size, written the one way a signature is", () => {
    const raw = Buffer.from(good, "base64");
    for (const not of [undefined, null, 5, {}, "", "abc", good.slice(0, -4), `${good}AAAA`, good.replace(/=+$/, ""), ` ${good}`, raw.toString("hex"), `0x${raw.toString("hex")}`, raw.toString("base64url"), base58.encode(raw), [good]]) expect(signedBy(ALICE.address, message, not), String(not).slice(0, 40)).toBe(false);
    // One bit of it changed.
    const flipped = Buffer.from(raw);
    flipped[10] = flipped[10]! ^ 1;
    expect(signedBy(ALICE.address, message, flipped.toString("base64"))).toBe(false);
    expect(signedBy(ALICE.address, message, Buffer.alloc(64).toString("base64"))).toBe(false);
  });

  it("refuses an address that is not a Solana address exactly as written", () => {
    for (const not of ["", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", ` ${ALICE.address}`, `${ALICE.address} `, ALICE.address.slice(1), ALICE.address.toLowerCase(), "11111111111111111111111111111111"]) expect(signedBy(not, message, good), not).toBe(false);
  });

  it("a signature over a transaction is no sign-in: what a wallet signs when it signs a transaction is other bytes", () => {
    // The bytes a wallet signs for a transaction are the transaction's message: a header of three counts, then keys. Never this text.
    const transaction = Buffer.concat([Buffer.from([1, 0, 1, 2]), Buffer.from(ALICE.publicKey), Buffer.alloc(32), Buffer.alloc(32, 7), Buffer.from([1, 1, 1, 0, 0])]);
    const overTransaction = toBase64(ALICE.sign(transaction));
    expect(signedBy(ALICE.address, message, overTransaction)).toBe(false);
    // And the text itself cannot be read as one: its first byte would be a count of 83 signatures that are not there.
    expect(Buffer.from(message, "utf8")[0]).toBe("S".charCodeAt(0));
  });
});

describe("an address nobody can hold the key of signs nobody in", () => {
  const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((byte) => parseInt(byte, 16)));
  // The eight points of small order on the curve, each as it is written, and other spellings of them that some checks take.
  // For any of these a "signature" can be made up with no key at all: the usual check passes by arithmetic alone.
  const NOBODYS = [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "0100000000000000000000000000000000000000000000000000000000000080",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  ];

  it("a point of small order, or a key not written the one way a key is written, is no key anyone holds", () => {
    for (const key of NOBODYS) expect(holdableKey(hex(key)), key).toBe(false);
    for (const length of [0, 31, 33, 64]) expect(holdableKey(new Uint8Array(length))).toBe(false);
    // Bytes that are no point of the curve at all.
    expect(holdableKey(hex("0200000000000000000000000000000000000000000000000000000000000000"))).toBe(false);
  });

  it("every real key is one somebody can hold", () => {
    expect(holdableKey(ALICE.publicKey)).toBe(true);
    expect(holdableKey(BOB.publicKey)).toBe(true);
    for (let made = 0; made < 200; made++) expect(holdableKey(new Uint8Array(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(12)))).toBe(true);
  });

  it("the made-up signature that passes for such an address by arithmetic alone signs nobody in, for any text", () => {
    const madeUp = Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]).toString("base64");
    const nobody = (key: string) => base58.encode(hex(key));
    for (const key of NOBODYS) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const text = signInMessage({ ...PARTS, nonce: attempt.toString(16).padStart(32, "0"), address: nobody(key) });
        expect(signedBy(nobody(key), text, madeUp), `${key} ${attempt}`).toBe(false);
        expect(signedBy(nobody(key), text, Buffer.alloc(64).toString("base64")), key).toBe(false);
      }
    }
  });
});

describe("listening for wallets, in the browser", () => {
  /** A window that keeps what listens to it and what is sent on it. */
  function fakeWindow() {
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    const sent: { type: string; detail: unknown }[] = [];
    const window = {
      addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        sent.push({ type: event.type, detail: event.detail });
        for (const listener of listeners.get(event.type) ?? []) listener(event);
        return true;
      },
    };
    return { window, listeners, sent };
  }
  class FakeEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init: { detail: unknown }) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  it("says the page is ready, hears each wallet that announces itself, before or after, and offers the ones that can sign in", async () => {
    const { window, listeners, sent } = fakeWindow();
    // A wallet that was there before the page: it registers when the page says it is ready.
    const early = standardWallet({ name: "Early" });
    window.addEventListener("wallet-standard:app-ready", (event) => (event as { detail: { register(wallet: unknown): unknown } }).detail.register(early.wallet));
    vi.stubGlobal("window", window);
    vi.stubGlobal("CustomEvent", FakeEvent);
    const { findWallets } = await import("../web/src/solana/sign-in.ts");
    expect(findWallets().map((one) => one.name)).toEqual(["Early"]);
    expect(sent.map((event) => event.type)).toEqual(["wallet-standard:app-ready"]);
    // What a wallet is handed can add it to the list, and nothing else.
    expect(Object.keys(sent[0]!.detail as object)).toEqual(["register"]);
    expect(Object.isFrozen(sent[0]!.detail)).toBe(true);
    // A wallet that loads later announces itself with an event that carries a function; it is called with the way to register.
    const late = standardWallet({ name: "Late", key: BOB });
    for (const listener of listeners.get("wallet-standard:register-wallet") ?? []) listener({ type: "wallet-standard:register-wallet", detail: (api: { register(wallet: unknown): unknown }) => api.register(late.wallet) });
    expect(findWallets().map((one) => one.name)).toEqual(["Early", "Late"]);
    // Asking again says "ready" no second time, and lists nobody twice.
    for (const listener of listeners.get("wallet-standard:register-wallet") ?? []) listener({ type: "wallet-standard:register-wallet", detail: (api: { register(wallet: unknown): unknown }) => api.register(late.wallet) });
    expect(findWallets()).toHaveLength(2);
    expect(sent).toHaveLength(1);
    // Nothing was asked of either wallet by being found.
    expect([...early.asked, ...late.asked]).toEqual([]);
  });

  it("a thing that announces itself badly is simply not on the list, and stops nothing", async () => {
    const { window, listeners } = fakeWindow();
    vi.stubGlobal("window", window);
    vi.stubGlobal("CustomEvent", FakeEvent);
    const { findWallets } = await import("../web/src/solana/sign-in.ts");
    expect(findWallets()).toEqual([]);
    const announce = (detail: unknown) => {
      for (const listener of listeners.get("wallet-standard:register-wallet") ?? []) listener({ type: "wallet-standard:register-wallet", detail });
    };
    announce(null);
    announce("register me");
    announce(() => {
      throw new Error("a wallet that breaks as it registers");
    });
    announce((api: { register(...wallets: unknown[]): unknown }) => api.register({ name: "Not a wallet" }, 5, null));
    expect(findWallets()).toEqual([]);
    const good = standardWallet({ name: "Good" });
    announce((api: { register(wallet: unknown): unknown }) => api.register(good.wallet));
    expect(findWallets().map((one) => one.name)).toEqual(["Good"]);
  });

  it("is the whole of the wallet code: one small file that speaks to no address and keeps nothing", () => {
    const source = fs.readFileSync(path.resolve("web", "src", "solana", "sign-in.ts"), "utf8");
    const code = source.replace(/\/\/[^\n]*/g, "");
    expect(code.split("\n").filter((line) => line.trim() !== "").length).toBeLessThan(50);
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|import\(|localStorage|sessionStorage|document\.|https?:/);
    // It never asks a wallet for anything itself: it only hears them. What may be asked is decided in the steps.
    expect(code).not.toMatch(/\.connect\(|signMessage|\.features\b/);
  });
});
