// Small rules, each of which another rule nearly hides: a fee split that does not add up, a key
// written a second way, a mint that reports nonsense, a signature of the wrong length, and each
// of the ways a unified Zcash address can be laid out wrongly. Unified addresses are made here
// from their parts (ZIP 316), so that each fault can be made alone, with a good checksum.

import fs from "node:fs";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { base58, bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";
import { holdableKey } from "../server/rewards.ts";
import { checkPayoutTx, rewardTokenDecimals } from "../server/rewards-tools.ts";
import { feeSplit } from "../server/sapling.ts";
import { checkAddress, isValidTxHash, zcashKind } from "../shared/addresses.ts";
import { WALLET_CHAIN_NODE } from "../shared/chains.ts";
import { useRewards } from "../web/src/stores/rewards.ts";
import { createFakeRpc } from "./helpers.ts";

// Made up for these tests: a coin's mint and a pool's wallet on Solana.
const OTHER_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const RESERVE = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

// ---- a unified address, made from its parts ----
const utf8 = new TextEncoder();
const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((byte, index) => byte ^ b[index]!);
const h = (round: number, input: Uint8Array, length: number) => blake2b(input, { dkLen: length, personalization: Uint8Array.from([...utf8.encode("UA_F4Jumble_H"), round, 0, 0]) });
function g(round: number, input: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let block = 0; block * 64 < length; block++) {
    const part = blake2b(input, { dkLen: 64, personalization: Uint8Array.from([...utf8.encode("UA_F4Jumble_G"), round, block & 0xff, block >> 8]) });
    out.set(part.subarray(0, Math.min(64, length - block * 64)), block * 64);
  }
  return out;
}
function jumble(plain: Uint8Array): Uint8Array {
  const left = Math.min(64, Math.floor(plain.length / 2));
  const a = plain.subarray(0, left);
  const b = plain.subarray(left);
  const x = xor(b, g(0, a, b.length));
  const y = xor(a, h(0, x, left));
  const d = xor(x, g(1, y, b.length));
  const c = xor(y, h(1, d, left));
  return Uint8Array.from([...c, ...d]);
}
const PADDING = Uint8Array.from([0x75, ...new Uint8Array(15)]);
/** A part: its number, and so many bytes (any bytes: the site reads the layout, not the keys). */
const part = (type: number, length: number, stated = length) => [type, stated, ...Array.from({ length }, (_, index) => (type * 31 + index * 7) & 0xff)];
const unified = (parts: number[][], padding: Uint8Array = PADDING) => bech32m.encode("u", bech32m.toWords(jumble(Uint8Array.from([...parts.flat(), ...padding]))), false);
const P2PKH = part(0, 20);
const P2SH = part(1, 20);
const SAPLING = part(2, 43);
const ORCHARD = part(3, 43);
const UNKNOWN = part(4, 30);
const errorOf = (address: string) => {
  const check = checkAddress("zec", address);
  return check.ok ? null : check.error;
};

describe("a unified Zcash address is read by its layout", () => {
  it("the addresses made here are read as real ones are: shielded parts only, or with a transparent part", () => {
    expect(zcashKind(unified([ORCHARD]))).toBe("unified-shielded");
    expect(zcashKind(unified([SAPLING, ORCHARD]))).toBe("unified-shielded");
    expect(zcashKind(unified([P2PKH, ORCHARD]))).toBe("unified-transparent");
    expect(zcashKind(unified([P2SH, SAPLING, ORCHARD]))).toBe("unified-transparent");
    expect(checkAddress("zec", unified([ORCHARD])).ok).toBe(true);
  });

  it("it ends in its own padding: anything else there is damage, though the checksum is good", () => {
    for (const padding of [Uint8Array.from([0x75, ...new Uint8Array(14), 1]), Uint8Array.from([0x74, ...new Uint8Array(15)]), new Uint8Array(16)]) {
      const damaged = unified([ORCHARD], padding);
      expect(errorOf(damaged)).toBe("checksum");
      expect(zcashKind(damaged)).toBeNull();
    }
  });

  it("its parts come in rising order, and none twice", () => {
    for (const parts of [[ORCHARD, SAPLING], [ORCHARD, ORCHARD], [SAPLING, P2PKH, ORCHARD], [UNKNOWN, ORCHARD]]) {
      expect(errorOf(unified(parts))).toBe("format");
      expect(zcashKind(unified(parts))).toBeNull();
    }
  });

  it("a part of a known kind has that kind's own length", () => {
    for (const parts of [[part(3, 42)], [part(3, 44)], [part(2, 40), ORCHARD], [part(0, 21), ORCHARD], [part(1, 19), ORCHARD]]) {
      expect(errorOf(unified(parts))).toBe("format");
      expect(zcashKind(unified(parts))).toBeNull();
    }
  });

  it("it has one transparent part at most", () => {
    expect(errorOf(unified([P2PKH, P2SH, ORCHARD]))).toBe("format");
    expect(zcashKind(unified([P2PKH, P2SH, SAPLING]))).toBeNull();
  });

  it("transparent parts alone are no unified address, with or without a part of an unknown kind", () => {
    for (const parts of [[P2PKH, UNKNOWN], [P2SH, UNKNOWN], [UNKNOWN, part(5, 30)]]) {
      expect(errorOf(unified(parts))).toBe("format");
      expect(zcashKind(unified(parts))).toBeNull();
    }
  });

  it("with a part of a kind the site does not know it is an address, and is never called shielded only", () => {
    for (const parts of [[ORCHARD, UNKNOWN], [SAPLING, ORCHARD, UNKNOWN], [SAPLING, part(200, 12)]]) {
      expect(checkAddress("zec", unified(parts)).ok).toBe(true);
      expect(zcashKind(unified(parts))).toBe("unified-transparent");
    }
  });
});

