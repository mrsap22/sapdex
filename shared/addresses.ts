// Address validation for every supported chain family.
// Strict checksum validation where the format has one; otherwise shape checks,
// with the swap provider's own validation as the final gate.

import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { base32, base58, base58xrp, base64, base64url, bech32, bech32m, createBase58check } from "@scure/base";
import { chainInfo, type ChainFamily } from "./chains.ts";

export type AddressError =
  | "empty"
  | "format"
  | "checksum"
  | "burn"
  | "zcash_shielded"
  | "zcash_sapling"
  | "xrp_tag"
  | "stellar_muxed"
  | "testnet";

export type AddressCheck =
  | { ok: true; address: string }
  | { ok: false; error: AddressError; looksLike: string | null };

const b58check = createBase58check(sha256);
const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function tryDecode(fn: () => Uint8Array): Uint8Array | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function crc16xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// ---- EVM ----

const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const EVM_BURN = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);

/** EIP-55 checksum form of a 0x address. Input must already match the EVM shape. */
export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak_256(utf8.encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower.charAt(i);
    out += parseInt(hash.charAt(i), 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

type Verdict = string | AddressError;

function isError(v: Verdict): v is AddressError {
  return (
    v === "empty" ||
    v === "format" ||
    v === "checksum" ||
    v === "burn" ||
    v === "zcash_sapling" ||
    v === "zcash_shielded" ||
    v === "xrp_tag" ||
    v === "stellar_muxed" ||
    v === "testnet"
  );
}

function evm(input: string): Verdict {
  if (!EVM_SHAPE.test(input)) return "format";
  const body = input.slice(2);
  const checksummed = toChecksumAddress(input);
  const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (!singleCase && input !== checksummed) return "checksum";
  if (EVM_BURN.has(input.toLowerCase())) return "burn";
  return checksummed;
}

// ---- Base58Check families ----

function base58Versioned(input: string, versions: readonly number[][]): Verdict {
  if (!/^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(input)) return "format";
  const bytes = tryDecode(() => b58check.decode(input));
  if (!bytes) return "checksum";
  for (const version of versions) {
    if (bytes.length === version.length + 20 && version.every((b, i) => bytes[i] === b)) return input;
  }
  return "format";
}

function segwit(input: string, hrp: string): Verdict {
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) return "format";
  if (!lower.startsWith(`${hrp}1`) || lower.length > 90) return "format";
  for (const [codec, modern] of [
    [bech32, false],
    [bech32m, true],
  ] as const) {
    try {
      const { prefix, words } = codec.decode(lower as `${string}1${string}`, 90);
      if (prefix !== hrp) continue;
      const version = words[0];
      if (version === undefined) continue;
      const program = codec.fromWords(words.slice(1));
      if (version === 0 && !modern && (program.length === 20 || program.length === 32)) return lower;
      if (version === 1 && modern && program.length === 32) return lower;
    } catch {
      // try the next encoding
    }
  }
  return "checksum";
}

function firstOk(...verdicts: Verdict[]): Verdict {
  const ok = verdicts.find((v) => !isError(v));
  if (ok !== undefined) return ok;
  return verdicts.includes("checksum") ? "checksum" : "format";
}

const bitcoin = (s: string) => firstOk(base58Versioned(s, [[0x00], [0x05]]), segwit(s, "bc"));
const litecoin = (s: string) => firstOk(base58Versioned(s, [[0x30], [0x32], [0x05]]), segwit(s, "ltc"));
const dogecoin = (s: string) => base58Versioned(s, [[0x1e], [0x16]]);
const dash = (s: string) => base58Versioned(s, [[0x4c], [0x10]]);
const tron = (s: string) => (s.startsWith("T") ? base58Versioned(s, [[0x41]]) : "format");

/**
 * The kinds of Zcash address the site takes, as the swap provider takes them:
 *  - "transparent": t1 or t3. Everything about a payment to one is public on Zcash.
 *  - "tex": tex1, a transparent address that asks to be paid from a transparent one.
 *  - "unified-transparent": u1, holding a transparent part among its parts (or a part of a kind not known to be shielded).
 *  - "unified-shielded": u1, with shielded parts only. It can be paid in a shielded pool or not at all.
 */
export type ZcashKind = "transparent" | "tex" | "unified-transparent" | "unified-shielded";

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((byte, index) => byte ^ b[index]!);

/** The two keyed hashes a unified address is scrambled with (ZIP 316, "F4Jumble"). */
function jumbleH(round: number, input: Uint8Array, length: number): Uint8Array {
  return blake2b(input, { dkLen: length, personalization: Uint8Array.from([...utf8.encode("UA_F4Jumble_H"), round, 0, 0]) });
}
function jumbleG(round: number, input: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let block = 0; block * 64 < length; block++) {
    const part = blake2b(input, { dkLen: 64, personalization: Uint8Array.from([...utf8.encode("UA_F4Jumble_G"), round, block & 0xff, block >> 8]) });
    out.set(part.subarray(0, Math.min(64, length - block * 64)), block * 64);
  }
  return out;
}

