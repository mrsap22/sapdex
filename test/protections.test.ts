// Small rules, each of which another rule nearly hides: each of the ways a unified Zcash address
// can be laid out wrongly, each chain's own public node, and the one way an order is paid. Unified addresses are made here
// from their parts (ZIP 316), so that each fault can be made alone, with a good checksum.

import fs from "node:fs";
import path from "node:path";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";
import { checkAddress, zcashKind } from "../shared/addresses.ts";
import { WALLET_CHAIN_NODE } from "../shared/chains.ts";

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
  it("every order the review asks for is one paid to its deposit address", () => {
    const sheet = fs.readFileSync(path.resolve("web", "src", "components", "ReviewSheet.tsx"), "utf8");
    expect(sheet.match(/\bpay: "[a-z]+"/g)).toEqual(['pay: "manual"']);
  });
});