describe("Sapling's fee", () => {
  it("is no figure when its parts do not add up to the whole of it, though each part alone would make a round number", () => {
    const split = (deployer: number) => ({ creatorFeeBps: 200, split: { lp: 2500, rootstock: 2500, treasury: 1000, deployer } });
    expect(feeSplit(split(4000))).toEqual({ totalBps: 200, liquidityBps: 50, burnBps: 50, saplingBps: 20, planterBps: 80 });
    expect(feeSplit(split(3000))).toBeNull();
    expect(feeSplit(split(5000))).toBeNull();
    expect(feeSplit(split(0))).toBeNull();
  });
});

describe("a key somebody can hold", () => {
  const FIELD = 2n ** 255n - 19n;
  /** The 32 bytes that spell a number, lowest byte first, as a key is written. */
  const spelt = (y: bigint) => Uint8Array.from({ length: 32 }, (_, index) => Number((y >> BigInt(8 * index)) & 0xffn));

  it("is written the one way a point is written: the same point spelt with a number past the field's size is nobody's key", () => {
    // Small numbers that are points somebody can hold, spelt the ordinary way.
    const small = Array.from({ length: 19 }, (_, index) => BigInt(index)).filter((y) => holdableKey(spelt(y)));
    expect(small.length).toBeGreaterThan(0);
    // The same points spelt the second way a careless reader would take: the number plus the field's size, which still fits the 255 bits.
    for (const y of small) {
      expect(FIELD + y < 2n ** 255n).toBe(true);
      expect(holdableKey(spelt(FIELD + y)), String(y)).toBe(false);
    }
    for (let y = 0n; y < 19n; y++) expect(holdableKey(spelt(FIELD + y)), String(y)).toBe(false);
  });
});

describe("what Solana says of a coin and of a payout is believed only in its proper shape", () => {
  it("a mint's decimals are a small whole number, or they are not read", async () => {
    const rpc = createFakeRpc();
    rpc.solDecimals.set(OTHER_MINT, 6);
    expect(await rewardTokenDecimals(rpc, OTHER_MINT)).toBe(6);
    for (const nonsense of [6.5, -1, 37, 255, Number.NaN, Number.POSITIVE_INFINITY]) {
      rpc.solDecimals.set(OTHER_MINT, nonsense);
      expect(await rewardTokenDecimals(rpc, OTHER_MINT), String(nonsense)).toBeNull();
    }
  });

  it("a payout's signature is 64 bytes: one of 63 or 65, well spelt and of a likely length, is never looked up", async () => {
    const rpc = createFakeRpc();
    const not = { ok: false, reason: "that is not a Solana transaction signature" };
    for (const bytes of [new Uint8Array(63).fill(0xff), Uint8Array.from([1, ...new Uint8Array(64).fill(0x7f)])]) {
      const written = base58.encode(bytes);
      // It has the look of a signature: only its length in bytes gives it away.
      expect(isValidTxHash("sol", written), String(bytes.length)).toBe(true);
      expect(await checkPayoutTx(rpc, RESERVE, written, OTHER_MINT)).toEqual(not);
    }
    expect(rpc.solCalls).toEqual([]);
  });
});

describe("where a chain is read when no node is set for it", () => {
  it("each chain's public node is that chain's own, and no two chains share one", () => {
    expect(WALLET_CHAIN_NODE).toEqual({
      bsc: "https://bsc-dataseed.bnbchain.org",
      eth: "https://ethereum-rpc.publicnode.com",
      base: "https://mainnet.base.org",
      arb: "https://arb1.arbitrum.io/rpc",
    });
    expect(new Set(Object.values(WALLET_CHAIN_NODE)).size).toBe(Object.keys(WALLET_CHAIN_NODE).length);
  });
});

describe("in the page", () => {
  it("a sign-in under way is not started a second time: nothing of it is touched", async () => {
    for (const step of ["connecting", "signing", "checking"] as const) {
      useRewards.setState({ step, error: "kept" });
      await useRewards.getState().signIn();
      expect(useRewards.getState()).toMatchObject({ step, error: "kept" });
    }
    useRewards.setState({ step: "idle", error: null });
  });

  it("every order the review asks for is one paid to its deposit address", () => {
    const sheet = fs.readFileSync(path.resolve("web", "src", "components", "ReviewSheet.tsx"), "utf8");
    expect(sheet.match(/\bpay: "[a-z]+"/g)).toEqual(['pay: "manual"']);
  });
});