/** Unscrambles the bytes of a unified address. */
function unjumble(bytes: Uint8Array): Uint8Array {
  const left = Math.min(64, Math.floor(bytes.length / 2));
  const c = bytes.subarray(0, left);
  const d = bytes.subarray(left);
  const y = xor(c, jumbleH(1, d, left));
  const x = xor(d, jumbleG(1, y, d.length));
  const a = xor(y, jumbleH(0, x, left));
  const b = xor(x, jumbleG(0, a, d.length));
  const out = new Uint8Array(bytes.length);
  out.set(a);
  out.set(b, left);
  return out;
}

/** How long each known part of a unified address is, by its number: two transparent kinds, Sapling, Orchard. */
const UNIFIED_PART_BYTES: Readonly<Record<number, number>> = { 0: 20, 1: 20, 2: 43, 3: 43 };

/**
 * Reads a unified Zcash address (u1...) down to its parts, as ZIP 316 lays one out: the checksum,
 * the scrambling undone, the address's own prefix at the end as padding, and then the parts, each
 * with its number and its length, in rising order and none twice. It says whether one of the
 * parts is transparent. An address with a part this site does not know is still an address; one
 * that is only transparent parts is not (ZIP 316 forbids it).
 */
function zcashUnified(input: string): ZcashKind | "format" | "checksum" {
  // One case throughout, as every bech32 address is written; and no longer than any real one.
  if (input !== input.toLowerCase() || input.length > 250 || !/^u1[02-9ac-hj-np-z]{60,}$/.test(input)) return "format";
  let bytes: Uint8Array;
  try {
    const { prefix, words } = bech32m.decode(input as `${string}1${string}`, false);
    if (prefix !== "u") return "format";
    bytes = bech32m.fromWords(words);
  } catch {
    return "checksum";
  }
  if (bytes.length < 48) return "format";
  const plain = unjumble(bytes);
  // The last sixteen bytes are the prefix, "u", and noughts: anything else is damage the checksum did not catch.
  const padding = plain.subarray(plain.length - 16);
  if (padding[0] !== 0x75 || padding.subarray(1).some((byte) => byte !== 0)) return "checksum";
  const body = plain.subarray(0, plain.length - 16);
  let transparent = false;
  let shielded = false;
  let unknown = false;
  let last = -1;
  for (let at = 0; at < body.length; ) {
    // Every number and length in a real address fits one byte.
    const type = body[at]!;
    const length = body[at + 1];
    if (type >= 0xfd || length === undefined || length >= 0xfd || at + 2 + length > body.length) return "format";
    if (type <= last) return "format";
    const known = UNIFIED_PART_BYTES[type];
    if (known !== undefined && length !== known) return "format";
    // A transparent address has one transparent part at most.
    if (type === 1 && last === 0) return "format";
    if (type === 0 || type === 1) transparent = true;
    if (type === 2 || type === 3) shielded = true;
    // A part of a kind this site does not know could be paid in a way it cannot speak for.
    if (known === undefined) unknown = true;
    last = type;
    at += 2 + length;
  }
  if (!shielded) return "format";
  // "Shielded only" is said of an address whose every part is known to be shielded, and of no other.
  return transparent || unknown ? "unified-transparent" : "unified-shielded";
}

/** Reads a TEX address (tex1...), as ZIP 320 lays one out: twenty bytes, the same as a transparent address holds. */
function zcashTex(input: string): ZcashKind | "format" | "checksum" {
  if (input !== input.toLowerCase() || !/^tex1[02-9ac-hj-np-z]{38}$/.test(input)) return "format";
  try {
    const { prefix, words } = bech32m.decode(input as `${string}1${string}`, 90);
    return prefix === "tex" && bech32m.fromWords(words).length === 20 ? "tex" : "format";
  } catch {
    return "checksum";
  }
}

/** What kind of Zcash address a text is, or why it is none. */
function zcashRead(input: string): ZcashKind | AddressError {
  // The older shielded kind. The swap provider does not deliver to it; a unified address is the one to use.
  if (/^zs1/i.test(input)) return "zcash_sapling";
  // The oldest shielded kind, and addresses of Zcash's test networks.
  if (/^(zc|utest|ztestsapling|textest|zregtestsapling|uregtest)/i.test(input)) return "zcash_shielded";
  if (/^u1/i.test(input)) return zcashUnified(input);
  if (/^tex1/i.test(input)) return zcashTex(input);
  const verdict = base58Versioned(input, [
    [0x1c, 0xb8],
    [0x1c, 0xbd],
  ]);
  return isError(verdict) ? verdict : "transparent";
}

const ZCASH_KINDS: ReadonlySet<string> = new Set<ZcashKind>(["transparent", "tex", "unified-transparent", "unified-shielded"]);

function zcash(input: string): Verdict {
  const read = zcashRead(input);
  return ZCASH_KINDS.has(read) ? input : (read as AddressError);
}

/**
 * Which kind of Zcash address a valid one is, so that the site can say what it was given: above
 * all whether a unified address holds a transparent part. Null for anything that is not a Zcash
 * address the site takes.
 */
export function zcashKind(address: string): ZcashKind | null {
  const read = zcashRead(address.trim());
  return ZCASH_KINDS.has(read) ? (read as ZcashKind) : null;
}

// ---- Bitcoin Cash CashAddr ----

const CASH_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CASH_GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function cashPolymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const top = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    CASH_GENERATORS.forEach((g, i) => {
      if ((top >> BigInt(i)) & 1n) c ^= g;
    });
  }
  return c ^ 1n;
}

function cashAddr(input: string): Verdict {
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) return "format";
  const prefix = "bitcoincash";
  const body = lower.startsWith(`${prefix}:`) ? lower.slice(prefix.length + 1) : lower;
  // The first character is the address type (q or p). The second carries the size bits,
  // which are zero for the only size in use, so it is one of q, p, z or r.
  if (!/^[qp][qpzr][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{40}$/.test(body)) return "format";
  const values = [...prefix].map((c) => c.charCodeAt(0) & 0x1f);
  values.push(0);
  for (const ch of body) values.push(CASH_CHARSET.indexOf(ch));
  if (cashPolymod(values) !== 0n) return "checksum";
  // The payload is 168 bits carried in 34 five-bit characters: the last two bits are padding and
  // must be zero, so that each destination has exactly one spelling.
  if ((CASH_CHARSET.indexOf(body.charAt(33)) & 0b11) !== 0) return "format";
  return `${prefix}:${body}`;
}

const bitcoinCash = (s: string) => firstOk(base58Versioned(s, [[0x00], [0x05]]), cashAddr(s));

// ---- Solana ----

/** Well-known Solana program and burn addresses. Nobody holds their keys, so coins sent there are gone. */
const SOLANA_NOT_WALLETS = new Set([
  "11111111111111111111111111111111", // system program
  "1nc1nerator11111111111111111111111111111111", // incinerator
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // token program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // token-2022 program
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token program
  "ComputeBudget111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112", // wrapped SOL mint
]);

function solana(input: string): Verdict {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) return "format";
  const bytes = tryDecode(() => base58.decode(input));
  if (!bytes || bytes.length !== 32) return "format";
  return SOLANA_NOT_WALLETS.has(input) ? "burn" : input;
}

// ---- NEAR ----

const NEAR_NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)+([a-z\d]+[-_])*[a-z\d]+$/;

function near(input: string): Verdict {
  if (/^[0-9a-f]{64}$/.test(input)) return input;
  if (/^0x[0-9a-f]{40}$/.test(input)) return input;
  if (input.length >= 2 && input.length <= 64 && NEAR_NAMED.test(input)) return input;
  return "format";
}

// ---- XRP ----

function xrp(input: string): Verdict {
  if (/^X[1-9A-HJ-NP-Za-km-z]{46}$/.test(input)) return "xrp_tag";
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(input)) return "format";
  const bytes = tryDecode(() => base58xrp.decode(input));
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x00) return "format";
  const check = sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4);
  return check.every((b, i) => bytes[21 + i] === b) ? input : "checksum";
}

// ---- Stellar ----

function stellar(input: string): Verdict {
  if (/^M[A-Z2-7]{68}$/.test(input)) return "stellar_muxed";
  if (!/^G[A-Z2-7]{55}$/.test(input)) return "format";
  const bytes = tryDecode(() => base32.decode(input));
  if (!bytes || bytes.length !== 35 || bytes[0] !== 0x30) return "format";
  const crc = crc16xmodem(bytes.subarray(0, 33));
  return bytes[33] === (crc & 0xff) && bytes[34] === crc >> 8 ? input : "checksum";
}

// ---- TON ----

function ton(input: string): Verdict {
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(input)) return "format";
  const urlSafe = input.replace(/\+/g, "-").replace(/\//g, "_");
  const bytes = tryDecode(() => base64url.decode(urlSafe)) ?? tryDecode(() => base64.decode(input));
  if (!bytes || bytes.length !== 36) return "format";
  const tag = bytes[0] ?? 0;
  if (tag & 0x80) return "testnet";
  if (tag !== 0x11 && tag !== 0x51) return "format";
  if (bytes[1] !== 0x00 && bytes[1] !== 0xff) return "format";
  const crc = crc16xmodem(bytes.subarray(0, 34));
  return bytes[34] === crc >> 8 && bytes[35] === (crc & 0xff) ? input : "checksum";
}

// ---- 32-byte hex families ----

function hex32(input: string): Verdict {
  return /^0x[0-9a-fA-F]{64}$/.test(input) ? input.toLowerCase() : "format";
}

function starknet(input: string): Verdict {
  if (!/^0x[0-9a-fA-F]{59,64}$/.test(input)) return "format";
  return BigInt(input) < 1n << 251n ? input : "format";
}

// ---- Cardano ----

function cardano(input: string): Verdict {
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) return "format";
  if (lower.startsWith("addr_test1")) return "testnet";
  if (!lower.startsWith("addr1") || lower.length > 120) return "format";
  try {
    const { prefix, words } = bech32.decode(lower as `${string}1${string}`, 120);
    const bytes = bech32.fromWords(words);
    const header = bytes[0];
    if (prefix !== "addr" || header === undefined) return "format";
    if ((header & 0x0f) !== 1) return "testnet";
    const kind = header >> 4;
    if (kind <= 3) return bytes.length === 57 ? lower : "format";
    if (kind <= 5) return bytes.length >= 30 && bytes.length <= 65 ? lower : "format";
    if (kind <= 7) return bytes.length === 29 ? lower : "format";
    return "format";
  } catch {
    return "checksum";
  }
}

// ---- Aleo ----

function aleo(input: string): Verdict {
  if (!/^aleo1[02-9ac-hj-np-z]{58}$/.test(input)) return "format";
  try {
    const { prefix, words } = bech32m.decode(input as `${string}1${string}`, 90);
    return prefix === "aleo" && bech32m.fromWords(words).length === 32 ? input : "format";
  } catch {
    return "checksum";
  }
}

// ---- Quantus (SS58, network prefix 189) ----

const SS58_CONTEXT = utf8.encode("SS58PRE");

function quantus(input: string): Verdict {
  if (!/^qz[1-9A-HJ-NP-Za-km-z]{44,48}$/.test(input)) return "format";
  const bytes = tryDecode(() => base58.decode(input));
  if (!bytes || bytes.length !== 36) return "format";
  // Two-byte prefix encoding of network 189.
  if (bytes[0] !== (((189 & 0xfc) >> 2) | 0x40) || bytes[1] !== ((189 >> 8) | ((189 & 0x03) << 6))) return "format";
  const body = bytes.subarray(0, 34);
  const hash = blake2b(Uint8Array.from([...SS58_CONTEXT, ...body]), { dkLen: 64 });
  return bytes[34] === hash[0] && bytes[35] === hash[1] ? input : "checksum";
}

// ---- Fallback ----

function generic(input: string): Verdict {
  return /^[A-Za-z0-9:._-]{20,128}$/.test(input) ? input : "format";
}

const VALIDATORS: Record<ChainFamily, (input: string) => Verdict> = {
  evm,
  solana,
  bitcoin,
  litecoin,
  dogecoin,
  bitcoincash: bitcoinCash,
  dash,
  zcash,
  near,
  tron,
  ton,
  stellar,
  xrp,
  sui: hex32,
  aptos: hex32,
  starknet,
  cardano,
  aleo,
  quantus,
  generic,
};

/** Families we can name when an address was pasted into the wrong field. */
const RECOGNISE: Array<[ChainFamily, string]> = [
  ["evm", "Ethereum"],
  ["solana", "Solana"],
  ["bitcoin", "Bitcoin"],
  ["tron", "Tron"],
  ["ton", "TON"],
  ["stellar", "Stellar"],
  ["xrp", "XRP Ledger"],
  ["zcash", "Zcash"],
  ["litecoin", "Litecoin"],
  ["dogecoin", "Dogecoin"],
  ["cardano", "Cardano"],
  ["aleo", "Aleo"],
];

function recognise(input: string, except: ChainFamily): string | null {
  for (const [family, label] of RECOGNISE) {
    if (family === except) continue;
    if (!isError(VALIDATORS[family](input))) return label;
  }
  return null;
}

/**
 * Checks an address for a chain. On success returns the normalised address
 * (EVM addresses in checksum form). On failure says why, and names the chain
 * the text does belong to when that is recognisable.
 */
export function checkAddress(chainKey: string, input: unknown): AddressCheck {
  if (typeof input !== "string") return { ok: false, error: "format", looksLike: null };
  const text = input.trim();
  if (text === "") return { ok: false, error: "empty", looksLike: null };
  // Long enough for a Zcash unified address, so it can be named as unsupported rather than just "invalid".
  if (text.length > 256 || /\s/.test(text)) return { ok: false, error: "format", looksLike: null };
  const family = chainInfo(chainKey).family;
  const verdict = VALIDATORS[family](text);
  if (!isError(verdict)) return { ok: true, address: verdict };
  const looksLike = verdict === "format" || verdict === "checksum" ? recognise(text, family) : null;
  return { ok: false, error: verdict, looksLike };
}

export function isValidAddress(chainKey: string, input: unknown): boolean {
  return checkAddress(chainKey, input).ok;
}

/** Compares two addresses on a chain. EVM addresses compare without regard to case. */
export function sameAddress(chainKey: string, a: string, b: string): boolean {
  const family = chainInfo(chainKey).family;
  if (family === "evm" || family === "sui" || family === "aptos" || family === "starknet") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

const TX_SHAPES: Partial<Record<ChainFamily, RegExp>> = {
  evm: /^0x[0-9a-fA-F]{64}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/,
  bitcoin: /^[0-9a-fA-F]{64}$/,
  litecoin: /^[0-9a-fA-F]{64}$/,
  dogecoin: /^[0-9a-fA-F]{64}$/,
  bitcoincash: /^[0-9a-fA-F]{64}$/,
  dash: /^[0-9a-fA-F]{64}$/,
  zcash: /^[0-9a-fA-F]{64}$/,
  tron: /^[0-9a-fA-F]{64}$/,
  xrp: /^[0-9A-F]{64}$/,
  stellar: /^[0-9a-f]{64}$/,
  near: /^[1-9A-HJ-NP-Za-km-z]{43,44}$/,
};

/** Shape check for a transaction hash on a chain. */
export function isValidTxHash(chainKey: string, hash: unknown): hash is string {
  if (typeof hash !== "string") return false;
  const shape = TX_SHAPES[chainInfo(chainKey).family] ?? /^[A-Za-z0-9+/=_-]{32,100}$/;
  return shape.test(hash);
}
