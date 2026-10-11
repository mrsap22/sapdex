import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base58 } from "@scure/base";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signInHost } from "../server/app.ts";
import { ConfigError } from "../server/config.ts";
import { briefPoints, isSignInMessage, MICRO, minPayoutFor, nextWeek, pointsMicro, poolShare, RESERVE_ASSET, REWARDS, sharePool, showPoints, SIGN_IN_STATEMENT, signInMessage, swapPointsMicro, usdToMicro, weekBounds, weekOf, type RewardsPublic, type RewardsView } from "../shared/rewards.ts";
import { silentLogger } from "../server/log.ts";
import { createRewards, createSignIn, entryFor, orderHash, QUARTER_MS, rewardsAddressOf, signedBy, type PointsEntry, type Rewards, type WeekRecord } from "../server/rewards.ts";
import { checkPayoutTx, exportWeek, poolAmount, recordPayouts, reserveHolds, rewardTokenDecimals, weekCsv, withoutAccount } from "../server/rewards-tools.ts";
import type { RpcCall, RpcResult } from "../server/rpc.ts";
import { createSanctions, createStaticSanctions } from "../server/sanctions.ts";
import type { OrderRecord } from "../server/store.ts";
import { ESTIMATE_NOTE, MIN_PAYOUT_TEXT, RULES_IN_SHORT, shareText, usdMicroText, usdText } from "../web/src/lib/rewards-logic.ts";
import { NO_WALLET_WORDS, type SignInWallet, type WalletAccount } from "../web/src/lib/sign-in-logic.ts";
import RewardsPage from "../web/src/pages/RewardsPage.tsx";
import { useRewards } from "../web/src/stores/rewards.ts";
import { ADDR, asOrder, ASSET, createFakeRpc, eventually, FIXTURE_TOKENS, harness, solBalance, solTx, TOKEN_PROGRAM, ZEC_MINT, type FakeRpc, type Harness, type HarnessOptions } from "./helpers.ts";

// The Solana wallets the Rewards page would find in the browser when "Sign in" is pressed. Here
// they are stand-ins that a test puts there: each writes down what it was asked to sign, and signs
// it or refuses as the test tells it to.
const browser = vi.hoisted(() => ({ wallets: [] as unknown[] }));
vi.mock("../web/src/solana/sign-in.ts", () => ({ findWallets: () => browser.wallets }));

/** The first bytes of an Ed25519 private key as Node reads one: the 32 bytes of the key itself follow. */
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

// Wallets for these tests, made from fixed text so that they are nobody's. Their keys guard nothing.
// Each is a Solana wallet: its address is its Ed25519 public key in base58, and it signs text as a
// Solana wallet does, the signature given in base64.
function wallet(label: string): { address: string; publicKey: Uint8Array; privateKey: KeyObject; signMessage(message: string): string } {
  const seed = createHash("sha256").update(`saplingdex test wallet ${label}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const raw = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12);
  return { address: base58.encode(raw), publicKey: new Uint8Array(raw), privateKey, signMessage: (message) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64") };
}
const ALICE = wallet("alice");
const BOB = wallet("bob");
/** A third address, which is due nothing anywhere. */
const CAROL = wallet("carol");
/** The wallet the pool is kept in. */
const RESERVE = wallet("reserve").address;

/** A made-up Solana transaction signature: 64 bytes in base58, from fixed text. */
const signature = (label: string) => base58.encode(createHash("sha512").update(`saplingdex test payout ${label}`).digest());

/** Anything in a text that has the shape of a Solana address: 32 to 44 base58 characters standing alone. (A transaction signature is twice as long, and is not one.) */
const addressesIn = (text: string): string[] => [...new Set(text.match(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g) ?? [])];

let open: Harness[] = [];
let dirs: string[] = [];
async function start(options?: HarnessOptions): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saplingdex-rewards-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const MONDAY = Date.parse("2026-10-05T00:00:00.000Z");

describe("the rules for points, as numbers", () => {
  it("are the ones the site states", () => {
    // Rewards are paid on Solana, and a rewards address is a Solana address. No chain is named by a number anywhere.
    expect(REWARDS).toEqual({ pointsPerUsd: 10, sessionMinutes: 30, nonceMinutes: 5, chain: "sol", holderBoostBps: 0 });
    // Rewards are paid in ZEC on Solana: the mint there, exactly as it is written, with its 8 decimals.
    expect(RESERVE_ASSET).toEqual({ chain: "sol", symbol: "ZEC", name: "ZEC", decimals: 8, contract: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", minPayout: 100_000n });
    expect(RESERVE_ASSET.contract).toBe(ZEC_MINT);
    expect(rewardsAddressOf(RESERVE_ASSET.contract)).toBe(RESERVE_ASSET.contract);
    // The smallest payout that is sent is 0.001 of the coin, and never less than its smallest unit.
    expect(minPayoutFor(8)).toBe(RESERVE_ASSET.minPayout);
    expect([minPayoutFor(18), minPayoutFor(6), minPayoutFor(4), minPayoutFor(3), minPayoutFor(0)]).toEqual([10n ** 15n, 1000n, 10n, 1n, 1n]);
  });

  it.each([
    // One point for every 10 cents: ten points to the dollar, in millionths of a point.
    ["1", 10_000_000n],
    ["0.10", 1_000_000n],
    ["12.34", 123_400_000n],
    ["1265.13", 12_651_300_000n],
    ["0.99", 9_900_000n],
    ["1000000", 10_000_000_000_000n],
    // Below a millionth of a dollar there is nothing to count: rounded down, never up.
    ["0.000001", 10n],
    ["0.0000009", 0n],
    ["0", 0n],
  ])("a swap of $%s adds %s millionths of a point", (paid, expected) => {
    expect(swapPointsMicro(paid)).toBe(expected);
    expect(pointsMicro(usdToMicro(paid)!)).toBe(expected);
  });

  it.each([[undefined], [null], [""], ["1e3"], ["-5"], ["12.5.1"], ["12,5"], [1234], ["NaN"], ["1".repeat(41)]])("no dollar value (%s) gives no points, not a guess", (paid) => {
    expect(usdToMicro(paid)).toBeNull();
    expect(swapPointsMicro(paid)).toBeNull();
  });

  it("gives ten points for each dollar, and shows them rounded down", () => {
    expect(pointsMicro(usd(1))).toBe(10n * MICRO);
    expect(pointsMicro(usd(0.1))).toBe(MICRO);
    expect(showPoints(pointsMicro(usd(123.456789)))).toBe("1,234.56");
    expect(showPoints(999_999n)).toBe("0.99");
    expect(showPoints(0n)).toBe("0.00");
    expect(showPoints(-5n)).toBe("0.00");
    expect(showPoints(1_234_567_890_000n)).toBe("1,234,567.89");
  });
});

describe("a wallet's share of the week's pool", () => {
  const ZEC = 10n ** 8n;
  /** A pool of so much ZEC (in its smallest unit), worth so many dollars, or with no price. */
  const pool = (amount: bigint, dollars: number | null) => ({ amount, usdMicro: dollars === null ? null : usd(dollars) });

  it("is its points out of everyone's, in hundredths of a percent, and that part of the pool in ZEC, with its dollars beside it, all rounded down", () => {
    // 250 points of 1,000, and a pool of 49.3824 ZEC worth $1,234.56: a quarter of it, 12.3456 ZEC, about $308.64.
    expect(poolShare(250n * MICRO, 1000n * MICRO, pool(493_824n * 10n ** 4n, 1234.56))).toEqual({ shareBps: 2500n, estimate: 123_456n * 10n ** 4n, estimateCents: 30_864n });
    // 1 point of 100 is 1%.
    expect(poolShare(MICRO, 100n * MICRO, pool(500n * ZEC, 2400))).toEqual({ shareBps: 100n, estimate: 5n * ZEC, estimateCents: 2400n });
    expect(shareText(poolShare(MICRO, 100n * MICRO, null).shareBps)).toBe("1.00%");
    // Rounded down, never up, to the coin's smallest unit and to the cent.
    expect(poolShare(1n, 3n, pool(100n, 100))).toEqual({ shareBps: 3333n, estimate: 33n, estimateCents: 3300n });
    expect(poolShare(2n, 3n, pool(ZEC, 0.05))).toEqual({ shareBps: 6666n, estimate: 66_660_000n, estimateCents: 3n });
    // All of it.
    expect(poolShare(7n, 7n, pool(42n * ZEC, 42.42))).toEqual({ shareBps: 10_000n, estimate: 42n * ZEC, estimateCents: 4242n });
  });

  it("works the estimate out from the share as it is shown, two decimals and no finer, and prices that estimate", () => {
    // A third of 1,000 ZEC worth $4,800. The share is 33.33%, so the estimate is 333.3 ZEC, not 333.333…, and its dollars are that amount's: $1,599.84.
    expect(poolShare(1n, 3n, pool(1000n * ZEC, 4800))).toEqual({ shareBps: 3333n, estimate: 3333n * ZEC / 10n, estimateCents: 159_984n });
    // Two totals that give the same share to two decimals give the same estimate to the last unit: the estimate says no more of the total than the share does.
    const one = poolShare(100_000n * MICRO, 300_000n * MICRO, pool(1000n * ZEC, 4800));
    const other = poolShare(100_000n * MICRO, 300_029n * MICRO, pool(1000n * ZEC, 4800));
    expect(other).toEqual(one);
    expect(one.estimate).toBe((1000n * ZEC * one.shareBps) / 10_000n);
  });

  it("is nothing while nobody has points, and nothing for an address with none", () => {
    const nothing = { shareBps: 0n, estimate: 0n, estimateCents: 0n };
    expect(poolShare(0n, 0n, pool(100n * ZEC, 100))).toEqual(nothing);
    // A total of nothing divides nothing, whatever an address is said to hold.
    expect(poolShare(5n * MICRO, 0n, pool(100n * ZEC, 100))).toEqual(nothing);
    expect(poolShare(0n, 100n * MICRO, pool(100n * ZEC, 100))).toEqual(nothing);
    expect(poolShare(-1n, 100n, pool(100n * ZEC, 100))).toEqual(nothing);
  });

  it("is never more than all of it: points read a moment after the total do not count for more than 100%", () => {
    expect(poolShare(150n, 100n, pool(100n * ZEC, 100))).toEqual({ shareBps: 10_000n, estimate: 100n * ZEC, estimateCents: 10_000n });
  });

  it("has no estimate while the pool is not known, and a figure in ZEC with no dollars where there is no price", () => {
    expect(poolShare(25n, 100n, null)).toEqual({ shareBps: 2500n, estimate: 0n, estimateCents: null });
    expect(poolShare(0n, 0n, null)).toEqual({ shareBps: 0n, estimate: 0n, estimateCents: null });
    expect(poolShare(25n, 100n, pool(0n, 0))).toEqual({ shareBps: 2500n, estimate: 0n, estimateCents: 0n });
    // No price for the coin just now: the estimate in ZEC is there, and nothing is said in dollars.
    expect(poolShare(25n, 100n, pool(80n * ZEC, null))).toEqual({ shareBps: 2500n, estimate: 20n * ZEC, estimateCents: null });
    expect(poolShare(0n, 100n, pool(80n * ZEC, null))).toEqual({ shareBps: 0n, estimate: 0n, estimateCents: null });
  });

  it("is written with two decimals, and dollars with their cents", () => {
    expect([shareText(100n), shareText(2500n), shareText(10_000n), shareText(7n), shareText(0n)]).toEqual(["1.00%", "25.00%", "100.00%", "0.07%", "0.00%"]);
    expect([usdText(1234n), usdText(123_456_789n), usdText(5n), usdText(0n)]).toEqual(["$12.34", "$1,234,567.89", "$0.05", "$0.00"]);
    // Millionths of a dollar are rounded down to the cent.
    expect([usdMicroText(52_275_000_000n), usdMicroText(1_999_999n), usdMicroText(9_999n)]).toEqual(["$52,275.00", "$1.99", "$0.00"]);
  });
});

describe("the week", () => {
  it.each([
    ["2026-10-05T00:00:00.000Z", "2026-W41"],
    ["2026-10-04T23:59:59.999Z", "2026-W40"],
    ["2026-10-11T23:59:59.999Z", "2026-W41"],
    ["2026-10-12T00:00:00.000Z", "2026-W42"],
    // The turn of a year: a week belongs to the year its Thursday is in.
    ["2026-12-31T12:00:00.000Z", "2026-W53"],
    ["2027-01-03T23:59:59.999Z", "2026-W53"],
    ["2027-01-04T00:00:00.000Z", "2027-W01"],
    ["2024-12-30T00:00:00.000Z", "2025-W01"],
    ["2021-01-03T12:00:00.000Z", "2020-W53"],
    ["1970-01-01T00:00:00.000Z", "1970-W01"],
  ])("%s is in week %s", (moment, week) => {
    expect(weekOf(Date.parse(moment))).toBe(week);
  });

  it("runs from Monday 00:00 UTC to the Monday after", () => {
    expect(weekBounds("2026-W41")).toEqual({ start: MONDAY, end: MONDAY + 7 * 86_400_000 });
    expect(new Date(MONDAY).getUTCDay()).toBe(1);
    expect(nextWeek("2026-W41")).toBe("2026-W42");
    expect(nextWeek("2026-W53")).toBe("2027-W01");
    // A year of 52 weeks has no 53rd.
    for (const bad of ["2025-W53", "2026-W00", "2026-W54", "2026-41", "W41", "2026-W4", ""]) expect(weekBounds(bad), bad).toBeNull();
  });

  it("every moment of a week is in that week, and the moment after it is in the next", () => {
    for (const week of ["2026-W01", "2026-W41", "2026-W53", "2027-W01", "2032-W53"]) {
      const bounds = weekBounds(week)!;
      for (const at of [bounds.start, bounds.start + 1, bounds.end - 1]) expect(weekOf(at), week).toBe(week);
      expect(weekOf(bounds.end), week).toBe(nextWeek(week));
      expect(weekOf(bounds.start - 1)).not.toBe(week);
    }
  });
});

describe("sharing a pool out by points", () => {
  // Three Solana addresses, in the order of their letters.
  const [A, B, C] = [wallet("first").address, wallet("second").address, wallet("third").address].sort() as [string, string, string];

  it("rounds every share down and leaves the rest in the reserve: what is paid and what is left are exactly the pool", () => {
    const result = sharePool(1000n, new Map([[A, 1n], [B, 1n], [C, 1n]]), 0n);
    expect(result.shares.map((share) => share.payout)).toEqual([333n, 333n, 333n]);
    expect(result).toMatchObject({ paid: 999n, left: 1n, totalPoints: 3n });
    for (const [pool, points] of [
      [10n ** 8n, [7n, 11n, 13n]],
      [1_234_567_890n, [1n, 999_999_999n, 5n]],
      [1n, [5n, 5n, 5n]],
      [0n, [1n, 2n, 3n]],
    ] as const) {
      const shared = sharePool(pool, new Map([[A, points[0]], [B, points[1]], [C, points[2]]]), 0n);
      expect(shared.paid + shared.left).toBe(pool);
      expect(shared.shares.reduce((sum, share) => sum + share.payout, 0n)).toBe(shared.paid);
      expect(shared.left >= 0n).toBe(true);
    }
  });

  it("sends nothing under the smallest payout, and carries those points forward instead", () => {
    const result = sharePool(1000n, new Map([[A, 98n], [B, 1n], [C, 1n]]), 50n);
    expect(result.shares).toEqual([
      { address: A, points: 98n, payout: 980n, carried: 0n },
      { address: B, points: 1n, payout: 0n, carried: 1n },
      { address: C, points: 1n, payout: 0n, carried: 1n },
    ]);
    expect(result).toMatchObject({ paid: 980n, left: 20n });
  });

  it("gives the same shares, in the same order, however the points were handed in", () => {
    const one = sharePool(10n ** 8n, new Map([[C, 3n], [A, 1n], [B, 2n]]), 1n);
    const two = sharePool(10n ** 8n, new Map([[B, 2n], [C, 3n], [A, 1n]]), 1n);
    expect(one).toEqual(two);
    expect(one.shares.map((share) => share.address)).toEqual([A, B, C]);
    // The order is that of the addresses exactly as they are written. Capitals are part of an address: they are not folded
    // into small letters to sort it, so an address that begins with a capital stands before one that begins with a small letter.
    const capital = `Z${A.slice(1)}`;
    const small = `a${A.slice(1)}`;
    expect(sharePool(100n, new Map([[small, 1n], [capital, 1n]]), 0n).shares.map((share) => share.address)).toEqual([capital, small]);
    // And two addresses that differ only in a capital are two addresses, each with its own share.
    expect(sharePool(100n, new Map([[small, 1n], [small.toUpperCase(), 3n]]), 0n).shares).toEqual([
      { address: small.toUpperCase(), points: 3n, payout: 75n, carried: 0n },
      { address: small, points: 1n, payout: 25n, carried: 0n },
    ]);
  });

  it("leaves out an address with no points, shares nothing when nobody has any, and refuses a pool under nothing", () => {
    expect(sharePool(100n, new Map([[A, 0n], [B, 5n]]), 0n).shares.map((share) => share.address)).toEqual([B]);
    expect(sharePool(100n, new Map(), 0n)).toMatchObject({ shares: [], paid: 0n, left: 100n, totalPoints: 0n });
    expect(() => sharePool(-1n, new Map([[A, 1n]]), 0n)).toThrow();
  });
});

/** A stored order, with only what the points record reads. */
function stored(overrides: Partial<OrderRecord> & { status?: string; finishedAt?: string | null } = {}): OrderRecord {
  const { status = "delivered", finishedAt = new Date(MONDAY + 3_600_000).toISOString(), ...rest } = overrides;
  return {
    v: 1,
    id: "A".repeat(27),
    createdAt: new Date(MONDAY).toISOString(),
    pay: "manual",
    from: { id: "base:ETH", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 8, contract: null },
    to: { id: "sol:USDT", symbol: "USDT", name: "Tether", chain: "sol", decimals: 6, contract: "x" },
    amountIn: "500000000000000000",
    amountOut: "1",
    minAmountOut: "1",
    amountInUsd: "25.00",
    amountOutUsd: "24.95",
    slippageBps: 100,
    timeEstimate: 30,
    fees: { appBps: 20, appAmount: "1", providerBps: 20, providerAmount: "1" },
    withdrawFee: null,
    refundFee: null,
    recipient: "r",
    refundTo: "f",
    rewardsAddress: ALICE.address,
    depositAddress: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    depositMemo: null,
    deadline: new Date(MONDAY + 1_800_000).toISOString(),
    termsVersion: "t",
    screening: { result: "clear", listVersion: "v", checkedAt: new Date(MONDAY).toISOString() },
    quoteResponse: null,
    state: { status, upstreamStatus: "SUCCESS", statusSince: finishedAt ?? new Date(MONDAY).toISOString(), updatedAt: finishedAt ?? new Date(MONDAY).toISOString(), anchor: MONDAY, depositTxHash: null, depositForwarded: false, details: null, finishedAt, stopped: false, slowAlertSent: false },
    ...rest,
  } as OrderRecord;
}

describe("what a swap adds", () => {
  it("is counted from the dollar value of a delivered order: 10 points for each dollar that was paid", () => {
    const entry = entryFor(stored())!;
    // $25 paid: 250 points.
    expect(entry).toEqual({ v: 2, order: orderHash("A".repeat(27)), address: ALICE.address, week: "2026-W41", at: new Date(MONDAY + 3_600_000).toISOString(), volumeUsdMicro: "25000000", reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" } });
    expect(pointsMicro(BigInt(entry.volumeUsdMicro))).toBe(250n * MICRO);
    // The order's own ID is not in it, nor any address but the rewards address.
    expect(JSON.stringify(entry)).not.toContain("A".repeat(27));
    // With cents: $1,265.13 is 12,651.30 points.
    expect(entryFor(stored({ amountInUsd: "1265.13" }))?.volumeUsdMicro).toBe("1265130000");
  });

  it("counts every delivered swap by its size alone: no fee, coin or route changes it", () => {
    const usual = entryFor(stored())!;
    // No fee of SaplingDex's, or one: the same points.
    for (const fees of [{ appBps: 0, appAmount: "0", providerBps: 20, providerAmount: "1" }, { appBps: 40, appAmount: "2", providerBps: 1, providerAmount: "1" }]) expect(entryFor(stored({ fees }))).toEqual(usual);
    // Two dollar coins, the same coin on another chain, a coin and its wrapped self: each counts in full.
    for (const [from, to] of [["USDC", "USDT"], ["ETH", "ETH"], ["ETH", "WETH"], ["cbBTC", "BTC"]] as const) {
      const entry = entryFor(stored({ from: { id: "a", symbol: from, name: "", chain: "base", decimals: 8, contract: null }, to: { id: "b", symbol: to, name: "", chain: "arb", decimals: 8, contract: null } }))!;
      expect(entry, `${from} to ${to}`).toMatchObject({ volumeUsdMicro: usual.volumeUsdMicro, reasons: [] });
    }
    // Routed privately or in public: the same.
    expect(entryFor(stored({ confidentiality: "basic" }))).toEqual(usual);
  });

  it.each(["waiting", "deposit_seen", "swapping", "refunded", "failed", "expired", "deposit_too_small"])("an order that is %s adds nothing", (status) => {
    expect(entryFor(stored({ status }))).toBeNull();
  });

  it("an order with no rewards address, or one that is not an address, adds nothing", () => {
    // A 0x address is an address of another kind, and so is a Bitcoin one: neither is a rewards address.
    for (const rewardsAddress of [null, undefined, "", "0x1234", "not an address", ADDR.evm, ADDR.evm.toLowerCase(), ADDR.btc, `1${ALICE.address}`, `${ALICE.address}${ALICE.address}`, ALICE.address.slice(0, 20)]) expect(entryFor(stored({ rewardsAddress: rewardsAddress as string | null })), String(rewardsAddress)).toBeNull();
    for (const other of [ADDR.evm, ADDR.evm.toLowerCase(), ADDR.btc, "0x1234", 5, null, undefined, {}]) expect(rewardsAddressOf(other), String(other)).toBeNull();
    // A Solana address is kept exactly as it is written: nothing but the space around it is taken away.
    expect(rewardsAddressOf(ALICE.address)).toBe(ALICE.address);
    expect(rewardsAddressOf(` ${ALICE.address} `)).toBe(ALICE.address);
    expect(entryFor(stored())?.address).toBe(ALICE.address);
    // Capitals are part of it. The same letters in small ones, or with one letter in the other case, are never read as this address:
    // they are another address, or none.
    const at = ALICE.address.search(/[a-zA-Z]/);
    const letter = ALICE.address[at] ?? "";
    const mistyped = `${ALICE.address.slice(0, at)}${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}${ALICE.address.slice(at + 1)}`;
    for (const other of [ALICE.address.toLowerCase(), ALICE.address.toUpperCase(), mistyped]) {
      expect(other).not.toBe(ALICE.address);
      expect([null, other], other).toContainEqual(rewardsAddressOf(other));
    }
  });

  it("an order the provider gave no dollar value for adds an entry of no points, which says why", () => {
    for (const amountInUsd of ["", "about 5", "1e3"]) expect(entryFor(stored({ amountInUsd })), amountInUsd).toMatchObject({ volumeUsdMicro: "0", reasons: ["no_usd_value"] });
  });

  it("belongs to the week in which it was delivered, not the one in which it was made", () => {
    expect(entryFor(stored({ createdAt: new Date(MONDAY - 60_000).toISOString(), finishedAt: new Date(MONDAY + 60_000).toISOString() }))?.week).toBe("2026-W41");
    expect(entryFor(stored({ finishedAt: new Date(MONDAY - 1).toISOString() }))?.week).toBe("2026-W40");
  });
});

describe("the points a quote is shown to add", () => {
  it("are the points the server counts for the same swap once it is delivered", () => {
    for (const amountInUsd of ["1265.13", "0.99", "250000", "12.3456789"]) {
      const entry = entryFor(stored({ amountInUsd }))!;
      expect(swapPointsMicro(amountInUsd), `$${amountInUsd}`).toBe(pointsMicro(BigInt(entry.volumeUsdMicro)));
    }
  });

  it("are written short: two decimals, rounded down, with no noughts at the end", () => {
    expect(briefPoints(12_651_300_000n)).toBe("12,651.3");
    expect(briefPoints(253_026_000n)).toBe("253.02");
    expect(briefPoints(20_000_000n)).toBe("20");
    expect(briefPoints(1_234_000_000n)).toBe("1,234");
    expect(briefPoints(250_000n)).toBe("0.25");
    expect(briefPoints(100_000n)).toBe("0.1");
    expect(briefPoints(9_999n)).toBe("0");
    expect(briefPoints(0n)).toBe("0");
  });
});

/** A sanctions list that names nobody. */
const CLEAR = createStaticSanctions([]);
const WEEK_MS = 7 * 86_400_000;
/** Every file and folder under a folder, with each file's time of writing and content: to see that nothing at all was written. */
const everything = (dir: string): string[] =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
    const stat = fs.statSync(path.join(dir, name));
    return stat.isDirectory() ? `${name}/` : `${name} ${stat.mtimeMs}: ${fs.readFileSync(path.join(dir, name), "utf8")}`;
  });

describe("the record of points", () => {
  const end = MONDAY + WEEK_MS;
  /** Alice has 250 points and Bob 750 in week 41: a quarter and three quarters. */
  const quarters = (dir = tempDir()) => {
    const rewards = createRewards(dir);
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "75" }));
    return rewards;
  };
  const shareOf = (record: WeekRecord, who: { address: string }) => record.shares.find((share) => share.address === who.address)!;

  it("adds a delivered order once, however often it is told, and still has it after a restart", () => {
    const dir = tempDir();
    const rewards = createRewards(dir);
    const order = stored();
    expect(rewards.recordDelivered(order)).not.toBeNull();
    rewards.recordDelivered(order);
    rewards.recordDelivered({ ...order, amountInUsd: "999999" });
    expect(rewards.entriesFor(ALICE.address)).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, "rewards", "entries"))).toEqual([`${orderHash(order.id)}.json`]);
    const again = createRewards(dir);
    expect(again.entriesFor(ALICE.address)).toEqual(rewards.entriesFor(ALICE.address));
    // Points are kept under the address letter for letter: the same letters in small ones are another address, with none.
    expect(again.entriesFor(ALICE.address.toLowerCase())).toEqual([]);
    expect(again.view(ALICE.address.toLowerCase(), MONDAY + 86_400_000)).toMatchObject({ allTimeMicro: "0", swaps: [] });
    // Told once more after the restart, it is still one entry, with the value it had the first time.
    again.recordDelivered({ ...order, amountInUsd: "999999" });
    expect(again.entriesFor(ALICE.address)).toHaveLength(1);
    expect(again.entriesFor(ALICE.address)[0]?.volumeUsdMicro).toBe("25000000");
    expect(rewards.recordDelivered(stored({ status: "refunded" }))).toBeNull();
  });

  it("clears away a half-written entry that a crash left behind, and leaves alone one that is being written now", () => {
    const dir = tempDir();
    const entries = path.join(dir, "rewards", "entries");
    fs.mkdirSync(entries, { recursive: true });
    // Two temporary files of the kind a write makes on its way: one a moment old (another process is writing it), one two minutes old.
    const young = path.join(entries, `${"a".repeat(64)}.json.tmp-4321-0a1b2c3d`);
    const old = path.join(entries, `${"b".repeat(64)}.json.tmp-4322-0a1b2c3d`);
    fs.writeFileSync(young, '{"v":1');
    fs.writeFileSync(old, '{"v":1');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(old, twoMinutesAgo, twoMinutesAgo);
    const rewards = createRewards(dir);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    // Neither is taken for an entry, and the record goes on as usual around the one that is left.
    rewards.recordDelivered(stored());
    expect(rewards.entriesFor(ALICE.address)).toHaveLength(1);
    expect(fs.readFileSync(young, "utf8")).toBe('{"v":1');
  });

  it("sums an address's week with no limit, and keeps each address's points apart", () => {
    const rewards = createRewards(tempDir());
    // Alice: three swaps of $200,000, $150,000 and $52,000 in one week. All of it counts: 4,020,000 points.
    for (const [index, paid] of ["200000", "150000", "52000"].entries()) rewards.recordDelivered(stored({ id: `${"B".repeat(26)}${index}`, amountInUsd: paid }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address }));
    const week = rewards.weekPoints("2026-W41");
    expect(week.get(ALICE.address)).toBe(4_020_000n * MICRO);
    expect(week.get(BOB.address)).toBe(250n * MICRO);
    expect([...week.keys()].sort()).toEqual([ALICE.address, BOB.address].sort());
    expect(rewards.weekPoints("2026-W42").size).toBe(0);
    const view = rewards.view(ALICE.address, MONDAY + 86_400_000);
    expect(view.week).toEqual({ id: "2026-W41", start: new Date(MONDAY).toISOString(), end: new Date(MONDAY + 7 * 86_400_000).toISOString(), pointsMicro: week.get(ALICE.address)!.toString(), carriedInMicro: "0" });
    expect(view.allTimeMicro).toBe(view.week.pointsMicro);
    expect(view.swaps).toHaveLength(3);
    // Each swap is shown with its own points, and they add up to the week's.
    expect(view.swaps.map((swap) => swap.pointsMicro).sort()).toEqual([pointsMicro(usd(52_000)), pointsMicro(usd(150_000)), pointsMicro(usd(200_000))].map(String).sort());
    expect(JSON.stringify(view)).not.toContain(BOB.address);
    expect(JSON.stringify(rewards.view(BOB.address, MONDAY))).not.toContain(ALICE.address);
  });

  it("does not read an entry written while points were counted from a fee: its file is left as it is, and adds nothing, also when its order is put to the record again at a start", () => {
    const dir = tempDir();
    const entries = path.join(dir, "rewards", "entries");
    fs.mkdirSync(entries, { recursive: true });
    // The entry of the older kind that a delivered order left behind, under that order's own name.
    const order = stored();
    const file = path.join(entries, `${orderHash(order.id)}.json`);
    const old = JSON.stringify({ v: 1, order: orderHash(order.id), address: ALICE.address, week: "2026-W41", at: new Date(MONDAY).toISOString(), feeUsdMicro: "2500000", countedMicro: "2500000", reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" } });
    fs.writeFileSync(file, old);
    const rewards = createRewards(dir);
    expect(rewards.entriesFor(ALICE.address)).toEqual([]);
    expect(rewards.weekPoints("2026-W41").size).toBe(0);
    // At a start every stored delivered order is put to the record again. This one's file is there: nothing is written, and nothing is added in memory.
    rewards.recordDelivered(order);
    rewards.recordDelivered(order);
    expect(rewards.entriesFor(ALICE.address)).toEqual([]);
    expect(rewards.weekPoints("2026-W41").size).toBe(0);
    expect(rewards.view(ALICE.address, MONDAY + 86_400_000)).toMatchObject({ allTimeMicro: "0", week: { pointsMicro: "0" }, swaps: [] });
    expect(rewards.summary(MONDAY + 86_400_000).weekPointsMicro).toBe("0");
    // A fresh reading of the folder, as the payout tools make one, holds the same: nothing.
    const fresh = createRewards(dir);
    expect(fresh.entriesFor(ALICE.address)).toEqual([]);
    expect(fresh.weekPoints("2026-W41")).toEqual(rewards.weekPoints("2026-W41"));
    expect(fs.readFileSync(file, "utf8")).toBe(old);
    expect(fs.readdirSync(entries)).toEqual([`${orderHash(order.id)}.json`]);
    // Another order of the same address, with no file yet, is written down and counted as ever, in memory and on disk alike.
    rewards.recordDelivered(stored({ id: "C".repeat(27) }));
    expect(rewards.entriesFor(ALICE.address)).toHaveLength(1);
    expect(createRewards(dir).entriesFor(ALICE.address)).toEqual(rewards.entriesFor(ALICE.address));
  });

  it("closes a week once: the same pool gives the same record, another pool is refused, and a week still running cannot be closed", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end - 1, CLEAR)).toThrow(/has not ended/);
    expect(() => rewards.closeWeek("2026-41", 10n ** 8n, "ZEC", 1n, end, CLEAR)).toThrow(/not a week/);
    const closed = rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR);
    // Alice has 250 points and Bob 750: a quarter and three quarters.
    expect(closed.shares).toEqual(
      [
        { address: ALICE.address, pointsMicro: "250000000", payout: "25000000", carriedMicro: "0" },
        { address: BOB.address, pointsMicro: "750000000", payout: "75000000", carriedMicro: "0" },
      ].sort((a, b) => (a.address < b.address ? -1 : 1)),
    );
    expect(BigInt(closed.paid) + BigInt(closed.left)).toBe(10n ** 8n);
    // Kept with the week: its volume ($25 and $75), and the list its payouts were screened against.
    expect(closed).toMatchObject({ v: 1, volumeUsdMicro: "100000000", totalPointsMicro: "1000000000", screenedWith: "test-list", txs: [] });
    const file = fs.readFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), "utf8");
    // Closed again a day later, and by a fresh reading of the same folder: the very same record.
    expect(rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end + 86_400_000, CLEAR)).toEqual(closed);
    expect(createRewards(dir).closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end + 2 * 86_400_000, CLEAR)).toEqual(closed);
    expect(fs.readFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), "utf8")).toBe(file);
    expect(() => rewards.closeWeek("2026-W41", 2n * 10n ** 8n, "ZEC", 1n, end, CLEAR)).toThrow(/already closed/);
    // A swap delivered late into that week, after it was closed, does not change what was shared out.
    rewards.recordDelivered(stored({ id: "D".repeat(27), amountInUsd: "9999" }));
    expect(rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR)).toEqual(closed);
  });

  it("works out what closing a week would write without writing it", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const before = everything(dir);
    const plan = rewards.planWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR);
    expect(everything(dir)).toEqual(before);
    expect(rewards.week("2026-W41")).toBeNull();
    // It refuses what closing refuses, and closing writes exactly what it showed.
    expect(() => rewards.planWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end - 1, CLEAR)).toThrow(/has not ended/);
    expect(rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR)).toEqual(plan);
    expect(rewards.planWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end + 5, CLEAR)).toEqual(plan);
    expect(() => rewards.planWeek("2026-W41", 1n, "ZEC", 1n, end, CLEAR)).toThrow(/already closed/);
  });

  it("carries a share too small to send into the next week, as points", () => {
    const rewards = createRewards(tempDir());
    // Alice swapped 10 cents, which is one point. Bob swapped $500,000.
    rewards.recordDelivered(stored({ amountInUsd: "0.1" }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000" }));
    // A pool of 1,000 ZEC: Alice's part of it is 0.00019999 ZEC, under the 0.001 that is the smallest payout sent.
    const closed = rewards.closeWeek("2026-W41", 1000n * 10n ** 8n, "ZEC", RESERVE_ASSET.minPayout, end, CLEAR);
    const alice = closed.shares.find((share) => share.address === ALICE.address)!;
    expect(alice).toMatchObject({ payout: "0", carriedMicro: "1000000" });
    expect((1000n * 10n ** 8n * 1_000_000n) / 5_000_001_000_000n).toBe(19_999n);
    // Without a smallest payout the same share would have been sent: it is the rule that carries it.
    expect(sharePool(1000n * 10n ** 8n, rewards.weekPoints("2026-W41"), 0n).shares.find((share) => share.address === ALICE.address)).toMatchObject({ payout: 19_999n, carried: 0n });
    // The week after, Alice starts with what was carried, and a new swap adds to it.
    expect(rewards.weekPoints("2026-W42").get(ALICE.address)).toBe(1_000_000n);
    rewards.recordDelivered(stored({ id: "E".repeat(27), finishedAt: new Date(end + 60_000).toISOString(), amountInUsd: "20" }));
    expect(rewards.weekPoints("2026-W42").get(ALICE.address)).toBe(1_000_000n + 200n * MICRO);
    const view = rewards.view(ALICE.address, end + 120_000);
    expect(view.week).toMatchObject({ id: "2026-W42", carriedInMicro: "1000000", pointsMicro: (1_000_000n + 200n * MICRO).toString() });
    // Points are counted once in the total over all time, in the week their swap was delivered.
    expect(view.allTimeMicro).toBe((1_000_000n + 200n * MICRO).toString());
    expect(view.payouts).toEqual([]);
    expect(rewards.view(BOB.address, end).payouts).toEqual([{ week: "2026-W41", amount: closed.shares.find((share) => share.address === BOB.address)!.payout, asset: "ZEC", decimals: 8, txs: [] }]);
  });

  it("closes a week with a pool of nothing: nothing is to be sent, and every address's points are carried", () => {
    const rewards = quarters();
    const closed = rewards.closeWeek("2026-W41", 0n, "ZEC", RESERVE_ASSET.minPayout, end, CLEAR);
    expect(closed).toMatchObject({ pool: "0", paid: "0", left: "0", totalPointsMicro: "1000000000" });
    expect(shareOf(closed, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: "0", carriedMicro: "250000000" });
    expect(shareOf(closed, BOB)).toEqual({ address: BOB.address, pointsMicro: "750000000", payout: "0", carriedMicro: "750000000" });
    const next = rewards.weekPoints("2026-W42");
    expect([next.get(ALICE.address), next.get(BOB.address)]).toEqual([250n * MICRO, 750n * MICRO]);
    expect(rewards.view(ALICE.address, end + 1)).toMatchObject({ payouts: [], week: { id: "2026-W42", carriedInMicro: "250000000" } });
    expect(() => rewards.closeWeek("2026-W42", -1n, "ZEC", 1n, end + WEEK_MS, CLEAR)).toThrow();
  });

  it("closes weeks in order: not while an earlier week that holds points is still open", () => {
    const rewards = createRewards(tempDir());
    // Alice's swap is delivered in week 41, Bob's in week 42.
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, finishedAt: new Date(end + 3_600_000).toISOString() }));
    const later = end + WEEK_MS;
    expect(() => rewards.planWeek("2026-W42", 10n ** 8n, "ZEC", 1n, later, CLEAR)).toThrow(/Week 2026-W41 holds points and is still open\. Close it first/);
    expect(() => rewards.closeWeek("2026-W42", 10n ** 8n, "ZEC", 1n, later, CLEAR)).toThrow(/Week 2026-W41 holds points and is still open\. Close it first/);
    expect(rewards.week("2026-W42")).toBeNull();
    rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, later, CLEAR);
    expect(rewards.closeWeek("2026-W42", 10n ** 8n, "ZEC", 1n, later, CLEAR).shares.map((share) => share.address)).toEqual([BOB.address]);
    // A week in which nothing was delivered, and into which nothing was carried, holds no points: it is no one's to wait for.
    rewards.recordDelivered(stored({ id: "D".repeat(27), finishedAt: new Date(end + 2 * WEEK_MS + 3_600_000).toISOString() }));
    expect(rewards.closeWeek("2026-W44", 10n ** 8n, "ZEC", 1n, end + 3 * WEEK_MS, CLEAR).shares).toHaveLength(1);
    // Nor is a week whose only swap added no points.
    rewards.recordDelivered(stored({ id: "E".repeat(27), amountInUsd: "", finishedAt: new Date(end + 3 * WEEK_MS + 3_600_000).toISOString() }));
    expect(rewards.weekPoints("2026-W45").size).toBe(0);
    expect(rewards.closeWeek("2026-W46", 10n ** 8n, "ZEC", 1n, end + 5 * WEEK_MS, CLEAR).shares).toEqual([]);
  });

  it("carries points through every week between: what was carried out of week 41 reaches week 43 by way of week 42", () => {
    const rewards = createRewards(tempDir());
    // Week 41: Alice's share is too small to send, and her one point is carried.
    rewards.recordDelivered(stored({ amountInUsd: "0.1" }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000" }));
    expect(shareOf(rewards.closeWeek("2026-W41", 1000n * 10n ** 8n, "ZEC", RESERVE_ASSET.minPayout, end, CLEAR), ALICE).carriedMicro).toBe("1000000");
    // Nothing is delivered in week 42. Bob swaps again in week 43.
    rewards.recordDelivered(stored({ id: "D".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000", finishedAt: new Date(end + WEEK_MS + 3_600_000).toISOString() }));
    const after = end + 2 * WEEK_MS;
    // Week 43 is not closed over week 42's head: Alice's point is in week 42, and would be lost there.
    expect(() => rewards.closeWeek("2026-W43", 10n ** 8n, "ZEC", 1n, after, CLEAR)).toThrow(/Week 2026-W42 holds points and is still open\. Close it first, with a pool of nothing if nothing is to be paid for it\./);
    expect(rewards.week("2026-W43")).toBeNull();
    // Week 42 is closed with nothing to pay, and the point goes on.
    const middle = rewards.closeWeek("2026-W42", 0n, "ZEC", RESERVE_ASSET.minPayout, after, CLEAR);
    expect(middle.shares).toEqual([{ address: ALICE.address, pointsMicro: "1000000", payout: "0", carriedMicro: "1000000" }]);
    expect(rewards.weekPoints("2026-W43").get(ALICE.address)).toBe(1_000_000n);
    const last = rewards.closeWeek("2026-W43", 10n ** 8n, "ZEC", 1n, after, CLEAR);
    expect(shareOf(last, ALICE)).toMatchObject({ pointsMicro: "1000000", carriedMicro: "0" });
    expect(BigInt(shareOf(last, ALICE).payout) > 0n).toBe(true);
  });

  it("screens the payout list as a week is closed: a listed address is sent nothing and carries nothing, and its share stays in the reserve", () => {
    const rewards = quarters();
    // The list names Bob, letter for letter, as a Solana address is written.
    const closed = rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, createStaticSanctions([BOB.address]));
    // Alice has her quarter and no more: Bob's three quarters are not handed to her.
    expect(shareOf(closed, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: "25000000", carriedMicro: "0" });
    expect(shareOf(closed, BOB)).toEqual({ address: BOB.address, pointsMicro: "750000000", payout: "0", carriedMicro: "0", withheld: "75000000" });
    expect(closed).toMatchObject({ pool: (10n ** 8n).toString(), paid: "25000000", left: "75000000", totalPointsMicro: "1000000000", screenedWith: "test-list" });
    // Nothing is carried for it, and its own view shows no payout for the week.
    expect(rewards.weekPoints("2026-W42").has(BOB.address)).toBe(false);
    expect(rewards.view(BOB.address, end + 1)).toMatchObject({ payouts: [], week: { id: "2026-W42", carriedInMicro: "0", pointsMicro: "0" } });
    expect(rewards.view(ALICE.address, end + 1).payouts).toEqual([{ week: "2026-W41", amount: "25000000", asset: "ZEC", decimals: 8, txs: [] }]);
    // And no transaction can be written down as having paid it.
    expect(() => rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: signature("b2") }], end + 2)).toThrow(/has no payout in week 2026-W41/);
    // The same week closed against a list that names nobody sends Bob his share: the screening is what kept it back.
    expect(shareOf(quarters().closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR), BOB)).toMatchObject({ payout: "75000000", carriedMicro: "0" });
  });

  it("closes nothing while the sanctions list is missing or out of date, as no order is made without it", async () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const none = createStaticSanctions([], { available: false });
    expect(() => rewards.planWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, none)).toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, none)).toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    // Not even a week with nothing to pay.
    expect(() => rewards.closeWeek("2026-W41", 0n, "ZEC", 1n, end, none)).toThrow(/sanctions list is missing or out of date/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);

    // The list service the server screens orders with, on a saved list that cannot be fetched again.
    const listDir = tempDir();
    fs.mkdirSync(path.join(listDir, "sanctions"));
    const save = (fetchedAt: number) => fs.writeFileSync(path.join(listDir, "sanctions", "sdn-addresses.json"), JSON.stringify({ publishDate: "2026-10-01", fetchedAt, addresses: [...Array.from({ length: 300 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`), BOB.address] }));
    const service = () => createSanctions({ dataDir: listDir, log: silentLogger, alerts: { send() {} }, fetchImpl: async () => Promise.reject(new Error("offline")), now: () => end });
    // Never loaded.
    expect(() => rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, service())).toThrow(/sanctions list is missing or out of date/);
    // Saved three days and an hour ago: older than the list may be for an order, so older than it may be for a payout.
    save(end - 73 * 3_600_000);
    const stale = service();
    await stale.refresh();
    expect(stale.available()).toBe(false);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, stale)).toThrow(/sanctions list is missing or out of date/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
    // Saved an hour ago: it is used, and it names Bob.
    save(end - 3_600_000);
    const fresh = service();
    await fresh.refresh();
    const closed = rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, fresh);
    expect(shareOf(closed, BOB)).toMatchObject({ payout: "0", carriedMicro: "0", withheld: "75000000" });
    expect(shareOf(closed, ALICE)).toMatchObject({ payout: "25000000" });
    expect(closed.screenedWith).toBe("2026-10-01");
  });

  it("never writes over a week's record that it cannot read, and is not brought down by one", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const file = path.join(dir, "rewards", "weeks", "2026-W41.json");
    const broken = '{"v":1,"week":"2026-W41","pool":"1","asset":"ZEC","shares":[{"address":"x"}],"txs":[]}';
    fs.writeFileSync(file, broken);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR)).toThrow(/Week 2026-W41 has a record that cannot be read\. It was left as it is/);
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(rewards.week("2026-W41")).toBeNull();
    expect(rewards.summary(end)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    expect(rewards.view(ALICE.address, end).payouts).toEqual([]);
  });

  it("keeps, with each share, the transaction that paid it, and shows an address its own transfer and no one else's", () => {
    const rewards = quarters();
    rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR);
    const forAlice = signature("a1");
    const forBob = signature("b2");
    const payouts = (who: { address: string }) => rewards.view(who.address, end + 10).payouts;
    // Closed and not yet sent: each sees its amount, and no transaction.
    expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: "25000000", asset: "ZEC", decimals: 8, txs: [] }]);
    // An address is matched letter for letter: the same letters in small ones are another address, which is due nothing.
    expect(() => rewards.recordPaid("2026-W41", [{ address: ALICE.address.toLowerCase(), hash: forAlice }], end + 2)).toThrow(/has no payout in week 2026-W41/);
    expect(rewards.week("2026-W41")?.txs).toEqual([]);
    // Alice's is recorded, with the signature exactly as Solana writes it.
    const one = rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash: forAlice }], end + 2);
    expect(shareOf(one, ALICE).tx).toBe(forAlice);
    expect(shareOf(one, BOB).tx).toBeUndefined();
    expect(one.txs).toEqual([{ hash: forAlice, recordedAt: new Date(end + 2).toISOString() }]);
    expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: "25000000", asset: "ZEC", decimals: 8, txs: [forAlice] }]);
    // Bob's is still being sent: he is not shown the transaction that paid Alice.
    expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: "75000000", asset: "ZEC", decimals: 8, txs: [] }]);
    rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: forBob }], end + 3);
    expect(payouts(BOB)[0]?.txs).toEqual([forBob]);
    expect(payouts(ALICE)[0]?.txs).toEqual([forAlice]);
    expect(JSON.stringify(rewards.view(ALICE.address, end + 10))).not.toContain(forBob);
    expect(JSON.stringify(rewards.view(BOB.address, end + 10))).not.toContain(forAlice);
    // A share is paid once, and only an address that is due a payout is paid at all.
    expect(() => rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash: signature("c3") }], end + 4)).toThrow(/has a transaction on record already/);
    expect(() => rewards.recordPaid("2026-W41", [{ address: CAROL.address, hash: signature("c3") }], end + 4)).toThrow(/has no payout in week 2026-W41/);
    expect(() => rewards.recordPaid("2026-W40", [{ address: ALICE.address, hash: signature("c3") }], end + 4)).toThrow(/not closed/);
    expect(rewards.week("2026-W41")?.txs.map((tx) => tx.hash)).toEqual([forAlice, forBob]);
  });

  it("keeps a transaction on record for one week only", () => {
    const rewards = createRewards(tempDir());
    // Alice alone, in week 41 and again in week 42.
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), finishedAt: new Date(end + 3_600_000).toISOString() }));
    const later = end + WEEK_MS;
    rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, later, CLEAR);
    rewards.closeWeek("2026-W42", 10n ** 8n, "ZEC", 1n, later, CLEAR);
    const hash = signature("a1");
    expect(rewards.weekOfTx(hash)).toBeNull();
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash }], later);
    expect(rewards.weekOfTx(hash)).toBe("2026-W41");
    // A signature has one spelling, and capitals are part of it: other letters are another transaction, on record nowhere.
    expect(rewards.weekOfTx(hash.toLowerCase())).toBeNull();
    expect(() => rewards.recordPaid("2026-W42", [{ address: ALICE.address, hash }], later)).toThrow(/is on record for week 2026-W41 already/);
    expect(rewards.week("2026-W42")).toMatchObject({ txs: [] });
    expect(rewards.week("2026-W42")?.shares[0]?.tx).toBeUndefined();
  });

  it("tells anyone the week's dates, its points as one total, and what the paid weeks have on record as sent, and nothing about any address", () => {
    const rewards = quarters();
    // Alice's 250 points and Bob's 750, as one number, with nothing to say whose they are.
    const running = rewards.summary(MONDAY + 86_400_000);
    expect(running).toMatchObject({ week: { id: "2026-W41" }, weekPointsMicro: (1000n * MICRO).toString() });
    expect(JSON.stringify(running)).not.toMatch(/250000000|750000000/);
    expect(addressesIn(JSON.stringify(running))).toEqual([]);
    const closed = rewards.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR);
    // Closed but not yet paid: not on the public list.
    expect(rewards.summary(end + 1)).toMatchObject({ week: { id: "2026-W42" }, weeks: [], totalPaid: "0", weeksPaid: 0 });
    const hash = signature("9a");
    // Alice's quarter is on record as sent and Bob's three quarters are not: the week has paid a quarter, whatever was worked out for it.
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash }], end + 2);
    expect(closed.paid).toBe((10n ** 8n).toString());
    expect(rewards.summary(end + 3)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "ZEC", paid: "25000000", txs: [hash] }], totalPaid: "25000000", weeksPaid: 1 });
    const second = signature("9b");
    rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: second }], end + 4);
    const summary = rewards.summary(end + 5);
    expect(summary).toMatchObject({ weeks: [{ week: "2026-W41", asset: "ZEC", paid: (10n ** 8n).toString(), txs: [hash, second] }], totalPaid: (10n ** 8n).toString(), weeksPaid: 1 });
    expect(addressesIn(JSON.stringify(summary))).toEqual([]);
    for (const who of [ALICE, BOB]) expect(JSON.stringify(summary)).not.toContain(who.address);
    // The one thing it says of points is the week's total: here, the week after, nothing yet.
    expect(Object.keys(summary).sort()).toEqual(["totalPaid", "week", "weekPointsMicro", "weeks", "weeksPaid"]);
    expect(summary.weekPointsMicro).toBe("0");
    expect(Object.keys(summary.week).sort()).toEqual(["end", "id", "start"]);
  });

  it("still reads a week written before a share kept its own transaction, and one closed in another coin: it is shown in its own coin, with its own decimals, and not added to what was paid in ZEC", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "rewards", "weeks"), { recursive: true });
    // A week closed in another coin, of 18 decimals, on another chain: its record says so, and its transaction is written as that chain writes one.
    const earlier = `0x${"9a".repeat(32)}`;
    const old = {
      v: 1,
      week: "2026-W41",
      closedAt: new Date(end).toISOString(),
      asset: "NEAR",
      decimals: 18,
      pool: "1000",
      paid: "1000",
      left: "0",
      totalPointsMicro: "4",
      shares: [
        { address: ALICE.address, pointsMicro: "1", payout: "250", carriedMicro: "0" },
        { address: BOB.address, pointsMicro: "3", payout: "750", carriedMicro: "0" },
      ],
      txs: [{ hash: earlier, recordedAt: new Date(end + 1).toISOString() }],
    };
    fs.writeFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), JSON.stringify(old));
    // And a week in ZEC whose record does not say how many decimals: it is read with the coin's own 8.
    const plain = { v: 1, week: "2026-W40", closedAt: new Date(end).toISOString(), asset: "ZEC", pool: "600", paid: "600", left: "0", totalPointsMicro: "1", shares: [{ address: ALICE.address, pointsMicro: "1", payout: "600", carriedMicro: "0" }], txs: [] };
    fs.writeFileSync(path.join(dir, "rewards", "weeks", "2026-W40.json"), JSON.stringify(plain));
    const rewards = createRewards(dir);
    expect(rewards.week("2026-W41")).toEqual(old);
    expect(rewards.week("2026-W40")).toEqual(plain);
    expect(rewards.summary(end + 2)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    // Each is shown as what it was: the one in its own coin with its own 18 decimals, the other in ZEC with 8.
    expect(rewards.view(ALICE.address, end + 2).payouts).toEqual([
      { week: "2026-W41", amount: "250", asset: "NEAR", decimals: 18, txs: [] },
      { week: "2026-W40", amount: "600", asset: "ZEC", decimals: 8, txs: [] },
    ]);
    // Its transaction is on record all the same, so it cannot be recorded for another week.
    expect(rewards.weekOfTx(earlier)).toBe("2026-W41");
    // A share of it can still be given the transfer that paid it.
    const own = `0x${"9c".repeat(32)}`;
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash: own }], end + 3);
    // It is on the list of paid weeks as what it was, and is no part of the total paid in ZEC.
    expect(rewards.summary(end + 4)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "NEAR", decimals: 18, paid: "250", txs: [own] }], totalPaid: "0", weeksPaid: 0 });
    expect(rewards.view(ALICE.address, end + 4).payouts[0]).toMatchObject({ asset: "NEAR", decimals: 18, txs: [own] });
    // It cannot be closed again in ZEC, and the tool that records payouts in ZEC records none for it: Solana is not even asked.
    expect(() => rewards.closeWeek("2026-W41", 1000n, "ZEC", 1n, end + 5, CLEAR)).toThrow(/already closed, with a pool of 1000 NEAR/);
    const rpc = createFakeRpc();
    const toBob = signature("another coin's week");
    rpc.solTxs.set(toBob, solTx([solBalance(RESERVE, 1000n)], [solBalance(RESERVE, 250n), solBalance(BOB.address, 750n)]));
    await expect(recordPayouts({ rewards, rpc, reserve: RESERVE, token: RESERVE_ASSET.contract, week: "2026-W41", hashes: [toBob], now: end + 6 })).rejects.toThrow(/Week 2026-W41 was closed in NEAR, not in ZEC\. Only payouts in ZEC are recorded\. Nothing was recorded\./);
    expect(rpc.solCalls).toEqual([]);
    expect(rewards.week("2026-W41")?.shares.find((share) => share.address === BOB.address)?.tx).toBeUndefined();
  });

  it("reads a closed week's file once, and again only when the tools have changed it", () => {
    const dir = tempDir();
    // The running server's record, and the tools' own reading of the same folder, as they are in two processes.
    const server = quarters(dir);
    const tools = createRewards(dir);
    const weekReads = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([file]) => String(file).includes(path.join("rewards", "weeks"))).length;
    const reads = vi.spyOn(fs, "readFileSync");
    try {
      const ask = () => {
        const before = weekReads(reads);
        const summary = server.summary(end + 10);
        const mine = server.view(BOB.address, end + 10);
        return { summary, mine, read: weekReads(reads) - before };
      };
      // Nothing is closed: there is nothing to read.
      expect(ask()).toMatchObject({ summary: { weeksPaid: 0 }, mine: { payouts: [] }, read: 0 });
      // The tools close the week. The server's next answer has it, from one reading of the file.
      tools.closeWeek("2026-W41", 10n ** 8n, "ZEC", 1n, end, CLEAR);
      expect(ask()).toMatchObject({ summary: { weeksPaid: 0 }, mine: { payouts: [{ week: "2026-W41", txs: [] }] }, read: 1 });
      // Asked again and again, the file is not read again.
      for (let i = 0; i < 5; i++) expect(ask().read).toBe(0);
      // The tools record a payout. The next answer has that too, from one more reading.
      const hash = signature("b2");
      tools.recordPaid("2026-W41", [{ address: BOB.address, hash }], end + 5);
      expect(ask()).toMatchObject({ summary: { weeksPaid: 1, totalPaid: "75000000" }, mine: { payouts: [{ week: "2026-W41", txs: [hash] }] }, read: 1 });
      for (let i = 0; i < 5; i++) expect(ask().read).toBe(0);
      // A week's file taken away is gone from the next answer.
      fs.rmSync(path.join(dir, "rewards", "weeks", "2026-W41.json"));
      expect(ask()).toMatchObject({ summary: { weeksPaid: 0 }, mine: { payouts: [] }, read: 0 });
    } finally {
      reads.mockRestore();
    }
  });
});

describe("the payout tools", () => {
  const end = MONDAY + WEEK_MS;
  /** The reward coin: ZEC on Solana, by its mint there. */
  const MINT = RESERVE_ASSET.contract;
  const TOKEN = { address: MINT, decimals: 8 };
  /** The mint of some other coin on Solana, with 6 decimals. */
  const OTHER_MINT = wallet("another mint").address;
  const ONE = 10n ** 8n;
  /** Alice has 250 points and Bob 500 in week 41: a third and two thirds. */
  const seeded = (dir = tempDir()) => {
    const rewards = createRewards(dir);
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "50" }));
    return rewards;
  };
  /** Solana as the tools see it: the reserve wallet holds this much ZEC. Bob has an account for ZEC already; Alice has none yet. */
  const chain = (holds: bigint = 100n * ONE): FakeRpc => {
    const rpc = createFakeRpc();
    rpc.solHeld.set(`${MINT}:${RESERVE}`, [holds]);
    rpc.solHeld.set(`${MINT}:${BOB.address}`, [0n]);
    return rpc;
  };
  /** Solana as an endpoint that changes each token account in its answers before it gives them. */
  const answering = (change: (account: { owner: unknown; data: { parsed: { type: unknown; info: { mint: unknown; owner: unknown; tokenAmount: { amount: unknown } } } } }) => void): FakeRpc => {
    const rpc = chain(3n * ONE);
    const real = rpc.solana;
    rpc.solana = async (calls: RpcCall[]): Promise<RpcResult[]> =>
      (await real(calls)).map((reply, index) => {
        if (reply.ok && calls[index]?.method === "getTokenAccountsByOwner") for (const entry of (reply.result as { value: { account: Parameters<typeof change>[0] }[] }).value) change(entry.account);
        return reply;
      });
    return rpc;
  };
  /** The export tool, as the script calls it. Without `close` it is a look. */
  const run = (rewards: Rewards, pool: bigint, extra: Partial<Parameters<typeof exportWeek>[0]> = {}) => exportWeek({ rewards, sanctions: CLEAR, rpc: chain(), reserve: RESERVE, token: TOKEN, week: "2026-W41", pool, asset: "ZEC", now: end, ...extra });
  const shareOf = (record: WeekRecord, who: { address: string }) => record.shares.find((share) => share.address === who.address)!;
  const HEADER = "rewards_address,points,share,payout_zec,carried_points,withheld_zec";

  it("write the same list every time for the same week, and it adds up to the pool exactly", async () => {
    const rewards = seeded();
    const first = await run(rewards, 3n * ONE, { close: true });
    const second = await run(rewards, 3n * ONE, { close: true, asset: "zec", now: end + 5 * 86_400_000 });
    expect(first).toMatchObject({ closed: true, already: false });
    expect(second).toMatchObject({ closed: true, already: true });
    expect(second.csv).toBe(first.csv);
    expect(second.summary).toEqual(first.summary);
    // In the order of the addresses, letter for letter.
    const [alice, bob] = [ALICE.address, BOB.address].sort();
    expect(first.csv.split("\n")[0]).toBe(`${HEADER},needs_zec_account`);
    expect(first.csv.split("\n").slice(1, 3).map((line) => line.split(",")[0])).toEqual([alice, bob]);
    // The last column says who has no account for ZEC yet: a payment to Alice has to open one first.
    expect(first.csv).toContain(`${ALICE.address},250.000000,0.33333333,1,0.000000,0,yes\n`);
    expect(first.csv).toContain(`${BOB.address},500.000000,0.66666666,2,0.000000,0,no\n`);
    expect(first.needAccount).toEqual([ALICE.address]);
    // The week's volume is Alice's $25 and Bob's $50, and its points are ten times that.
    expect(first.summary).toEqual({ week: "2026-W41", from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", asset: "ZEC", pool: "3", paid: "3", leftInReserve: "0", withheld: "0", addresses: 2, addressesPaid: 2, addressesCarried: 0, addressesWithheld: 0, totalPoints: "750.000000", volumeUsd: "75.000000" });
    expect(BigInt(first.record.paid) + BigInt(first.record.left)).toBe(3n * ONE);
    expect(weekCsv(first.record, new Set(first.needAccount))).toBe(first.csv);
    // Without the answer from Solana it is the same list, less that one column.
    expect(weekCsv(first.record).split("\n")[0]).toBe(HEADER);
    expect(weekCsv(first.record)).toBe(first.csv.replace(",needs_zec_account", "").replace(",yes\n", "\n").replace(",no\n", "\n"));
  });

  it("work in ZEC, in the coin's own 8 decimals: a pool of 12.5 is 1250000000 of its smallest unit, each share is rounded down, and together they are never more than the pool", async () => {
    expect(poolAmount("12.5", 8)).toBe(1_250_000_000n);
    expect(poolAmount("0.00000001", 8)).toBe(1n);
    for (const bad of ["", "twelve", "-1", "1e3", "0.000000001", "1,2,3"]) expect(() => poolAmount(bad, 8), bad).toThrow(/is not an amount of ZEC\./);
    // Alice has a third of the week's points and Bob two thirds.
    const closed = await run(seeded(), poolAmount("12.5", 8), { close: true });
    expect(closed.record).toMatchObject({ asset: "ZEC", decimals: 8, pool: "1250000000", paid: "1249999999", left: "1" });
    expect(shareOf(closed.record, ALICE).payout).toBe("416666666");
    expect(shareOf(closed.record, BOB).payout).toBe("833333333");
    expect(closed.record.shares.reduce((sum, share) => sum + BigInt(share.payout), 0n) <= 1_250_000_000n).toBe(true);
    // The list and the summary say it in ZEC, to the last decimal.
    expect(closed.summary).toMatchObject({ asset: "ZEC", pool: "12.5", paid: "12.49999999", leftInReserve: "0.00000001" });
    expect(closed.csv.split("\n")[0]).toBe(`${HEADER},needs_zec_account`);
    expect(closed.csv).toContain(`${ALICE.address},250.000000,0.33333333,4.16666666,0.000000,0,yes\n`);
    expect(closed.csv).toContain(`${BOB.address},500.000000,0.66666666,8.33333333,0.000000,0,no\n`);

    // The coin's decimals are the ones its mint reports on Solana: 8 for the built-in one.
    const rpc = chain();
    expect(await rewardTokenDecimals(rpc, MINT)).toBe(8);
    expect(rpc.solCalls).toEqual([{ method: "getTokenSupply", params: [MINT, { commitment: "finalized" }] }]);
    // Any other mint is asked for its own, and where it will not say, nothing is guessed.
    rpc.solDecimals.set(OTHER_MINT, 6);
    expect(await rewardTokenDecimals(rpc, OTHER_MINT)).toBe(6);
    expect(await rewardTokenDecimals(rpc, wallet("no such mint").address)).toBeNull();
    // The built-in mint is known to have 8. An endpoint that says anything else of it is not believed.
    for (const said of [9, 6, 18, 0]) {
      const wrong = chain();
      wrong.solDecimals.set(MINT, said);
      expect(await rewardTokenDecimals(wrong, MINT), String(said)).toBeNull();
    }
    const down = chain();
    down.solDown = true;
    expect(await rewardTokenDecimals(down, MINT)).toBeNull();
    const broken = chain();
    broken.solana = () => Promise.reject(new Error("offline"));
    expect(await rewardTokenDecimals(broken, MINT)).toBeNull();
    // Worked in another coin's units, the same pool typed the same way is another number, and the week keeps the decimals it was closed with.
    expect(poolAmount("12.5", 6)).toBe(12_500_000n);
    rpc.solHeld.set(`${OTHER_MINT}:${RESERVE}`, [100n * ONE]);
    const six = await run(seeded(), poolAmount("12.5", 6), { close: true, rpc, token: { address: OTHER_MINT, decimals: 6 } });
    expect(six.record).toMatchObject({ asset: "ZEC", decimals: 6, pool: "12500000", paid: "12499999", left: "1" });
    expect(six.summary).toMatchObject({ pool: "12.5", paid: "12.499999" });
    expect(six.reserveHolds).toBe(100n * ONE);
  });

  it("show what closing a week would do and write nothing at all, until told to close", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const before = everything(dir);
    // No word to close, a plain no, and things that are not the word: each is a look.
    const looks = [await run(rewards, 3n * ONE), await run(rewards, 3n * ONE, { close: false }), await run(rewards, 3n * ONE, { close: "yes" as never }), await run(rewards, 3n * ONE, { close: 1 as never })];
    for (const look of looks) {
      expect(look).toMatchObject({ closed: false, already: false, reserveHolds: 100n * ONE, needAccount: [ALICE.address] });
      // All that closing would do is there to be read: the addresses, the points, the week's volume, each share and payout, what is carried, what is kept back and what stays in the reserve.
      expect(look.summary).toEqual({ week: "2026-W41", from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", asset: "ZEC", pool: "3", paid: "3", leftInReserve: "0", withheld: "0", addresses: 2, addressesPaid: 2, addressesCarried: 0, addressesWithheld: 0, totalPoints: "750.000000", volumeUsd: "75.000000" });
      expect(look.csv).toContain(`${ALICE.address},250.000000,0.33333333,1,0.000000,0,yes\n`);
      expect(look.csv).toContain(`${BOB.address},500.000000,0.66666666,2,0.000000,0,no\n`);
    }
    // A look may be had with another pool, as often as wanted: looking fixes nothing.
    expect((await run(rewards, 6n * ONE)).summary).toMatchObject({ pool: "6", paid: "6" });
    // Nothing was written: no week's record, no list, not a byte in the data folder.
    expect(everything(dir)).toEqual(before);
    expect(rewards.week("2026-W41")).toBeNull();
    expect(createRewards(dir).week("2026-W41")).toBeNull();
    // Told to close, it writes the record that a look showed.
    const closed = await run(rewards, 3n * ONE, { close: true });
    expect(closed.record).toEqual(looks[0]?.record);
    expect(createRewards(dir).week("2026-W41")).toEqual(closed.record);
    // From then on a look shows the week as it stands, and another pool is refused, looking or closing.
    expect(await run(rewards, 3n * ONE)).toMatchObject({ closed: true, already: true, record: closed.record });
    await expect(run(rewards, 6n * ONE)).rejects.toThrow(/already closed/);
    await expect(run(rewards, 6n * ONE, { close: true })).rejects.toThrow(/already closed/);
  });

  it("read from Solana what the reserve wallet holds of the reward coin, over all its accounts, and believe no answer that is about anything else", async () => {
    const rpc = createFakeRpc();
    // A wallet with no account for the coin holds none of it.
    expect(await reserveHolds(rpc, RESERVE, MINT)).toEqual({ amount: 0n, decimals: 8 });
    // A wallet may keep one coin in more than one account: they are added up.
    rpc.solHeld.set(`${MINT}:${RESERVE}`, [3n * ONE, 0n, 5n]);
    expect(await reserveHolds(rpc, RESERVE, MINT)).toEqual({ amount: 3n * ONE + 5n, decimals: 8 });
    // Two things were asked, of blocks that can no longer be undone: this wallet's accounts of this mint, and the mint's decimals.
    expect(rpc.solCalls.slice(-2)).toEqual([
      { method: "getTokenAccountsByOwner", params: [RESERVE, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }] },
      { method: "getTokenSupply", params: [MINT, { commitment: "finalized" }] },
    ]);
    // Another coin in the wallet, and the same coin in another wallet, are no part of it.
    rpc.solHeld.set(`${OTHER_MINT}:${RESERVE}`, [999n * ONE]);
    rpc.solHeld.set(`${MINT}:${CAROL.address}`, [7n * ONE]);
    expect(await reserveHolds(rpc, RESERVE, MINT)).toEqual({ amount: 3n * ONE + 5n, decimals: 8 });
    expect(await reserveHolds(rpc, CAROL.address, MINT)).toEqual({ amount: 7n * ONE, decimals: 8 });

    // An answer with an account in it that is not this mint's, not this wallet's, not kept by a token program,
    // not a token account at all, or with an amount that is no whole number, is not believed at all.
    const unbelieved: Record<string, FakeRpc> = {
      "another coin's account": chain(3n * ONE),
      "another wallet's account": answering((account) => (account.data.parsed.info.owner = CAROL.address)),
      "an account kept by a program that keeps no tokens": answering((account) => (account.owner = "11111111111111111111111111111111")),
      "something that is not a token account": answering((account) => (account.data.parsed.type = "mint")),
      "an amount with a fraction": answering((account) => (account.data.parsed.info.tokenAmount.amount = "1.5")),
      "an amount under nothing": answering((account) => (account.data.parsed.info.tokenAmount.amount = "-1")),
      "an amount that is not written as text": answering((account) => (account.data.parsed.info.tokenAmount.amount = 300_000_000)),
      "a mint that says it has 9 decimals": chain(3n * ONE),
      "an answer that is no list": chain(3n * ONE),
      "an endpoint that cannot be reached": chain(3n * ONE),
      "an endpoint that fails": chain(3n * ONE),
    };
    unbelieved["another coin's account"]!.solWrongMint = OTHER_MINT;
    unbelieved["a mint that says it has 9 decimals"]!.solDecimals.set(MINT, 9);
    unbelieved["an answer that is no list"]!.solana = async (calls) => calls.map(() => ({ ok: true as const, result: "0x" }));
    unbelieved["an endpoint that cannot be reached"]!.solDown = true;
    unbelieved["an endpoint that fails"]!.solana = () => Promise.reject(new Error("offline"));
    for (const [what, odd] of Object.entries(unbelieved)) {
      expect(await reserveHolds(odd, RESERVE, MINT), what).toBeNull();
      // And no week is closed on the strength of it.
      const rewards = seeded();
      await expect(run(rewards, ONE, { close: true, rpc: odd }), what).rejects.toThrow(/The reserve wallet's balance could not be read from Solana, so the pool could not be checked against it\. Nothing was closed\./);
      expect(rewards.week("2026-W41"), what).toBeNull();
    }
    // A mint that Solana does not know has no decimals to go by.
    expect(await reserveHolds(chain(), RESERVE, wallet("no such mint").address)).toBeNull();
  });

  it("say which addresses have no account for the reward coin yet, and nothing either way when Solana cannot be read", async () => {
    const rpc = chain();
    rpc.solHeld.set(`${OTHER_MINT}:${ALICE.address}`, [5n]);
    // Bob has an account for ZEC, though it is empty. Alice has one for another coin only, and Carol none at all.
    expect(await withoutAccount(rpc, [ALICE.address, BOB.address, CAROL.address], MINT)).toEqual(new Set([ALICE.address, CAROL.address]));
    expect(await withoutAccount(rpc, [], MINT)).toEqual(new Set());
    // Many are asked a few at a time, and each is answered for itself.
    const many = Array.from({ length: 23 }, (_, index) => wallet(`holder ${index}`).address);
    for (const [index, holder] of many.entries()) if (index % 3 === 0) rpc.solHeld.set(`${MINT}:${holder}`, [1n]);
    expect(await withoutAccount(rpc, many, MINT)).toEqual(new Set(many.filter((_, index) => index % 3 !== 0)));
    // Unreadable: null, which is not "everyone has one".
    const down = chain();
    down.solDown = true;
    expect(await withoutAccount(down, [ALICE.address], MINT)).toBeNull();
    expect(await withoutAccount(answering((account) => (account.data.parsed.info.owner = CAROL.address)), [BOB.address], MINT)).toBeNull();
    const wrong = chain();
    wrong.solWrongMint = OTHER_MINT;
    expect(await withoutAccount(wrong, [BOB.address], MINT)).toBeNull();
    const broken = chain();
    broken.solana = () => Promise.reject(new Error("offline"));
    expect(await withoutAccount(broken, [ALICE.address], MINT)).toBeNull();

    // The list says it in a last column, only for an address that is to be paid. Where Solana was not asked, or did not answer, the column is not there.
    const rewards = seeded();
    const look = await run(rewards, 3n * ONE);
    expect(look.needAccount).toEqual([ALICE.address]);
    expect(weekCsv(look.record, new Set([ALICE.address, BOB.address])).split("\n").slice(0, 3).map((line) => line.split(",").at(-1))).toEqual(["needs_zec_account", ...[ALICE.address, BOB.address].sort().map(() => "yes")]);
    expect(weekCsv(look.record, new Set()).split("\n").slice(1, 3).map((line) => line.split(",").at(-1))).toEqual(["no", "no"]);
    for (const unasked of [await run(rewards, 3n * ONE, { rpc: down }), await run(rewards, 3n * ONE, { reserve: null }), await run(rewards, 0n)]) {
      expect(unasked.needAccount).toBeNull();
      expect(unasked.csv.split("\n")[0]).toBe(HEADER);
    }
    // An address that is sent nothing is never said to need one: with a pool of nothing, everyone's points are carried.
    const nothing = await run(rewards, 0n);
    expect(weekCsv(nothing.record, new Set([ALICE.address, BOB.address])).split("\n").slice(1, 3).map((line) => line.split(",").at(-1))).toEqual(["no", "no"]);
  });

  it("do not share out the same coins twice: what an earlier closed week is still owed is not there for the next week's pool", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    // The week after has points of its own.
    rewards.recordDelivered(stored({ id: "D".repeat(27), finishedAt: new Date(end + 3_600_000).toISOString() }));
    const rpc = chain(3n * ONE);
    // Week 41 is closed with the whole 3 ZEC, and nothing has been sent yet.
    expect(await run(rewards, 3n * ONE, { close: true, rpc })).toMatchObject({ closed: true });
    const next = { week: "2026-W42", now: end + WEEK_MS, rpc };
    // The wallet still holds 3 ZEC, and all of it is owed to week 41: week 42 cannot be closed with any of it.
    await expect(run(rewards, ONE, { close: true, ...next })).rejects.toThrow(/The pool is 1 ZEC and the reserve wallet holds 0 that is not already owed to earlier weeks \(3 is\)\. A week is not closed with more than the reserve holds\. Nothing was closed\./);
    expect(rewards.week("2026-W42")).toBeNull();
    // A look says what is free, which is nothing.
    expect(await run(rewards, ONE, next)).toMatchObject({ closed: false, reserveHolds: 0n });
    // More arrives in the wallet: only what is beyond the 3 that are owed can be shared out.
    rpc.solHeld.set(`${MINT}:${RESERVE}`, [5n * ONE]);
    await expect(run(rewards, 2n * ONE + 1n, { close: true, ...next })).rejects.toThrow(/Nothing was closed/);
    expect(await run(rewards, 2n * ONE, { close: true, ...next })).toMatchObject({ closed: true, reserveHolds: 2n * ONE });
  });

  it("close nothing with a pool larger than the reserve wallet holds, or when what it holds cannot be read", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const rpc = chain(2n * ONE);
    await expect(run(rewards, 3n * ONE, { close: true, rpc })).rejects.toThrow(/The pool is 3 ZEC and the reserve wallet holds 2\. A week is not closed with more than the reserve holds\. Nothing was closed\./);
    await expect(run(rewards, 2n * ONE + 1n, { close: true, rpc })).rejects.toThrow(/Nothing was closed/);
    expect(rewards.week("2026-W41")).toBeNull();
    // Solana was asked: about the reserve wallet's accounts of the payout coin's own mint.
    const asked = rpc.solCalls.find((call) => call.method === "getTokenAccountsByOwner" && call.params[0] === RESERVE);
    expect(asked?.params).toEqual([RESERVE, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }]);
    // No other chain was.
    expect(rpc.calls).toEqual([]);
    expect(await reserveHolds(rpc, RESERVE, MINT)).toEqual({ amount: 2n * ONE, decimals: 8 });
    // The chain cannot be read: no week is closed with anything to pay, however little.
    const down = chain();
    down.solDown = true;
    expect(await reserveHolds(down, RESERVE, MINT)).toBeNull();
    for (const pool of [3n * ONE, 1n]) await expect(run(rewards, pool, { close: true, rpc: down }), String(pool)).rejects.toThrow(/The reserve wallet's balance could not be read from Solana, so the pool could not be checked against it\. Nothing was closed\./);
    // An answer that is no list of accounts is no balance.
    const odd = chain();
    odd.solana = async (calls) => calls.map(() => ({ ok: true as const, result: "0x" }));
    await expect(run(rewards, ONE, { close: true, rpc: odd })).rejects.toThrow(/could not be read/);
    // With no reserve wallet set there is nothing to check a pool against.
    await expect(run(rewards, ONE, { close: true, reserve: null })).rejects.toThrow(/RESERVE_ADDRESS is not set, so there is no reserve wallet to check the pool against\. Nothing was closed\./);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
    // A look is still to be had while the chain is down, and it says that the balance is not known.
    expect(await run(rewards, 3n * ONE, { rpc: down })).toMatchObject({ closed: false, reserveHolds: null });
    expect(await run(rewards, 3n * ONE, { reserve: null })).toMatchObject({ closed: false, reserveHolds: null });
    // Exactly what the reserve holds can be shared out.
    expect(await run(rewards, 2n * ONE, { close: true, rpc })).toMatchObject({ closed: true, already: false, reserveHolds: 2n * ONE });
    // A week that is closed is read back as it stands without the chain: by then its payouts may have left the reserve.
    expect(await run(rewards, 2n * ONE, { close: true, rpc: down })).toMatchObject({ closed: true, already: true });
  });

  it("refuse another coin, a pool under nothing, and a second pool for a closed week", async () => {
    const rewards = seeded();
    for (const asset of ["NEAR", "SOL", "BNB", ""]) await expect(run(rewards, ONE, { asset, close: true }), asset).rejects.toThrow(/sent in ZEC/);
    await expect(run(rewards, -1n, { close: true })).rejects.toThrow(/less than nothing/);
    expect(rewards.week("2026-W41")).toBeNull();
    await run(rewards, ONE, { close: true });
    await expect(run(rewards, 2n * ONE, { close: true })).rejects.toThrow(/already closed/);
  });

  it("close a week with a pool of nothing, which carries every address's points and needs nothing in the reserve", async () => {
    const rewards = seeded();
    const closed = await run(rewards, 0n, { close: true, rpc: chain(0n) });
    expect(closed.summary).toMatchObject({ pool: "0", paid: "0", leftInReserve: "0", addresses: 2, addressesPaid: 0, addressesCarried: 2, addressesWithheld: 0 });
    expect(closed.csv).toContain(`${ALICE.address},250.000000,0.33333333,0,250.000000,0\n`);
    const next = rewards.weekPoints("2026-W42");
    expect([next.get(ALICE.address), next.get(BOB.address)]).toEqual([250n * MICRO, 500n * MICRO]);
  });

  it("close a week with a pool of nothing before there is any reserve wallet, or while the chain cannot be read: nothing is to be sent, so there is nothing to check", async () => {
    const down = chain();
    down.solDown = true;
    const unread = seeded();
    expect(await run(unread, 0n, { close: true, rpc: down })).toMatchObject({ closed: true, already: false, reserveHolds: null });
    expect(unread.week("2026-W41")).toMatchObject({ pool: "0", paid: "0" });
    const none = seeded();
    expect(await run(none, 0n, { close: true, reserve: null })).toMatchObject({ closed: true, already: false, reserveHolds: null });
    expect(none.weekPoints("2026-W42").get(ALICE.address)).toBe(250n * MICRO);
    // With anything at all to pay, both are refused as before.
    const paying = seeded();
    await expect(run(paying, 1n, { close: true, reserve: null })).rejects.toThrow(/RESERVE_ADDRESS is not set/);
    await expect(run(paying, 1n, { close: true, rpc: down })).rejects.toThrow(/could not be read/);
    expect(paying.week("2026-W41")).toBeNull();
  });

  it("screen the payout list: an address on the sanctions list is left out, shown as withheld and counted", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const listed = createStaticSanctions([BOB.address]);
    const look = await run(rewards, 3n * ONE, { sanctions: listed });
    // Alice is sent her third. Bob's two thirds are kept back and stay in the reserve.
    expect(look.summary).toMatchObject({ pool: "3", paid: "1", leftInReserve: "2", withheld: "2", addresses: 2, addressesPaid: 1, addressesCarried: 0, addressesWithheld: 1 });
    expect(look.csv).toContain(`${ALICE.address},250.000000,0.33333333,1,0.000000,0,yes\n`);
    expect(look.csv).toContain(`${BOB.address},500.000000,0.66666666,0,0.000000,2,no\n`);
    expect(rewards.week("2026-W41")).toBeNull();
    const closed = await run(rewards, 3n * ONE, { sanctions: listed, close: true });
    expect(closed.record).toEqual(look.record);
    expect(shareOf(closed.record, BOB)).toEqual({ address: BOB.address, pointsMicro: "500000000", payout: "0", carriedMicro: "0", withheld: (2n * ONE).toString() });
    expect(shareOf(closed.record, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: ONE.toString(), carriedMicro: "0" });
    // An address that is sent nothing is not said to need an account, whatever it has.
    expect(weekCsv(closed.record, new Set([ALICE.address, BOB.address]))).toContain(`${BOB.address},500.000000,0.66666666,0,0.000000,2,no\n`);
    // Bob's own view has no payout for the week, and nothing carried.
    expect(rewards.view(BOB.address, end + 1)).toMatchObject({ payouts: [], week: { carriedInMicro: "0" } });
    // Read back later against a list that no longer names Bob, the week stands as it was closed.
    expect((await run(rewards, 3n * ONE, { close: true })).record).toEqual(closed.record);
    // A transfer to the address that was left out is no payout of this week, and is not recorded as one.
    const rpc = chain();
    const toBob = signature("to the one left out");
    rpc.solTxs.set(toBob, solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 98n * ONE), solBalance(BOB.address, 2n * ONE)]));
    expect(await checkPayoutTx(rpc, RESERVE, toBob, MINT)).toEqual({ ok: true, transfers: [{ to: BOB.address, amount: 2n * ONE }] });
    await expect(recordPayouts({ rewards, rpc, reserve: RESERVE, token: MINT, week: "2026-W41", hashes: [toBob], now: end })).rejects.toThrow(/holds no transfer/);
    expect(rewards.week("2026-W41")?.txs).toEqual([]);
  });

  it("show nothing and close nothing while the sanctions list is missing or out of date", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const none = createStaticSanctions([], { available: false });
    await expect(run(rewards, ONE, { sanctions: none })).rejects.toThrow(/sanctions list is missing or out of date/);
    await expect(run(rewards, ONE, { sanctions: none, close: true })).rejects.toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
  });

  describe("recording what was sent", () => {
    const hashOf = (label: string) => signature(label);
    const record = (rewards: Rewards, rpc: FakeRpc, hashes: string[], week = "2026-W41") => recordPayouts({ rewards, rpc, reserve: RESERVE, token: MINT, week, hashes, now: end + 60_000 });
    /** Week 41 closed with a pool of 3: Alice is due 1 and Bob 2. */
    const closedWeek = async () => {
      const rewards = seeded();
      await run(rewards, 3n * ONE, { close: true });
      return rewards;
    };
    /** A transaction that went through for good, in which one wallet's holding of a coin went down by an amount and another's went up by it. */
    const pay = (rpc: FakeRpc, label: string, to: string, amount: bigint, options: { from?: string; mint?: string } = {}) => {
      const hash = hashOf(label);
      const from = options.from ?? RESERVE;
      const mint = options.mint === undefined ? {} : { mint: options.mint };
      rpc.solTxs.set(hash, solTx([solBalance(from, 100n * ONE, mint)], [solBalance(from, 100n * ONE - amount, mint), solBalance(to, amount, mint)]));
      return hash;
    };
    /** Puts a transaction on the chain as it is given, and names it. */
    const put = (rpc: FakeRpc, label: string, tx: unknown) => {
      rpc.solTxs.set(hashOf(label), tx);
      return hashOf(label);
    };
    const none = /holds no transfer of ZEC from the reserve wallet to an address still to be paid in week 2026-W41, for exactly its payout\. Nothing was recorded\./;
    const notFromReserve = "it took nothing of the reward coin out of the reserve wallet";
    const unreadable = "Solana's answer could not be read";

    it("check on Solana that a transaction went through for good and took the reward coin out of the reserve wallet, and read what each wallet gained by it", async () => {
      const rpc = chain();
      const good = pay(rpc, "good", ALICE.address, ONE);
      expect(good).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
      expect(await checkPayoutTx(rpc, RESERVE, good, MINT)).toEqual({ ok: true, transfers: [{ to: ALICE.address, amount: ONE }] });
      // It was asked for among the blocks that can no longer be undone: a transaction still on its way is not found there.
      expect(rpc.solCalls.at(-1)).toEqual({ method: "getTransaction", params: [good, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }] });
      expect(rpc.calls).toEqual([]);
      // Each of these holds a transfer that would pass: what stops it is where the coins came from, or that it failed.
      const foreign = pay(rpc, "foreign", BOB.address, 2n * ONE, { from: CAROL.address });
      expect(await checkPayoutTx(rpc, RESERVE, foreign, MINT)).toEqual({ ok: false, reason: notFromReserve });
      const failed = put(rpc, "failed", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 98n * ONE), solBalance(BOB.address, 2n * ONE)], { InstructionError: [0, { Custom: 1 }] }));
      expect(await checkPayoutTx(rpc, RESERVE, failed, MINT)).toEqual({ ok: false, reason: "it failed on-chain" });
      // Not there, or there and not final yet: Solana gives the same answer for both, and so do the tools.
      expect(await checkPayoutTx(rpc, RESERVE, hashOf("unknown"), MINT)).toEqual({ ok: false, reason: "no such transaction on Solana, or it is not final yet" });
      // A signature has one spelling. The same letters in another case are another transaction, which is not on Solana.
      expect(await checkPayoutTx(rpc, RESERVE, good.toLowerCase().replace(/[l0]/g, "L"), MINT)).toEqual({ ok: false, reason: "no such transaction on Solana, or it is not final yet" });
      // What is not written as Solana writes a signature is not asked about at all: a hash of another chain, something too short, a letter Solana does not use.
      const asked = rpc.solCalls.length;
      for (const bad of ["0x1234", `0x${"a1".repeat(32)}`, "a1".repeat(32).replace(/1/g, "0"), good.slice(0, 63), `${good}${good}`.slice(0, 89), `${good.slice(0, 70)}0`, `${good.slice(0, 70)}l`, `${good.slice(0, 40)} ${good.slice(41)}`, ""]) expect(await checkPayoutTx(rpc, RESERVE, bad, MINT), bad).toEqual({ ok: false, reason: "that is not a Solana transaction signature" });
      expect(rpc.solCalls.length).toBe(asked);
      // The reserve wallet's holding going up, or staying as it was, is no payout.
      const received = put(rpc, "received", solTx([solBalance(RESERVE, 100n * ONE), solBalance(CAROL.address, 5n * ONE)], [solBalance(RESERVE, 102n * ONE), solBalance(CAROL.address, 3n * ONE)]));
      expect(await checkPayoutTx(rpc, RESERVE, received, MINT)).toEqual({ ok: false, reason: notFromReserve });
      const still = put(rpc, "still", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 100n * ONE)]));
      expect(await checkPayoutTx(rpc, RESERVE, still, MINT)).toEqual({ ok: false, reason: notFromReserve });
      // A transaction that moved no coin at all, only SOL: the same.
      expect(await checkPayoutTx(rpc, RESERVE, put(rpc, "sol only", solTx([], [])), MINT)).toEqual({ ok: false, reason: notFromReserve });
      expect(await checkPayoutTx(rpc, RESERVE, put(rpc, "no lists", { slot: 1, meta: { err: null }, transaction: {} }), MINT)).toEqual({ ok: false, reason: notFromReserve });

      // What it holds is what each wallet held of the reward coin before and after, added up over its accounts, and nothing else.
      const mixed = put(
        rpc,
        "mixed",
        solTx(
          [
            // The reserve keeps the coin in two accounts, and another coin beside them.
            solBalance(RESERVE, 60n * ONE, { accountIndex: 1 }),
            solBalance(RESERVE, 40n * ONE, { accountIndex: 2 }),
            solBalance(RESERVE, 500n * ONE, { mint: OTHER_MINT, accountIndex: 3 }),
            solBalance(CAROL.address, 9n * ONE, { accountIndex: 4 }),
            solBalance(BOB.address, 4n, { accountIndex: 5 }),
          ],
          [
            solBalance(RESERVE, 59n * ONE, { accountIndex: 1 }),
            solBalance(RESERVE, 39n * ONE, { accountIndex: 2 }),
            // The other coin goes to Alice, in the very amount she is due: it pays nobody.
            solBalance(RESERVE, 499n * ONE, { mint: OTHER_MINT, accountIndex: 3 }),
            solBalance(ALICE.address, ONE, { mint: OTHER_MINT, accountIndex: 6 }),
            // Carol's holding does not change, and she is paid nothing.
            solBalance(CAROL.address, 9n * ONE, { accountIndex: 4 }),
            // Bob gains over two accounts: 2 in all.
            solBalance(BOB.address, 4n + ONE, { accountIndex: 5 }),
            solBalance(BOB.address, ONE, { accountIndex: 7 }),
          ],
        ),
      );
      expect(await checkPayoutTx(rpc, RESERVE, mixed, MINT)).toEqual({ ok: true, transfers: [{ to: BOB.address, amount: 2n * ONE }] });
      // Asked about the other coin, the same transaction is a payout of that coin, to Alice.
      expect(await checkPayoutTx(rpc, RESERVE, mixed, OTHER_MINT)).toEqual({ ok: true, transfers: [{ to: ALICE.address, amount: ONE }] });
      // One transaction can pay several wallets: each is one transfer, for exactly what it gained.
      const both = put(rpc, "both", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 97n * ONE), solBalance(ALICE.address, ONE), solBalance(BOB.address, 2n * ONE)]));
      expect(await checkPayoutTx(rpc, RESERVE, both, MINT)).toEqual({ ok: true, transfers: [{ to: ALICE.address, amount: ONE }, { to: BOB.address, amount: 2n * ONE }] });
      // What left the reserve and was burnt or kept as a fee reached nobody: only what arrived is a transfer.
      const partly = put(rpc, "partly", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 97n * ONE), solBalance(ALICE.address, ONE)]));
      expect(await checkPayoutTx(rpc, RESERVE, partly, MINT)).toEqual({ ok: true, transfers: [{ to: ALICE.address, amount: ONE }] });
      // A holder that is named in letters which are no Solana address is nobody's rewards address, and is never matched.
      const program = put(rpc, "program", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 99n * ONE), solBalance("not an address", ONE)]));
      expect(await checkPayoutTx(rpc, RESERVE, program, MINT)).toEqual({ ok: true, transfers: [] });

      // Any other wallet's holding of the coin going down makes it something other than a payout from the reserve.
      const twoSenders = put(rpc, "two senders", solTx([solBalance(RESERVE, 100n * ONE), solBalance(CAROL.address, 5n * ONE)], [solBalance(RESERVE, 99n * ONE), solBalance(CAROL.address, 4n * ONE), solBalance(ALICE.address, 2n * ONE)]));
      expect(await checkPayoutTx(rpc, RESERVE, twoSenders, MINT)).toEqual({ ok: false, reason: "it also took the reward coin out of another wallet, so it cannot be read as a payout from the reserve" });
      // More arriving than left the reserve is not one either.
      const minted = put(rpc, "minted", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 100n * ONE - 1n), solBalance(ALICE.address, ONE)]));
      expect(await checkPayoutTx(rpc, RESERVE, minted, MINT)).toEqual({ ok: false, reason: "more of the reward coin arrived than left the reserve wallet, so it cannot be read as a payout from the reserve" });

      // An answer that does not say who owns an account, or which program keeps it, or that names a program that keeps no tokens, is not read.
      const paidTo = (entry: Record<string, unknown>) => solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 99n * ONE), entry]);
      const without = (key: string) => Object.fromEntries(Object.entries(solBalance(ALICE.address, ONE)).filter(([name]) => name !== key));
      const odd: Record<string, unknown> = {
        "no wallet named": paidTo(without("owner")),
        "no program": paidTo(without("programId")),
        "no mint": paidTo(without("mint")),
        "another program": paidTo(solBalance(ALICE.address, ONE, { programId: "11111111111111111111111111111111" })),
        "a program named in other letters": paidTo(solBalance(ALICE.address, ONE, { programId: TOKEN_PROGRAM.toLowerCase() })),
        "an amount with a fraction": paidTo({ ...solBalance(ALICE.address, ONE), uiTokenAmount: { amount: "1.5", decimals: 8 } }),
        "an amount that is not text": paidTo({ ...solBalance(ALICE.address, ONE), uiTokenAmount: { amount: 100_000_000, decimals: 8 } }),
        "an entry that is no entry": paidTo("not a balance" as never),
        "a list that is no list": { slot: 1, meta: { err: null, preTokenBalances: [solBalance(RESERVE, 100n * ONE)], postTokenBalances: "none" }, transaction: {} },
        "nothing said of whether it failed": { slot: 1, meta: { preTokenBalances: [solBalance(RESERVE, 100n * ONE)], postTokenBalances: [solBalance(RESERVE, 99n * ONE), solBalance(ALICE.address, ONE)] }, transaction: {} },
        "no account of what it did": { slot: 1, transaction: {} },
        "an answer that is no transaction": "0x",
      };
      for (const [what, tx] of Object.entries(odd)) expect(await checkPayoutTx(rpc, RESERVE, put(rpc, what, tx), MINT), what).toEqual({ ok: false, reason: unreadable });
      // The token program of the newer kind keeps token accounts too.
      const newer = put(rpc, "newer program", paidTo(solBalance(ALICE.address, ONE, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" })));
      expect(await checkPayoutTx(rpc, RESERVE, newer, MINT)).toEqual({ ok: true, transfers: [{ to: ALICE.address, amount: ONE }] });
      rpc.solDown = true;
      expect(await checkPayoutTx(rpc, RESERVE, good, MINT)).toEqual({ ok: false, reason: "Solana could not be read" });
    });

    it("record nothing unless every transaction passes", async () => {
      const rewards = seeded();
      const rpc = chain();
      const good = pay(rpc, "good", ALICE.address, ONE);
      await expect(record(rewards, rpc, [good])).rejects.toThrow(/not closed/);
      await run(rewards, 3n * ONE, { close: true });
      // One bad signature among good ones: nothing is recorded.
      const foreign = pay(rpc, "foreign", BOB.address, 2n * ONE, { from: CAROL.address });
      await expect(record(rewards, rpc, [good, foreign])).rejects.toThrow(/it took nothing of the reward coin out of the reserve wallet\. Nothing was recorded/);
      const failed = put(rpc, "failed", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 98n * ONE), solBalance(BOB.address, 2n * ONE)], { InstructionError: [0, { Custom: 1 }] }));
      await expect(record(rewards, rpc, [good, failed])).rejects.toThrow(/it failed on-chain\. Nothing was recorded/);
      await expect(record(rewards, rpc, [good, hashOf("unknown")])).rejects.toThrow(/no such transaction on Solana, or it is not final yet\. Nothing was recorded/);
      await expect(record(rewards, rpc, [good, `0x${"a1".repeat(32)}`])).rejects.toThrow(/that is not a Solana transaction signature\. Nothing was recorded/);
      // The same letters in another case are not the transaction that paid: a signature is matched letter for letter.
      await expect(record(rewards, rpc, [good.toLowerCase().replace(/[l0]/g, "L")])).rejects.toThrow(/no such transaction on Solana, or it is not final yet\. Nothing was recorded/);
      const down = chain();
      down.solTxs.set(good, rpc.solTxs.get(good));
      down.solDown = true;
      await expect(record(rewards, down, [good])).rejects.toThrow(/Solana could not be read\. Nothing was recorded/);
      expect(rewards.week("2026-W41")?.txs).toEqual([]);
      expect(rewards.week("2026-W41")?.shares.every((share) => share.tx === undefined)).toBe(true);
      await expect(record(rewards, rpc, [])).rejects.toThrow(/at least one/);
      // Given twice, once with space around it, a transaction is recorded once.
      const recorded = await record(rewards, rpc, [good, good, ` ${good} `]);
      expect(recorded.txs.map((tx) => tx.hash)).toEqual([good]);
      expect(shareOf(recorded, ALICE).tx).toBe(good);
      expect(shareOf(recorded, BOB).tx).toBeUndefined();
    });

    it("refuse a transaction that holds no payout on the list: one that moves no reward coin, another coin, another amount, an address that is due nothing", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const nothingLeft = /it took nothing of the reward coin out of the reserve wallet\. Nothing was recorded\./;
      // The reserve wallet lets an unrelated program spend its coins: it came from the reserve and went through, and no coin moved. It pays nobody.
      const approval = put(rpc, "approval", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 100n * ONE)]));
      await expect(record(rewards, rpc, [approval])).rejects.toThrow(nothingLeft);
      // A plain payment of SOL out of the reserve, with no record of any coin moving.
      const plain = put(rpc, "plain", solTx([], []));
      await expect(record(rewards, rpc, [plain])).rejects.toThrow(nothingLeft);
      const elsewhere: Record<string, string> = {
        "another coin, in Alice's amount": pay(rpc, "another coin", ALICE.address, ONE, { mint: OTHER_MINT }),
        "the payout coin out of another wallet": pay(rpc, "another wallet", ALICE.address, ONE, { from: CAROL.address }),
      };
      for (const [what, hash] of Object.entries(elsewhere)) await expect(record(rewards, rpc, [hash]), what).rejects.toThrow(nothingLeft);
      const others: Record<string, string> = {
        "one unit less than Alice's payout": pay(rpc, "less", ALICE.address, ONE - 1n),
        "one unit more": pay(rpc, "more", ALICE.address, ONE + 1n),
        "Bob's amount, to Alice": pay(rpc, "swapped", ALICE.address, 2n * ONE),
        "an address that is not on the list": pay(rpc, "stranger", CAROL.address, ONE),
        "Alice's address in other letters": pay(rpc, "other letters", ALICE.address.toLowerCase(), ONE),
        "coins that left the reserve and reached nobody": put(rpc, "burnt", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 99n * ONE)])),
      };
      for (const [what, hash] of Object.entries(others)) await expect(record(rewards, rpc, [hash]), what).rejects.toThrow(none);
      // One that passes does not carry one that does not.
      const good = pay(rpc, "good", ALICE.address, ONE);
      await expect(record(rewards, rpc, [good, approval])).rejects.toThrow(nothingLeft);
      await expect(record(rewards, rpc, [good, others["one unit more"]!])).rejects.toThrow(none);
      expect(rewards.week("2026-W41")?.txs).toEqual([]);
      expect(rewards.week("2026-W41")?.shares.every((share) => share.tx === undefined)).toBe(true);
    });

    it("take only transfers of the reward coin: the same amount of any other coin, from the same wallet to the same address, is no payout", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const inOther = pay(rpc, "other coin", ALICE.address, ONE, { mint: OTHER_MINT });
      const inZec = pay(rpc, "zec", ALICE.address, ONE);
      await expect(record(rewards, rpc, [inOther])).rejects.toThrow(/it took nothing of the reward coin out of the reserve wallet\. Nothing was recorded\./);
      expect(await checkPayoutTx(rpc, RESERVE, inOther, MINT)).toEqual({ ok: false, reason: notFromReserve });
      // Another coin moving in the same transaction as a payout pays nobody: Bob's 2 ZEC are his payout, and the 1 of another coin that went to Alice is not hers.
      const together = put(
        rpc,
        "together",
        solTx(
          [solBalance(RESERVE, 100n * ONE), solBalance(RESERVE, 100n * ONE, { mint: OTHER_MINT })],
          [solBalance(RESERVE, 98n * ONE), solBalance(BOB.address, 2n * ONE), solBalance(RESERVE, 99n * ONE, { mint: OTHER_MINT }), solBalance(ALICE.address, ONE, { mint: OTHER_MINT })],
        ),
      );
      const other = await closedWeek();
      const paidBob = await record(other, rpc, [together]);
      expect(shareOf(paidBob, BOB).tx).toBe(together);
      expect(shareOf(paidBob, ALICE).tx).toBeUndefined();
      // The coin is the one the server is set to, and no other: with the setting on another mint, a transfer of the built-in one is refused in its turn.
      await expect(recordPayouts({ rewards, rpc, reserve: RESERVE, token: OTHER_MINT, week: "2026-W41", hashes: [inZec], now: end + 60_000 })).rejects.toThrow(/it took nothing of the reward coin out of the reserve wallet\. Nothing was recorded\./);
      expect(rewards.week("2026-W41")?.txs).toEqual([]);
      expect(shareOf(await record(rewards, rpc, [inZec]), ALICE).tx).toBe(inZec);
    });

    it("write down with each payout the transaction that made it, and record a payout once", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const toAlice = pay(rpc, "alice", ALICE.address, ONE);
      const first = await record(rewards, rpc, [toAlice]);
      expect(shareOf(first, ALICE).tx).toBe(toAlice);
      expect(shareOf(first, BOB).tx).toBeUndefined();
      // A second transfer of the same amount to Alice is no payout of this week: hers is on record.
      const again = pay(rpc, "alice again", ALICE.address, ONE);
      await expect(record(rewards, rpc, [again])).rejects.toThrow(none);
      // Two transfers to Bob given together do not both count: the second pays nothing that is still due.
      const bobOne = pay(rpc, "bob one", BOB.address, 2n * ONE);
      const bobTwo = pay(rpc, "bob two", BOB.address, 2n * ONE);
      await expect(record(rewards, rpc, [bobOne, bobTwo])).rejects.toThrow(none);
      expect(shareOf(rewards.week("2026-W41")!, BOB).tx).toBeUndefined();
      const second = await record(rewards, rpc, [bobOne]);
      expect(shareOf(second, BOB).tx).toBe(bobOne);
      expect(shareOf(second, ALICE).tx).toBe(toAlice);
      expect(second.txs.map((tx) => tx.hash)).toEqual([toAlice, bobOne]);
      // One transaction may hold several payouts: it is written down with each of them, and once in the week's list.
      const other = await closedWeek();
      const both = put(rpc, "both", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 97n * ONE), solBalance(ALICE.address, ONE), solBalance(BOB.address, 2n * ONE)]));
      const all = await record(other, rpc, [both]);
      expect(all.shares.map((share) => share.tx)).toEqual([both, both]);
      expect(all.txs.map((tx) => tx.hash)).toEqual([both]);
    });

    it("match each address a transaction paid for itself: the one that was sent exactly its payout is recorded, and the one that was not is still to be paid", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      // One transaction: Alice is sent her 1, Bob one unit short of his 2, and Carol, who is due nothing, 5.
      const uneven = put(rpc, "uneven", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 92n * ONE + 1n), solBalance(ALICE.address, ONE), solBalance(BOB.address, 2n * ONE - 1n), solBalance(CAROL.address, 5n * ONE)]));
      const first = await record(rewards, rpc, [uneven]);
      expect(shareOf(first, ALICE).tx).toBe(uneven);
      expect(shareOf(first, BOB).tx).toBeUndefined();
      expect(first.shares.map((share) => share.address).sort()).toEqual([ALICE.address, BOB.address].sort());
      expect(first.txs.map((tx) => tx.hash)).toEqual([uneven]);
      expect(rewards.summary(end + 120_000)).toMatchObject({ weeks: [{ week: "2026-W41", paid: ONE.toString(), txs: [uneven] }], totalPaid: ONE.toString() });
      // Bob's own transfer, in full, is then his.
      const toBob = pay(rpc, "bob in full", BOB.address, 2n * ONE);
      expect(shareOf(await record(rewards, rpc, [toBob]), BOB).tx).toBe(toBob);
      // A transaction in which nobody was sent exactly a payout records nothing, though it paid two addresses on the list.
      const other = await closedWeek();
      const wrong = put(rpc, "wrong twice", solTx([solBalance(RESERVE, 100n * ONE)], [solBalance(RESERVE, 97n * ONE), solBalance(ALICE.address, 2n * ONE), solBalance(BOB.address, ONE)]));
      await expect(record(other, rpc, [wrong])).rejects.toThrow(none);
      expect(other.week("2026-W41")?.txs).toEqual([]);
    });

    it("refuse a signature that is on record already: one transaction cannot serve two weeks", async () => {
      // Alice alone, with the same swap in week 41 and in week 42: each week, closed with a pool of 1, owes her exactly 1.
      const rewards = createRewards(tempDir());
      rewards.recordDelivered(stored());
      rewards.recordDelivered(stored({ id: "C".repeat(27), finishedAt: new Date(end + 3_600_000).toISOString() }));
      const later = end + WEEK_MS;
      await run(rewards, ONE, { close: true, now: later });
      await run(rewards, ONE, { close: true, now: later, week: "2026-W42" });
      const rpc = chain();
      const paid = pay(rpc, "week 41", ALICE.address, ONE);
      await record(rewards, rpc, [paid]);
      const asked = rpc.solCalls.length;
      // The same signature again for the same week.
      await expect(record(rewards, rpc, [paid])).rejects.toThrow(/it is on record already, for week 2026-W41\. Nothing was recorded\./);
      // The same signature for the next week, where Alice is due exactly what it holds.
      await expect(record(rewards, rpc, [paid], "2026-W42")).rejects.toThrow(/it is on record already, for week 2026-W41\. Nothing was recorded\./);
      await expect(record(rewards, rpc, [` ${paid}\n`], "2026-W42")).rejects.toThrow(/it is on record already, for week 2026-W41\. Nothing was recorded\./);
      // It is refused from the record alone: the chain is not even asked.
      expect(rpc.solCalls.length).toBe(asked);
      expect(rewards.week("2026-W42")).toMatchObject({ txs: [] });
      expect(rewards.week("2026-W42")?.shares[0]?.tx).toBeUndefined();
      expect(rewards.summary(later)).toMatchObject({ weeksPaid: 1, totalPaid: ONE.toString() });
      // Week 42 is paid by a transaction of its own.
      const own = pay(rpc, "week 42", ALICE.address, ONE);
      await record(rewards, rpc, [own], "2026-W42");
      expect(rewards.summary(later)).toMatchObject({ weeksPaid: 2, totalPaid: (2n * ONE).toString() });
      expect(rewards.view(ALICE.address, later).payouts).toEqual([
        { week: "2026-W42", amount: ONE.toString(), asset: "ZEC", decimals: 8, txs: [own] },
        { week: "2026-W41", amount: ONE.toString(), asset: "ZEC", decimals: 8, txs: [paid] },
      ]);
    });

    it("leave the Rewards page saying only what is on record as sent: the week's total, and to each address its own transfer", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const payouts = (who: { address: string }) => rewards.view(who.address, end + 120_000).payouts;
      // Closed, nothing recorded: no week is shown as paid, and each address sees its amount with no transaction.
      expect(rewards.summary(end + 1)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
      expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: ONE.toString(), asset: "ZEC", decimals: 8, txs: [] }]);
      const toAlice = pay(rpc, "alice", ALICE.address, ONE);
      await record(rewards, rpc, [toAlice]);
      // One payout of two is on record: the week has paid 1, not the 3 that were worked out for it.
      expect(rewards.week("2026-W41")?.paid).toBe((3n * ONE).toString());
      expect(rewards.summary(end + 2)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "ZEC", paid: ONE.toString(), txs: [toAlice] }], totalPaid: ONE.toString(), weeksPaid: 1 });
      expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: ONE.toString(), asset: "ZEC", decimals: 8, txs: [toAlice] }]);
      expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: (2n * ONE).toString(), asset: "ZEC", decimals: 8, txs: [] }]);
      const toBob = pay(rpc, "bob", BOB.address, 2n * ONE);
      await record(rewards, rpc, [toBob]);
      expect(rewards.summary(end + 3)).toMatchObject({ weeks: [{ week: "2026-W41", paid: (3n * ONE).toString(), txs: [toAlice, toBob] }], totalPaid: (3n * ONE).toString(), weeksPaid: 1 });
      // Each address is shown its own transfer, and not the other's.
      expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: (2n * ONE).toString(), asset: "ZEC", decimals: 8, txs: [toBob] }]);
      expect(payouts(ALICE)[0]?.txs).toEqual([toAlice]);
    });
  });
});

describe("signing in on the Rewards page", () => {
  const parts = { host: "saplingdex.example", address: ALICE.address, nonce: "ab".repeat(16), issuedAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-05T00:05:00.000Z" };

  it("asks for one plain message, in sentences: the site, the address, what it is for, a code used once and when it runs out, and nothing that could be a transaction", () => {
    const message = signInMessage(parts);
    expect(message.split("\n")).toEqual([
      "Sign in to SaplingDex at saplingdex.example.",
      `Address: ${ALICE.address}`,
      "Sign in to see this address's points. This is not a transaction. It moves nothing, approves nothing and costs no network fee.",
      `Code: ${"ab".repeat(16)}`,
      "Made: 2026-10-05T00:00:00.000Z",
      "Good until: 2026-10-05T00:05:00.000Z",
    ]);
    expect(SIGN_IN_STATEMENT).toBe("Sign in to see this address's points. This is not a transaction. It moves nothing, approves nothing and costs no network fee.");
    // It is text and only text, and it begins with words: a wallet shows it as it is, and it can be taken for nothing else.
    expect(message.startsWith("Sign in to ")).toBe(true);
    expect(message).toMatch(/^[\x20-\x7e\n]+$/);
    // The host is written as the browser knows it, with its port where it has one.
    expect(signInMessage({ ...parts, host: "127.0.0.1:8787" }).split("\n")[0]).toBe("Sign in to SaplingDex at 127.0.0.1:8787.");
    // Nothing of the layout that the wallets of another kind of chain take apart, and no chain named by a number.
    expect(message).not.toMatch(/wants you to sign in|Ethereum|Chain ID|URI:|Version:|Nonce:|Issued At|Expiration Time|0x/);
  });

  it("is known again by the page only when it is, character for character, the message for this site and this address", () => {
    const message = signInMessage(parts);
    expect(isSignInMessage(message, parts)).toBe(true);
    // Another site, another address, the address in other letters.
    expect(isSignInMessage(signInMessage({ ...parts, host: "evil.example" }), parts)).toBe(false);
    expect(isSignInMessage(message, { ...parts, host: "www.saplingdex.example" })).toBe(false);
    expect(isSignInMessage(signInMessage({ ...parts, address: BOB.address }), parts)).toBe(false);
    expect(isSignInMessage(message, { ...parts, address: BOB.address })).toBe(false);
    expect(isSignInMessage(signInMessage({ ...parts, address: ALICE.address.toLowerCase() }), parts)).toBe(false);
    expect(isSignInMessage(message, { ...parts, address: ALICE.address.toLowerCase() })).toBe(false);
    // A character more or less, a line of somebody else's, other wording, the message of another layout.
    const laidOut = [`saplingdex.example wants you to sign in with your Solana account:`, ALICE.address, "", SIGN_IN_STATEMENT, "", `Nonce: ${parts.nonce}`, `Issued At: ${parts.issuedAt}`, `Expiration Time: ${parts.expiresAt}`].join("\n");
    for (const other of [`${message} `, `${message}\n`, ` ${message}`, message.slice(0, -1), `${message}\nResources:\n- https://evil.example`, message.replace("This is not a transaction. ", ""), message.replace("Code:", "Nonce:"), message.replace("\n", "\r\n"), message.toLowerCase(), laidOut, "", null, undefined, 5, [message], { message }]) expect(isSignInMessage(other, parts), String(other)).toBe(false);
    // Parts that are not a code and two times: a line cannot ride in on one of them.
    const smuggled = { ...parts, nonce: `${"ab".repeat(16)}\nResources:\n- https://evil.example` };
    expect(isSignInMessage(signInMessage(smuggled), smuggled)).toBe(false);
    const later = { ...parts, expiresAt: "2026-10-05T00:05:00.000Z\nRequest ID: approve everything" };
    expect(isSignInMessage(signInMessage(later), later)).toBe(false);
    for (const bad of [
      { nonce: "ab".repeat(15) },
      { nonce: "ab".repeat(17) },
      { nonce: "AB".repeat(16) },
      { nonce: "zz".repeat(16) },
      { nonce: undefined },
      { nonce: 5 },
      { issuedAt: undefined },
      { issuedAt: "yesterday" },
      // A time is written in one form only, to the millisecond, in UTC.
      { issuedAt: "2026-10-05T00:00:00Z" },
      { issuedAt: "2026-10-05 00:00:00.000Z" },
      { issuedAt: "2026-10-05T00:00:00.000+00:00" },
      { issuedAt: Date.parse("2026-10-05T00:00:00.000Z") },
      { expiresAt: undefined },
      { expiresAt: 5 },
      { expiresAt: "2026-10-05T00:05:00Z" },
      // The end is after the making.
      { expiresAt: parts.issuedAt },
      { expiresAt: "2026-10-04T23:59:59.999Z" },
      // A host and an address are each one word: nothing with a space or a line break in it is written into a message.
      { host: "" },
      { host: "saplingdex.example evil.example" },
      { host: "saplingdex.example.\nAddress: someone else" },
      { host: "saplingdex.example\t" },
      { address: "" },
      { address: `${ALICE.address} ` },
      { address: `${ALICE.address}\nAlso approve everything.` },
      { address: `${BOB.address}\nAddress: ${ALICE.address}` },
    ]) {
      const given = { ...parts, ...bad };
      expect(isSignInMessage(signInMessage(given as never), given as never), JSON.stringify(bad)).toBe(false);
    }
  });

  it("gives a code that works once, for five minutes, and a session that lasts thirty and is for one address only", () => {
    const signIn = createSignIn();
    const first = signIn.challenge(ALICE.address, "saplingdex.example", MONDAY);
    // The message says it was made a minute before it was asked for, so that a wallet whose clock runs behind does not find it made in the future.
    expect(first.issuedAt).toBe(MONDAY - 60_000);
    expect(first.expiresAt).toBe(MONDAY + 5 * 60_000);
    expect(first.message).toContain(ALICE.address);
    expect(first.message).toContain(first.nonce);
    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
    // The message is the one made from its parts, and nothing else: one text for a code, and no other form of it.
    expect(first.message).toBe(signInMessage({ host: "saplingdex.example", address: ALICE.address, nonce: first.nonce, issuedAt: new Date(first.issuedAt).toISOString(), expiresAt: new Date(first.expiresAt).toISOString() }));
    expect(Object.keys(first).sort()).toEqual(["expiresAt", "issuedAt", "message", "nonce"]);
    // No two codes are alike.
    expect(signIn.challenge(ALICE.address, "saplingdex.example", MONDAY).nonce).not.toBe(first.nonce);
    expect(signIn.redeem(first.nonce, MONDAY + 1)).toEqual({ address: ALICE.address, message: first.message });
    // Used up.
    expect(signIn.redeem(first.nonce, MONDAY + 2)).toBeNull();
    const late = signIn.challenge(ALICE.address, "saplingdex.example", MONDAY);
    expect(signIn.redeem(late.nonce, MONDAY + 5 * 60_000)).toBeNull();
    // And one that had run out when it was tried is gone for good, whatever the clock says afterwards.
    expect(signIn.redeem(late.nonce, MONDAY + 1)).toBeNull();
    for (const bad of [undefined, null, 5, "", "zz".repeat(16), "ab".repeat(15), `${"ab".repeat(16)}0`]) expect(signIn.redeem(bad, MONDAY)).toBeNull();
    // A code of another server is no code here.
    expect(createSignIn().redeem(signIn.challenge(ALICE.address, "saplingdex.example", MONDAY).nonce, MONDAY + 1)).toBeNull();

    const session = signIn.issue(ALICE.address, MONDAY);
    expect(session.expiresAt).toBe(MONDAY + 30 * 60_000);
    // The session names the address exactly as it is written, capitals and all.
    expect(session.token.split(".").slice(0, 3)).toEqual(["r1", String(session.expiresAt), ALICE.address]);
    expect(session.token.split(".")).toHaveLength(4);
    expect(signIn.verify(session.token, MONDAY + 1)).toBe(ALICE.address);
    expect(signIn.verify(session.token, MONDAY + 30 * 60_000 - 1)).toBe(ALICE.address);
    expect(signIn.verify(session.token, MONDAY + 30 * 60_000)).toBeNull();
    // A session cannot be turned into one for another address, or for the same letters in another case, or made to last longer.
    expect(signIn.verify(session.token.replace(ALICE.address, BOB.address), MONDAY + 1)).toBeNull();
    expect(signIn.verify(session.token.replace(ALICE.address, ALICE.address.toLowerCase()), MONDAY + 1)).toBeNull();
    expect(signIn.verify(session.token.replace(String(session.expiresAt), String(session.expiresAt + 1)), MONDAY + 1)).toBeNull();
    expect(signIn.verify(`${session.token}A`, MONDAY + 1)).toBeNull();
    expect(signIn.verify(session.token.slice(0, -1), MONDAY + 1)).toBeNull();
    // A session from another server's secret is not one.
    expect(createSignIn().verify(session.token, MONDAY + 1)).toBeNull();
    // Nor is one that names something other than a Solana address, though this server sealed it.
    for (const other of [ADDR.evm, ADDR.evm.toLowerCase(), ADDR.btc, "someone"]) expect(signIn.verify(signIn.issue(other, MONDAY).token, MONDAY + 1), other).toBeNull();
    for (const bad of [undefined, null, 5, "", "r1.x.y.z", `r1.9999999999999.${ALICE.address}.AAAA`, "x".repeat(300)]) expect(signIn.verify(bad, MONDAY)).toBeNull();
  });

  it("takes a signature only when it is that address's own, of exactly the text, as 64 bytes written in base64", () => {
    const text = signInMessage(parts);
    const good = ALICE.signMessage(text);
    expect(good).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(good).toHaveLength(88);
    expect(signedBy(ALICE.address, text, good)).toBe(true);
    expect(signedBy(BOB.address, text, BOB.signMessage(text))).toBe(true);
    // A signature made over a different text: a character more or less, another site's message, another address's, another code's.
    for (const other of [`${text} `, `${text}\n`, ` ${text}`, text.slice(0, -1), text.toLowerCase(), text.replace(ALICE.address, BOB.address), signInMessage({ ...parts, host: "evil.example" }), signInMessage({ ...parts, nonce: "cd".repeat(16) }), signInMessage({ ...parts, expiresAt: "2026-10-05T00:05:00.001Z" }), "Sign in", ""]) {
      expect(signedBy(ALICE.address, text, ALICE.signMessage(other)), other).toBe(false);
    }
    // Bytes that carry the text behind something else, as a transaction would carry it, are not the text.
    const carried = sign(null, Buffer.concat([Buffer.from([1, 0, 1, 3]), Buffer.from(text, "utf8")]), ALICE.privateKey).toString("base64");
    expect(signedBy(ALICE.address, text, carried)).toBe(false);
    // A signature by another address, and a true signature held up for another address.
    expect(signedBy(ALICE.address, text, BOB.signMessage(text))).toBe(false);
    expect(signedBy(BOB.address, text, good)).toBe(false);
    // An address is its key, letter for letter: the same letters in another case, an address with space around it, and anything that is not a Solana address sign nothing in.
    for (const who of [ALICE.address.toLowerCase(), ALICE.address.toUpperCase(), ` ${ALICE.address}`, `${ALICE.address} `, ADDR.evm, ADDR.btc, "not an address", ""]) expect(signedBy(who, text, good), who).toBe(false);
    // A signature that is not 88 characters of base64: shorter, longer, in another alphabet or another writing, or no text at all.
    const raw = Buffer.from(good, "base64");
    expect(raw).toHaveLength(64);
    const flipped = Buffer.from(raw);
    flipped[10] = (flipped[10] ?? 0) ^ 1;
    // The last character before the padding has bits to spare: another letter there reads as the same 64 bytes, and is still not taken.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const loose = `${good.slice(0, 85)}${ALPHABET[ALPHABET.indexOf(good[85] ?? "A") | 1]}==`;
    expect(Buffer.from(loose, "base64").equals(raw)).toBe(true);
    const bad: unknown[] = [
      flipped.toString("base64"),
      loose,
      good.slice(0, -4),
      good.slice(0, -2),
      good.slice(0, -1),
      good.slice(4),
      `${good}AAAA`,
      `${good.slice(0, 86)}AA==`,
      `${good}=`,
      ` ${good}`,
      `${good}\n`,
      raw.toString("hex"),
      `0x${raw.toString("hex")}`,
      raw.toString("base64url"),
      base58.encode(raw),
      Buffer.alloc(64).toString("base64"),
      Buffer.concat([raw, Buffer.from([0])]).toString("base64"),
      raw.subarray(0, 63).toString("base64"),
      "0x1234",
      "",
      null,
      undefined,
      5,
      true,
      raw,
      new Uint8Array(raw),
      [good],
      { signature: good },
    ];
    for (const given of bad) expect(signedBy(ALICE.address, text, given), String(given)).toBe(false);
  });
});

describe("the signature a sign-in takes", () => {
  it("signs in with the address's own signature of the server's own message, once, and with nothing else: another text, another address, a signature of another length, or a code used before", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 200, windowMs: 60_000 }, rewardsSignIn: { max: 200, windowMs: 60_000 } } });
    const host = new URL(h.url).host;
    const ip = "203.0.113.100";
    const session = await h.session(ip);
    const ask = async (who: { address: string } = ALICE) => (await h.post("/api/rewards/code", { address: who.address }, { session, ip })).body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
    const signIn = (nonce: unknown, given: unknown) => h.post("/api/rewards/session", { nonce, signature: given }, { session, ip });
    const refused = { error: { code: "session", message: "That sign-in did not work. Try again." } };

    // The message: this site, this address, the code and its two times, in plain sentences and in no other layout.
    const one = await ask();
    expect(one.message).toBe([`Sign in to SaplingDex at ${host}.`, `Address: ${ALICE.address}`, SIGN_IN_STATEMENT, `Code: ${one.nonce}`, `Made: ${one.issuedAt}`, `Good until: ${one.expiresAt}`].join("\n"));
    expect(one.message).not.toMatch(/wants you to sign in|Chain ID|URI:|Version:/);
    expect(isSignInMessage(one.message, { host, address: ALICE.address, nonce: one.nonce, issuedAt: one.issuedAt, expiresAt: one.expiresAt })).toBe(true);
    expect(isSignInMessage(`${one.message}\nAlso approve everything.`, { host, address: ALICE.address, nonce: one.nonce, issuedAt: one.issuedAt, expiresAt: one.expiresAt })).toBe(false);
    expect(isSignInMessage(one.message, { host: "evil.example", address: ALICE.address, nonce: one.nonce, issuedAt: one.issuedAt, expiresAt: one.expiresAt })).toBe(false);
    // Alice's signature of it signs her in, for half an hour, as the address exactly as it is written.
    const mine = ALICE.signMessage(one.message);
    const good = await signIn(one.nonce, mine);
    expect(good.status).toBe(200);
    expect(Object.keys(good.body).sort()).toEqual(["address", "expiresAt", "token"]);
    expect(good.body.address).toBe(ALICE.address);
    expect(good.body.expiresAt).toBe(new Date(h.clock.t + 30 * 60_000).toISOString());
    expect(h.signIn.verify(good.body.token, h.clock.t)).toBe(ALICE.address);
    // The same code cannot be used twice, even with the signature that was good the first time.
    const again = await signIn(one.nonce, mine);
    expect(again.status).toBe(401);
    expect(again.body).toEqual(refused);

    /** One try with a fresh code: what is sent as the signature is made from the code's own message. After it, the true signature for that code is tried too. */
    const tried = async (what: string, make: (code: { message: string; nonce: string }) => unknown) => {
      const code = await ask();
      const reply = await signIn(code.nonce, make(code));
      expect(reply.status, what).toBe(401);
      expect(reply.body, what).toEqual(refused);
      expect(JSON.stringify(reply.body), what).not.toContain("token");
      // A failed try uses the code up: the right signature, sent after it, is too late.
      expect((await signIn(code.nonce, ALICE.signMessage(code.message))).status, what).toBe(401);
    };
    // A signature made over a different text than the one the server made for the code.
    const elsewhere = await ask();
    const texts: Record<string, (message: string) => string> = {
      "a space more": (message) => `${message} `,
      "a line more": (message) => `${message}\nAlso approve everything.`,
      "a character less": (message) => message.slice(0, -1),
      "another site's name": (message) => message.replace(host, "evil.example"),
      "another address": (message) => message.replace(ALICE.address, BOB.address),
      "other wording": (message) => message.replace("This is not a transaction. ", ""),
      "another code's message": () => elsewhere.message,
      "words of the signer's own": () => "Sign in",
      "the message laid out another way": (message) => [`${host} wants you to sign in with your Solana account:`, ALICE.address, "", SIGN_IN_STATEMENT, "", ...message.split("\n").slice(3)].join("\n"),
    };
    for (const [what, change] of Object.entries(texts)) await tried(what, (code) => ALICE.signMessage(change(code.message)));
    // A signature by another address, of the very message.
    await tried("another wallet's signature", (code) => BOB.signMessage(code.message));
    // A signature that is not 88 characters of base64.
    const forms: Record<string, (good: string) => unknown> = {
      "four characters short": (good) => good.slice(0, -4),
      "without its padding": (good) => good.slice(0, -2),
      "four characters long": (good) => `${good}AAAA`,
      "a space before it": (good) => ` ${good}`,
      "in hex": (good) => Buffer.from(good, "base64").toString("hex"),
      "in hex, as another chain writes one": (good) => `0x${Buffer.from(good, "base64").toString("hex")}`,
      "in the other base64 alphabet": (good) => Buffer.from(good, "base64").toString("base64url"),
      "in base58": (good) => base58.encode(Buffer.from(good, "base64")),
      "in a list": (good) => [good],
      "64 bytes of nothing": () => Buffer.alloc(64).toString("base64"),
      "a few letters": () => "0x1234",
      "nothing": () => "",
      "no text at all": () => 5,
      "left out": () => undefined,
    };
    for (const [what, form] of Object.entries(forms)) await tried(what, (code) => form(ALICE.signMessage(code.message)));
    // Bob cannot sign in as Alice by asking for her code himself, and a code made for Bob signs nobody in as Alice.
    const forBob = await ask(BOB);
    expect(forBob.message).toContain(`Address: ${BOB.address}`);
    expect((await signIn(forBob.nonce, ALICE.signMessage(forBob.message))).status).toBe(401);
    const his = await ask(BOB);
    const asBob = await signIn(his.nonce, BOB.signMessage(his.message));
    expect(asBob.status).toBe(200);
    expect(asBob.body.address).toBe(BOB.address);
    expect(h.signIn.verify(asBob.body.token, h.clock.t)).toBe(BOB.address);
    // A code that is no code, with a true signature of some message.
    for (const nonce of ["ab".repeat(16), "", null, 5, one.nonce.toUpperCase()]) expect((await signIn(nonce, mine)).status, String(nonce)).toBe(401);
    // And the first code is still used up.
    expect((await signIn(one.nonce, mine)).status).toBe(401);
  });
});

/** Signs in through the routes, as the Rewards page does. */
async function signedIn(h: Harness, account: ReturnType<typeof wallet>, ip = "203.0.113.10"): Promise<string> {
  const session = await h.session(ip);
  const code = await h.post("/api/rewards/code", { address: account.address }, { session, ip });
  expect(code.status).toBe(200);
  const reply = await h.post("/api/rewards/session", { nonce: code.body.nonce, signature: account.signMessage(code.body.message) }, { session, ip });
  expect(reply.status).toBe(200);
  expect(reply.body.address).toBe(account.address);
  return String(reply.body.token);
}

/** Makes an order and has the practice provider deliver it. */
async function delivered(h: Harness, overrides: Record<string, unknown>, ip = "203.0.113.10") {
  const order = asOrder(await h.order(overrides, { ip }));
  h.stub.control(order.depositAddress!, "deposit");
  h.clock.t += 30_000;
  await h.poller.recheck(order.id);
  expect(h.store.get(order.id)?.state.status).toBe("delivered");
  return order;
}

describe("points over the wire", () => {
  const MINT = RESERVE_ASSET.contract;
  const ZEC = 10n ** 8n;
  /** The coin list with ZEC on Solana on it, at this very mint, as the provider lists it: here at $4.80. (The list these tests start from has ZEC on its own chain only.) */
  const listed = { ok: true as const, status: 200, data: [...FIXTURE_TOKENS, { assetId: `1cs_v1:sol:spl:${MINT}`, decimals: 8, blockchain: "sol", symbol: "ZEC", price: 4.8, contractAddress: MINT }] };
  /** How often Solana was asked what the reserve wallet holds. */
  const reads = (h: Harness) => h.rpc.solCalls.filter((call) => call.method === "getTokenAccountsByOwner" && call.params[0] === RESERVE).length;

  it("an order carries a rewards address the person chose, checked and screened like its other addresses", async () => {
    const h = await start({ limits: { orderCreate: { max: 100, windowMs: 60_000 } } });
    // A Solana address, kept exactly as it is written: only the space around it is taken away.
    const order = asOrder(await h.order({ rewardsAddress: ` ${ALICE.address} ` }));
    expect(order.rewardsAddress).toBe(ALICE.address);
    expect(h.store.get(order.id)?.rewardsAddress).toBe(ALICE.address);
    // Left out, or empty: the order is made and adds no points.
    expect(asOrder(await h.order({ recipient: ADDR.evm3 })).rewardsAddress).toBeNull();
    expect(asOrder(await h.order({ recipient: ADDR.evm3, rewardsAddress: "", amount: "6000000000000000" })).rewardsAddress).toBeNull();
    // An address of another kind is not a rewards address, though the swap itself is paid from one and to one.
    for (const bad of ["0x1234", ADDR.evm, ADDR.evm.toLowerCase(), ADDR.btc, 5, {}]) {
      const reply = await h.order({ rewardsAddress: bad });
      expect(reply.status, String(bad)).toBe(400);
      expect(reply.body.error).toEqual({ code: "invalid_rewards", message: "Enter a Solana address for this swap's points, or leave the field empty." });
    }
    const listedAddress = await start({ sanctions: createStaticSanctions([ALICE.address]) });
    const refused = await listedAddress.order({ rewardsAddress: ALICE.address });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("blocked");
    expect(listedAddress.stub.calls.liveQuotes).toBe(0);
  });

  it("points are counted on the server when an order is delivered, and nothing the browser sends can name them", async () => {
    const h = await start({ practice: true });
    const order = await delivered(h, { rewardsAddress: ALICE.address, points: "999999999", pointsMicro: "999999999", fees: { appBps: 9999 } });
    const [entry] = h.rewards.entriesFor(ALICE.address) as [PointsEntry];
    const record = h.store.get(order.id)!;
    // The order's own dollar value, as the verified quote gave it, and no fee: the server takes none here.
    expect(record.fees.appBps).toBe(0);
    expect(entry.volumeUsdMicro).toBe(usdToMicro(record.amountInUsd)!.toString());
    expect(BigInt(entry.volumeUsdMicro)).toBeGreaterThan(0n);
    expect(entry.address).toBe(ALICE.address);
    expect(h.rewards.view(ALICE.address, h.clock.t).allTimeMicro).toBe((BigInt(entry.volumeUsdMicro) * 10n).toString());
    expect(entry.order).toBe(orderHash(order.id));
    // An order that ends any other way adds nothing.
    const other = asOrder(await h.order({ rewardsAddress: BOB.address, recipient: ADDR.evm3 }));
    h.stub.control(other.depositAddress!, "refund");
    h.clock.t += 30_000;
    await h.poller.recheck(other.id);
    expect(h.store.get(other.id)?.state.status).toBe("refunded");
    expect(h.rewards.entriesFor(BOB.address)).toEqual([]);
    // And a delivered order with no rewards address adds nothing either.
    await delivered(h, { recipient: ADDR.evm3, amount: "7000000000000000" });
    expect(fs.readdirSync(path.join(h.dataDir, "rewards", "entries"))).toHaveLength(1);
  });

  it("shows an address its own points after one signature, and never anyone else's", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    await delivered(h, { rewardsAddress: BOB.address, recipient: ADDR.evm3 });
    // Without a sign-in: nothing. Not with a session that only looks like one, nor with the site's own session, nor with an address alone.
    const without: Record<string, string>[] = [
      {},
      { "x-rewards-session": "" },
      { "x-rewards-session": `r1.9999999999999.${ALICE.address}.AAAA` },
      { "x-rewards-session": "r1.9999999999999.0x0000000000000000000000000000000000000000.AAAA" },
      { "x-rewards-session": createSignIn().issue(ALICE.address, h.clock.t).token },
      { "x-rewards-session": ALICE.address },
      { "x-rewards-session": await h.session() },
      { "x-address": ALICE.address },
    ];
    for (const headers of without) {
      const reply = await h.get("/api/rewards/me", { headers });
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({ error: { code: "session", message: "Sign in to see your points." } });
    }
    const token = await signedIn(h, ALICE);
    const mine = (await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } })).body as RewardsView;
    expect(mine.address).toBe(ALICE.address);
    expect(mine.swaps).toHaveLength(1);
    expect(BigInt(mine.week.pointsMicro) > 0n).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(BOB.address);
    expect(addressesIn(JSON.stringify(mine))).toEqual([ALICE.address]);
    // The sign-in is for that address only: it cannot be pointed at another by anything sent with the request.
    for (const route of [`/api/rewards/me?address=${BOB.address}`, `/api/rewards/me/${BOB.address}`, `/api/rewards/${BOB.address}`, `/api/rewards/points?address=${BOB.address}`]) {
      const reply = await h.get(route, { headers: { "x-rewards-session": token, "x-address": BOB.address } });
      expect(JSON.stringify(reply.body), route).not.toContain(BOB.address);
      if (reply.status === 200) expect((reply.body as RewardsView).address, route).toBe(ALICE.address);
    }
    // Nor can the session itself be pointed at Bob.
    expect((await h.get("/api/rewards/me", { headers: { "x-rewards-session": token.replace(ALICE.address, BOB.address) } })).status).toBe(401);
    // After half an hour the sign-in is over.
    h.clock.t += 30 * 60_000;
    expect((await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } })).status).toBe(401);
  });

  it("a week closed, and then paid, by the tools while the server runs is in the server's next answer", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    await delivered(h, { rewardsAddress: BOB.address, recipient: ADDR.evm3 });
    const token = await signedIn(h, ALICE);
    const mine = async () => ((await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } })).body as RewardsView).payouts;
    const anyone = async () => (await h.get("/api/rewards")).body as RewardsPublic;
    expect(await mine()).toEqual([]);
    expect(await anyone()).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    // The tools run in a process of their own, on the same data folder, after the week has ended.
    const week = weekOf(h.clock.t);
    const after = weekBounds(week)!.end;
    const tools = createRewards(h.dataDir);
    const closed = tools.closeWeek(week, 2n * ZEC, "ZEC", 1n, after, CLEAR);
    const amount = closed.shares.find((share) => share.address === ALICE.address)!.payout;
    // Closed: Alice sees her payout, being sent. Nothing is shown to anyone as paid.
    expect(await mine()).toEqual([{ week, amount, asset: "ZEC", decimals: 8, txs: [] }]);
    expect(await anyone()).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    // Paid and recorded: both answers have it.
    const hash = signature("a1");
    tools.recordPaid(week, [{ address: ALICE.address, hash }], after + 1);
    expect(await mine()).toEqual([{ week, amount, asset: "ZEC", decimals: 8, txs: [hash] }]);
    expect(await anyone()).toMatchObject({ weeks: [{ week, asset: "ZEC", decimals: 8, paid: amount, txs: [hash] }], totalPaid: amount, weeksPaid: 1 });
    // What anyone is told still names no address.
    const told = JSON.stringify({ ...(await anyone()), reserve: null });
    expect(addressesIn(told)).toEqual([]);
    for (const who of [ALICE, BOB]) expect(told).not.toContain(who.address);
  });

  it("refuses a signature by another wallet, a code used twice, a code that has run out, and a request from elsewhere", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 100, windowMs: 60_000 }, rewardsSignIn: { max: 100, windowMs: 60_000 } } });
    const session = await h.session();
    const code = async (address = ALICE.address) => (await h.post("/api/rewards/code", { address }, { session })).body as { message: string; nonce: string };
    const signIn = (body: unknown, options = {}) => h.post("/api/rewards/session", body, { session, ...options });
    // Bob signs the message made for Alice.
    const one = await code();
    expect((await signIn({ nonce: one.nonce, signature: BOB.signMessage(one.message) })).status).toBe(401);
    // Alice signs another message than the one the server made.
    const two = await code();
    expect((await signIn({ nonce: two.nonce, signature: ALICE.signMessage(`${two.message} `) })).status).toBe(401);
    // Alice signs a message of someone else's wording, and it is sent along: the server checks its own message, never one it is handed.
    const other = await code();
    const handed = "Sign in";
    expect((await signIn({ nonce: other.nonce, message: handed, signature: ALICE.signMessage(handed) })).status).toBe(401);
    // Nor does an address sent along change whose signature is wanted: Bob's signature of Alice's message, with Bob's address beside it.
    const pointed = await code();
    expect((await signIn({ nonce: pointed.nonce, address: BOB.address, signature: BOB.signMessage(pointed.message) })).status).toBe(401);
    // A good sign-in, then the same code and signature again.
    const three = await code();
    const signed = ALICE.signMessage(three.message);
    expect((await signIn({ nonce: three.nonce, signature: signed })).status).toBe(200);
    const replay = await signIn({ nonce: three.nonce, signature: signed });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toEqual({ code: "session", message: "That sign-in did not work. Try again." });
    // A failed attempt uses the code up too.
    const four = await code();
    expect((await signIn({ nonce: four.nonce, signature: "0x1234" })).status).toBe(401);
    expect((await signIn({ nonce: four.nonce, signature: ALICE.signMessage(four.message) })).status).toBe(401);
    // A code that has run out: a moment before the five minutes are over it would still work, and at five minutes it does not.
    const early = await code();
    const inTime = ALICE.signMessage(early.message);
    h.clock.t += 5 * 60_000 - 1;
    expect((await signIn({ nonce: early.nonce, signature: inTime })).status).toBe(200);
    const five = await code();
    const late = ALICE.signMessage(five.message);
    h.clock.t += 5 * 60_000;
    expect((await signIn({ nonce: five.nonce, signature: late })).status).toBe(401);
    // Both halves are only for this site's own pages, with the site's session.
    for (const options of [{ origin: null }, { origin: "https://evil.example" }]) {
      expect((await h.post("/api/rewards/code", { address: ALICE.address }, { session: await h.session(), ...options })).status).toBe(403);
      expect((await h.post("/api/rewards/session", { nonce: "ab".repeat(16), signature: late }, { session: await h.session(), ...options })).status).toBe(403);
    }
    expect((await h.post("/api/rewards/code", { address: ALICE.address }, { session: null })).status).toBe(401);
    expect((await h.post("/api/rewards/session", { nonce: "ab".repeat(16), signature: late }, { session: null })).status).toBe(401);
    // A code is given for a Solana address and for nothing else: not for an address of another kind, and not for none.
    for (const bad of ["0x1234", ADDR.evm, ADDR.evm.toLowerCase(), ADDR.btc, "", 5, null, [ALICE.address], undefined]) {
      const reply = await h.post("/api/rewards/code", { address: bad }, { session: await h.session() });
      expect(reply.status, String(bad)).toBe(400);
      expect(reply.body, String(bad)).toEqual({ error: { code: "invalid_rewards", message: "That is not a Solana address." } });
      expect(reply.text, String(bad)).not.toMatch(/nonce|Sign in to SaplingDex/);
    }
  });

  it("names this site in the message to sign, and sends the parts the message is made of", async () => {
    const h = await start({ env: { SITE_URL: "https://saplingdex.example" } });
    const code = (await h.post("/api/rewards/code", { address: ALICE.address }, { session: await h.session() })).body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
    expect(code.message.split("\n").slice(0, 2)).toEqual(["Sign in to SaplingDex at saplingdex.example.", `Address: ${ALICE.address}`]);
    // The code, when it was made and when it runs out: with them the page can put the same message together.
    expect(code.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(code.issuedAt).toBe(new Date(h.clock.t - 60_000).toISOString());
    expect(code.expiresAt).toBe(new Date(h.clock.t + 5 * 60_000).toISOString());
    // Those four things and no more: there is one message for a code, and no chain is named by a number.
    expect(Object.keys(code).sort()).toEqual(["expiresAt", "issuedAt", "message", "nonce"]);
    expect(code.message).toBe(signInMessage({ host: "saplingdex.example", address: ALICE.address, nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt }));
    expect(isSignInMessage(code.message, { host: "saplingdex.example", address: ALICE.address, nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt })).toBe(true);
    // Nothing else that is sent with the address is written into the message: it has the six lines the server makes, whatever came with the request.
    const stuffed = (await h.post("/api/rewards/code", { address: ALICE.address, chainId: 1, host: "evil.example", statement: "Approve everything.", message: "Approve everything.", nonce: "ab".repeat(16) }, { session: await h.session() })).body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
    expect(stuffed.message).toBe(signInMessage({ host: "saplingdex.example", address: ALICE.address, nonce: stuffed.nonce, issuedAt: stuffed.issuedAt, expiresAt: stuffed.expiresAt }));
    expect(stuffed.nonce).not.toBe("ab".repeat(16));
    expect(stuffed.message).not.toMatch(/evil|Approve|Chain/);
    expect(Object.keys(stuffed).sort()).toEqual(["expiresAt", "issuedAt", "message", "nonce"]);
    const local = await start();
    const there = (await local.post("/api/rewards/code", { address: ALICE.address }, { session: await local.session() })).body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
    const host = new URL(local.url).host;
    expect(there.message.split("\n")[0]).toBe(`Sign in to SaplingDex at ${host}.`);
    expect(isSignInMessage(there.message, { host, address: ALICE.address, nonce: there.nonce, issuedAt: there.issuedAt, expiresAt: there.expiresAt })).toBe(true);
    // A name that reaches the server only in a forwarding header, which any program can write, is never
    // the name in the message: with no address of its own set, the server gives no code to a page that
    // is not on the host the request itself was made to. (Behind a proxy that changes the host, SITE_URL is set.)
    const proxied = await local.post("/api/rewards/code", { address: ALICE.address }, { session: await local.session(), origin: "https://swap.example", headers: { "x-forwarded-host": "swap.example" } });
    expect(proxied.status).toBe(403);
    expect(JSON.stringify(proxied.body)).not.toContain("swap.example");
    // A page of another site gets no message at all, whatever name it gives.
    expect((await local.post("/api/rewards/code", { address: ALICE.address }, { session: await local.session(), origin: "https://evil.example" })).status).toBe(403);
    // And where the site's own address is set, the message names that and nothing a request says.
    const named = (await h.post("/api/rewards/code", { address: ALICE.address }, { session: await h.session(), origin: "https://other.example", headers: { "x-forwarded-host": "other.example" } })).body as { message: string };
    expect(named.message.split("\n")[0]).toBe("Sign in to SaplingDex at saplingdex.example.");
  });

  it("names the host of the request, and only for a page on that host, where the site's address is only the built-in one", () => {
    // The live site told nothing of its address: it is the built-in one, for what the page says of itself.
    const builtIn = { siteUrl: "https://saplingdex.example", siteUrlSet: false };
    // The sign-in still names the host the request was made to: its own address, or a preview one.
    expect(signInHost(builtIn, "saplingdex.example", "https://saplingdex.example")).toBe("saplingdex.example");
    expect(signInHost(builtIn, "preview-1234.up.example.app", "https://preview-1234.up.example.app")).toBe("preview-1234.up.example.app");
    // And never for a page of another site, for no page at all, or for a host that is not said.
    expect(signInHost(builtIn, "saplingdex.example", "https://evil.example")).toBeNull();
    expect(signInHost(builtIn, "preview-1234.up.example.app", "https://saplingdex.example")).toBeNull();
    for (const origin of [undefined, null, "", "not an address", 5]) expect(signInHost(builtIn, "saplingdex.example", origin), String(origin)).toBeNull();
    for (const host of [undefined, "", 7]) expect(signInHost(builtIn, host, "https://saplingdex.example"), String(host)).toBeNull();
    // With no address at all it is the same rule.
    expect(signInHost({ siteUrl: null, siteUrlSet: false }, "127.0.0.1:8787", "http://127.0.0.1:8787")).toBe("127.0.0.1:8787");
    expect(signInHost({ siteUrl: null, siteUrlSet: false }, "127.0.0.1:8787", "https://evil.example")).toBeNull();
    // Where SITE_URL itself was set, the message names that and nothing a request says.
    const set = { siteUrl: "https://saplingdex.example", siteUrlSet: true };
    for (const [host, origin] of [["saplingdex.example", "https://saplingdex.example"], ["other.example", "https://other.example"], [undefined, undefined]] as const) expect(signInHost(set, host, origin)).toBe("saplingdex.example");
    // Whatever host is named, the message made with it is one the page knows again for that host and for no other.
    const made = createSignIn().challenge(ALICE.address, signInHost(builtIn, "preview-1234.up.example.app", "https://preview-1234.up.example.app")!, MONDAY);
    const its = { address: ALICE.address, nonce: made.nonce, issuedAt: new Date(made.issuedAt).toISOString(), expiresAt: new Date(made.expiresAt).toISOString() };
    expect(isSignInMessage(made.message, { ...its, host: "preview-1234.up.example.app" })).toBe(true);
    expect(isSignInMessage(made.message, { ...its, host: "saplingdex.example" })).toBe(false);
  });

  it("limits how often a sign-in can be asked for and tried", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 2, windowMs: 60_000 }, rewardsSignIn: { max: 2, windowMs: 60_000 }, rewardsRead: { max: 2, windowMs: 60_000 } } });
    const session = await h.session();
    const asked: number[] = [];
    for (let i = 0; i < 3; i++) asked.push((await h.post("/api/rewards/code", { address: ALICE.address }, { session })).status);
    expect(asked).toEqual([200, 200, 429]);
    const tried: number[] = [];
    for (let i = 0; i < 3; i++) tried.push((await h.post("/api/rewards/session", { nonce: "ab".repeat(16), signature: Buffer.alloc(64, 17).toString("base64") }, { session })).status);
    expect(tried).toEqual([401, 401, 429]);
    const read: number[] = [];
    for (let i = 0; i < 3; i++) read.push((await h.get("/api/rewards/me")).status);
    expect(read).toEqual([401, 401, 429]);
    // Someone else is not held up by it.
    expect((await h.post("/api/rewards/code", { address: BOB.address }, { session: await h.session("198.51.100.9"), ip: "198.51.100.9" })).status).toBe(200);
  });

  it("limits sign-in codes by the wider network too (IPv6 /48), between the limit for one address and the limit for everyone", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 2, windowMs: 60_000 }, rewardsNonceWide: { max: 3, windowMs: 60_000 }, rewardsNonceGlobal: { max: 6, windowMs: 60_000 } } });
    const ask = async (ip: string) => (await h.post("/api/rewards/code", { address: ALICE.address }, { session: await h.session(ip), ip })).status;
    // Two from one /64, then that one is told to wait.
    expect([await ask("2001:db8:1:1::1"), await ask("2001:db8:1:1::2"), await ask("2001:db8:1:1::3")]).toEqual([200, 200, 429]);
    // Its neighbours in the same /48 share a larger allowance: one more, then they wait too, whichever of them asks.
    expect([await ask("2001:db8:1:2::1"), await ask("2001:db8:1:3::1"), await ask("2001:db8:1:4::1")]).toEqual([200, 429, 429]);
    // Another network, and a visitor on IPv4, who has no wider network, are not held up by it.
    expect([await ask("2001:db8:2:1::1"), await ask("198.51.100.20"), await ask("198.51.100.21")]).toEqual([200, 200, 200]);
    // Everyone together: six were answered. What the network was refused did not count against the rest; the seventh waits.
    expect(await ask("198.51.100.22")).toBe(429);
  });

  it("tells anyone the week and no pool while no reserve wallet is set", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    const none = (await h.get("/api/rewards")).body as RewardsPublic;
    expect(none.pool).toBeNull();
    expect(Object.keys(none).sort()).toEqual(["pool", "serverNow", "totalPaid", "week", "weekPointsMicro", "weeks", "weeksPaid"]);
    expect(none.week.id).toBe(weekOf(h.clock.t));
    expect(Date.parse(none.week.end) - Date.parse(none.week.start)).toBe(7 * 86_400_000);
    expect(addressesIn(JSON.stringify(none))).toEqual([]);
    expect(JSON.stringify(none)).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
    expect((await h.get("/api/config")).body.reserveAddress).toBeNull();
    // Nothing was asked of Solana for it.
    expect(h.rpc.solCalls).toEqual([]);
  });

  it("tells anyone the current pool: what the reserve wallet holds in ZEC on Solana, with its decimals and its dollar value, read once a minute at most, with no other coin and no address but the wallet's own", async () => {
    const SITE_COIN = wallet("the site's own coin").address;
    const OTHER_MINT = wallet("another mint").address;
    const holding = (h: Harness, zec: bigint, mint: string = MINT) => h.rpc.solHeld.set(`${mint}:${RESERVE}`, [zec]);
    const ask = async (h: Harness) => (await h.get("/api/rewards")).body as RewardsPublic;

    const h = await start({ env: { RESERVE_ADDRESS: RESERVE, TOKEN_ADDRESS: SITE_COIN } });
    h.tap.tokensResult = listed;
    // 1,234.5678 ZEC at $4.80 is $5,925.92544. Whatever else the wallet holds is no part of the pool.
    holding(h, 12_345_678n * 10n ** 4n);
    holding(h, 999n * 10n ** 9n, SITE_COIN);
    holding(h, 50n * 10n ** 6n, OTHER_MINT);
    const first = await ask(h);
    expect(first.pool).toEqual({ address: RESERVE, amount: (12_345_678n * 10n ** 4n).toString(), decimals: 8, usdMicro: "5925925440", readAt: new Date(h.clock.t).toISOString() });
    // The answer holds the wallet's own address and no other: not the reward coin's mint, not the site's coin.
    expect(addressesIn(JSON.stringify(first))).toEqual([RESERVE]);
    for (const other of [MINT, SITE_COIN, OTHER_MINT]) expect(JSON.stringify(first)).not.toContain(other);
    expect(JSON.stringify(first)).not.toMatch(/NEAR|BNB|Binance|bsc|INT\b|coins|0x[0-9a-fA-F]{40}/);
    // What was asked of Solana: this wallet's accounts of the reward coin's own mint, and that mint's decimals. Nothing of any other coin, and no other chain at all.
    expect(h.rpc.solCalls).toEqual([
      { method: "getTokenAccountsByOwner", params: [RESERVE, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }] },
      { method: "getTokenSupply", params: [MINT, { commitment: "finalized" }] },
    ]);
    expect(h.rpc.calls.filter((call) => JSON.stringify(call.call.params).includes(RESERVE))).toEqual([]);
    expect(h.config.rewardTokenAddress).toBe(MINT);

    // Asked again within the minute, by anyone: the same figures, and the chain is not read again.
    holding(h, 3n * ZEC);
    h.clock.t += 59_000;
    expect((await h.get("/api/rewards", { ip: "198.51.100.7" })).body.pool).toEqual(first.pool);
    expect(reads(h)).toBe(1);
    // After 61 seconds it is read again.
    h.clock.t += 2_000;
    const second = await ask(h);
    expect(reads(h)).toBe(2);
    expect(second.pool).toEqual({ address: RESERVE, amount: (3n * ZEC).toString(), decimals: 8, usdMicro: "14400000", readAt: new Date(h.clock.t).toISOString() });
    // A wallet that keeps the coin in more than one account holds all of them together.
    h.rpc.solHeld.set(`${MINT}:${RESERVE}`, [2n * ZEC, ZEC / 2n]);
    h.clock.t += 61_000;
    const third = await ask(h);
    expect(third.pool).toEqual({ address: RESERVE, amount: (5n * ZEC / 2n).toString(), decimals: 8, usdMicro: "12000000", readAt: new Date(h.clock.t).toISOString() });
    expect(reads(h)).toBe(3);
    // A read that fails changes nothing: the last good figures stand, with the time they were read.
    h.rpc.solDown = true;
    h.clock.t += 61_000;
    expect((await ask(h)).pool).toEqual(third.pool);
    expect(reads(h)).toBe(4);
    // So does an answer that is about another coin than the one asked for.
    h.rpc.solDown = false;
    h.rpc.solWrongMint = OTHER_MINT;
    h.clock.t += 61_000;
    expect((await ask(h)).pool).toEqual(third.pool);
    expect(reads(h)).toBe(5);

    // Where no read has ever worked there is no figure at all: the wallet, and nothing said of what it holds.
    const unread = await start({ env: { RESERVE_ADDRESS: RESERVE } });
    unread.tap.tokensResult = listed;
    unread.rpc.solDown = true;
    expect((await ask(unread)).pool).toEqual({ address: RESERVE, amount: null, decimals: 8, usdMicro: null, readAt: null });
    // Nor where the built-in mint is said to have other decimals than its 8: nothing is guessed from an answer like that.
    const misread = await start({ env: { RESERVE_ADDRESS: RESERVE } });
    holding(misread, 5n * ZEC);
    misread.rpc.solDecimals.set(MINT, 9);
    expect((await ask(misread)).pool).toEqual({ address: RESERVE, amount: null, decimals: 8, usdMicro: null, readAt: null });
    // A wallet that has no account for the coin holds none of it, and that is a figure: nothing.
    const empty = await start({ env: { RESERVE_ADDRESS: RESERVE } });
    empty.tap.tokensResult = listed;
    expect((await ask(empty)).pool).toEqual({ address: RESERVE, amount: "0", decimals: 8, usdMicro: "0", readAt: new Date(empty.clock.t).toISOString() });

    // With no price for the coin on the list just now, the amount is there and there is no dollar value.
    // (The list has ZEC on its own chain, at its own price: that is another coin's entry, and is not used.)
    const unpriced = await start({ env: { RESERVE_ADDRESS: RESERVE } });
    holding(unpriced, 5n * ZEC);
    expect(FIXTURE_TOKENS.some((token) => (token as { symbol?: string; price?: number }).symbol === "ZEC" && ((token as { price?: number }).price ?? 0) > 0)).toBe(true);
    expect((await ask(unpriced)).pool).toEqual({ address: RESERVE, amount: (5n * ZEC).toString(), decimals: 8, usdMicro: null, readAt: new Date(unpriced.clock.t).toISOString() });
    // The price is that of the entry on Solana whose mint is this one, letter for letter: the same letters in another case, or the same mint named on another chain, price nothing.
    for (const entry of [
      { assetId: "1cs_v1:sol:spl:zec-in-other-letters", decimals: 8, blockchain: "sol", symbol: "ZEC", price: 4.8, contractAddress: MINT.toLowerCase() },
      { assetId: "1cs_v1:sol:spl:zec-under-another-mint", decimals: 8, blockchain: "sol", symbol: "ZEC", price: 4.8, contractAddress: OTHER_MINT },
      { assetId: "1cs_v1:eth:erc20:zec-on-another-chain", decimals: 8, blockchain: "eth", symbol: "ZEC", price: 4.8, contractAddress: MINT },
    ]) {
      const mislisted = await start({ env: { RESERVE_ADDRESS: RESERVE } });
      mislisted.tap.tokensResult = { ok: true as const, status: 200, data: [...FIXTURE_TOKENS, entry] };
      holding(mislisted, 5n * ZEC);
      expect((await ask(mislisted)).pool, entry.assetId).toMatchObject({ amount: (5n * ZEC).toString(), usdMicro: null });
    }

    // Where the setting names another mint, that coin is the one read, with the decimals it reports itself.
    const other = await start({ env: { RESERVE_ADDRESS: RESERVE, REWARD_TOKEN_ADDRESS: OTHER_MINT } });
    other.tap.tokensResult = listed;
    expect(other.config.rewardTokenAddress).toBe(OTHER_MINT);
    holding(other, 7_500_000n, OTHER_MINT);
    holding(other, 99n * ZEC);
    other.rpc.solDecimals.set(OTHER_MINT, 6);
    expect((await ask(other)).pool).toMatchObject({ address: RESERVE, amount: "7500000", decimals: 6, usdMicro: null });
    expect(other.rpc.solCalls.map((call) => JSON.stringify(call.params)).some((params) => params.includes(MINT))).toBe(false);
    // And if that mint will not say how many decimals it has, nothing is guessed: there is no figure.
    const mute = await start({ env: { RESERVE_ADDRESS: RESERVE, REWARD_TOKEN_ADDRESS: OTHER_MINT } });
    holding(mute, 7_500_000n, OTHER_MINT);
    expect((await ask(mute)).pool).toMatchObject({ amount: null, readAt: null });
  });

  /** A swap of so many dollars (in millionths), delivered at a moment, written straight into a server's record of points. */
  const swapped = (h: Harness, who: { address: string }, label: string, usdMicro: bigint, at: number) => h.rewards.record({ v: 2, order: orderHash(`test swap ${label}`), address: who.address, week: weekOf(at), at: new Date(at).toISOString(), volumeUsdMicro: usdMicro.toString(), reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" } });

  it("tells anyone the week's points as they stood when the current 15 minutes began, to the point: no reading says when inside them a swap was delivered", async () => {
    const h = await start();
    const ask = async () => (await h.get("/api/rewards")).body as RewardsPublic;
    // Alice swapped $250 an hour ago: 2,500 points.
    swapped(h, ALICE, "earlier", usd(250), h.clock.t - 3_600_000);
    const before = await ask();
    expect(before.weekPointsMicro).toBe("2500000000");
    // Now one swap of $1,240.8237 is delivered: 12,408.237 points. Inside this quarter of an hour the total does not move at all.
    swapped(h, BOB, "the one", 1_240_823_700n, h.clock.t + 1000);
    for (const later of [2_000, 60_000, QUARTER_MS - 3_000]) {
      h.clock.t += later - (h.clock.t % QUARTER_MS);
      expect((await ask()).weekPointsMicro, String(later)).toBe(before.weekPointsMicro);
    }
    // At the next quarter of an hour it moves, to the exact figure: 14,908.237 points.
    h.clock.t += 3_000;
    const after = await h.get("/api/rewards");
    expect((after.body as RewardsPublic).weekPointsMicro).toBe("14908237000");
    // A swap delivered in the 15 minutes that have just begun waits for the next in its turn.
    swapped(h, ALICE, "newest", usd(5_000), h.clock.t);
    expect((await ask()).weekPointsMicro).toBe("14908237000");
  });

  it("gives a signed-in address its share and its estimate, worked out on the server: its own new points count at once, other people's from the next quarter, and the estimate comes from the rounded share", async () => {
    const server = async (env: Record<string, string> = { RESERVE_ADDRESS: RESERVE }) => {
      const h = await start({ env });
      h.tap.tokensResult = listed;
      // The pool: 1,000 ZEC, worth $4,800.
      h.rpc.solHeld.set(`${MINT}:${RESERVE}`, [1000n * ZEC]);
      return h;
    };
    const mine = async (h: Harness, who: ReturnType<typeof wallet>, ip: string) => ((await h.get("/api/rewards/me", { headers: { "x-rewards-session": await signedIn(h, who, ip) }, ip })).body as RewardsView).share;

    // One address alone, with 100 points from before the quarter: all of it.
    const alone = await server();
    swapped(alone, ALICE, "alone", usd(10), alone.clock.t - 3_600_000);
    expect(await mine(alone, ALICE, "203.0.113.10")).toEqual({ bps: 10_000, estimate: (1000n * ZEC).toString(), estimateCents: "480000", decimals: 8 });

    // Two addresses with 1 point and 99 from before the quarter: 1 point of 100 is 1%.
    const h = await server();
    swapped(h, ALICE, "one", usd(0.1), h.clock.t - 3_600_000);
    swapped(h, BOB, "ninety-nine", usd(9.9), h.clock.t - 3_600_000);
    expect(await mine(h, ALICE, "203.0.113.10")).toEqual({ bps: 100, estimate: (10n * ZEC).toString(), estimateCents: "4800", decimals: 8 });
    expect(await mine(h, BOB, "203.0.113.11")).toEqual({ bps: 9900, estimate: (990n * ZEC).toString(), estimateCents: "475200", decimals: 8 });
    // Alice swaps again, inside this quarter: 100 points more. Her own count at once: 101 of 200. Bob's answer does not move with her swap.
    swapped(h, ALICE, "one more", usd(10), h.clock.t + 1000);
    h.clock.t += 2000;
    expect(await mine(h, ALICE, "203.0.113.10")).toMatchObject({ bps: 5050, estimate: (505n * ZEC).toString() });
    expect(await mine(h, BOB, "203.0.113.11")).toMatchObject({ bps: 9900, estimate: (990n * ZEC).toString() });
    // From the next quarter it counts for everyone: 101 and 99 of 200.
    h.clock.t += QUARTER_MS;
    expect(await mine(h, ALICE, "203.0.113.10")).toMatchObject({ bps: 5050 });
    expect(await mine(h, BOB, "203.0.113.11")).toMatchObject({ bps: 4950, estimate: (495n * ZEC).toString(), estimateCents: "237600" });

    // The estimate is the pool times the share as it is shown, and no finer: a third is 33.33%, so 333.3 ZEC and its own dollars.
    const thirds = await server();
    swapped(thirds, ALICE, "a third", usd(1), thirds.clock.t - 3_600_000);
    swapped(thirds, BOB, "two thirds", usd(2), thirds.clock.t - 3_600_000);
    expect(await mine(thirds, ALICE, "203.0.113.10")).toEqual({ bps: 3333, estimate: (3333n * ZEC / 10n).toString(), estimateCents: "159984", decimals: 8 });
    // The signed-in answer holds the share and nothing of the week's total itself.
    const answer = await thirds.get("/api/rewards/me", { headers: { "x-rewards-session": await signedIn(thirds, ALICE) } });
    expect(Object.keys(answer.body).sort()).toEqual(["address", "allTimeMicro", "payouts", "share", "swaps", "week"]);
    expect(answer.text).not.toMatch(/"30000000"|weekPoints|total/);

    // With no reserve wallet there is a share and no estimate. With no points at all, nothing.
    const bare = await start();
    swapped(bare, ALICE, "bare", usd(1), bare.clock.t - 3_600_000);
    expect(await mine(bare, ALICE, "203.0.113.10")).toEqual({ bps: 10_000, estimate: null, estimateCents: null, decimals: 8 });
    expect(await mine(bare, BOB, "203.0.113.11")).toEqual({ bps: 0, estimate: null, estimateCents: null, decimals: 8 });
  });

  it("does not try a pool read that failed again within the minute, and answers a request that arrives during a read from that read", async () => {
    // The region check is put to every request as it comes in. Here it refuses nobody and counts them, so that the test knows when a request has arrived.
    let arrived = 0;
    const h = await start({ env: { RESERVE_ADDRESS: RESERVE }, geo: { check: () => ((arrived += 1), { country: null, blocked: false, reason: null }), ready: () => true } });
    const ask = async () => ((await h.get("/api/rewards")).body as RewardsPublic).pool;
    h.rpc.solDown = true;
    expect(await ask()).toMatchObject({ amount: null, readAt: null });
    expect(reads(h)).toBe(1);
    // The chain is back, and within the minute it is not asked again.
    h.rpc.solDown = false;
    h.rpc.solHeld.set(`${MINT}:${RESERVE}`, [ZEC]);
    h.clock.t += 59_000;
    expect(await ask()).toMatchObject({ amount: null, readAt: null });
    expect(reads(h)).toBe(1);
    // After the minute it is: and two requests that arrive together are both answered from the one reading.
    h.clock.t += 2_000;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const answer = h.rpc.solana;
    h.rpc.solana = async (calls) => {
      await held;
      return answer(calls);
    };
    const before = arrived;
    const together = [ask(), ask()];
    // The read is let go only once both have arrived, however long the machine takes over that: one holds the read open, and the other came in during it.
    await eventually(() => arrived === before + 2);
    release();
    expect(await Promise.all(together)).toEqual([expect.objectContaining({ amount: ZEC.toString() }), expect.objectContaining({ amount: ZEC.toString() })]);
    expect(reads(h)).toBe(2);
  });

  it("no route returns another wallet's points: of everyone else there is one total, and nothing to make a list from", async () => {
    const h = await start({ practice: true, env: { RESERVE_ADDRESS: RESERVE } });
    await delivered(h, { rewardsAddress: ALICE.address });
    await delivered(h, { rewardsAddress: BOB.address, recipient: ADDR.evm3, amount: "7300000000000000" });
    const alice = h.rewards.view(ALICE.address, h.clock.t).week.pointsMicro;
    const bob = h.rewards.view(BOB.address, h.clock.t).week.pointsMicro;
    expect(BigInt(alice) > 0n && BigInt(bob) > 0n && alice !== bob).toBe(true);
    const total = (BigInt(alice) + BigInt(bob)).toString();
    /** Every value an answer holds, at any depth, as text. */
    const values = (value: unknown): string[] => (value !== null && typeof value === "object" ? Object.values(value).flatMap(values) : [String(value)]);
    // What anyone is told, with no sign-in: the rewards, the site's totals, the settings. Neither address is in any of it, in any letters, nor either one's points.
    for (const route of ["/api/rewards", "/api/stats", "/api/config", "/api/status", "/api/tokens"]) {
      const reply = await h.get(route);
      expect(reply.status, route).toBe(200);
      const held = values(reply.body);
      for (const who of [ALICE.address, BOB.address]) expect(reply.text.toLowerCase(), route).not.toContain(who.toLowerCase());
      for (const figure of [alice, bob]) expect(held, route).not.toContain(figure);
    }
    // The one address the rewards answer holds is the pool wallet's own.
    expect(addressesIn((await h.get("/api/rewards")).text)).toEqual([RESERVE]);
    // The one figure about points is about how many everyone has together: nothing while the 15 minutes
    // in which the two were delivered last, and from the next the total of them all.
    expect(((await h.get("/api/rewards")).body as RewardsPublic).weekPointsMicro).toBe("0");
    h.clock.t += QUARTER_MS;
    const anyone = (await h.get("/api/rewards")).body as RewardsPublic;
    expect(anyone.weekPointsMicro).toBe(total);
    // Signed in, Alice is shown her own points and nothing of Bob's: not his address, not his figure.
    const token = await signedIn(h, ALICE);
    const mine = await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } });
    expect((mine.body as RewardsView).week.pointsMicro).toBe(alice);
    expect(mine.text.toLowerCase()).not.toContain(BOB.address.toLowerCase());
    expect(values(mine.body)).not.toContain(bob);
    expect(values(mine.body)).not.toContain(total);
    // No address, a session for another address, or an address in the request: nothing of anyone's points comes back.
    for (const route of [`/api/rewards?address=${BOB.address}`, `/api/rewards/${BOB.address}`, `/api/rewards/me?address=${BOB.address}`, `/api/rewards/points/${BOB.address}`]) {
      const reply = await h.get(route, { headers: { "x-address": BOB.address } });
      expect(values(reply.body), route).not.toContain(bob);
      expect(reply.text.toLowerCase(), route).not.toContain(BOB.address.toLowerCase());
    }
  });
});

describe("the Rewards page, before the wallet is opened", () => {
  // The page's own store, with this test's server behind it and stand-ins for the Solana wallets in the browser.
  const realFetch = globalThis.fetch;
  /** Changes what the server answered to "give me a code", as a server that had been got at would. */
  let tamper: ((code: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every message a wallet was asked to sign, as the text the wallet would show. */
  let asked: string[] = [];
  /** Every request the page made to the server, by its path. */
  let requested: string[] = [];
  /**
   * A Solana wallet as the page sees one: a name, a way to connect that gives its account, and a way
   * to sign a message. Unless told otherwise it signs what it is given with its own key, as a wallet
   * does when the person says yes.
   */
  const standIn = (who: ReturnType<typeof wallet>, options: { name?: string; accounts?: () => Promise<readonly WalletAccount[]>; signs?: (bytes: Uint8Array) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array }> } = {}): SignInWallet => ({
    name: options.name ?? "Stand-in Wallet",
    connect: options.accounts ?? (async () => [{ address: who.address, publicKey: who.publicKey }]),
    async signMessage(_account, bytes) {
      asked.push(new TextDecoder().decode(bytes));
      if (options.signs !== undefined) return options.signs(bytes);
      return { signedMessage: bytes, signature: new Uint8Array(sign(null, Buffer.from(bytes), who.privateKey)) };
    },
  });
  /** A refusal as a wallet answers one: the code every wallet uses for "the person said no". */
  const refusal = () => Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }));
  const behind = async (h: Harness, wallets: SignInWallet[] = [standIn(ALICE)]) => {
    tamper = null;
    asked = [];
    requested = [];
    browser.wallets = wallets;
    useRewards.getState().signOut();
    useRewards.setState({ session: null, mine: null, step: "idle", wallets: [], error: null });
    vi.stubGlobal("window", { location: { host: new URL(h.url).host } });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      if (typeof input !== "string" || !input.startsWith("/")) return realFetch(input, init);
      requested.push(input);
      const reply = await realFetch(`${h.url}${input}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin: h.url, "x-forwarded-for": "203.0.113.10" } });
      if (input !== "/api/rewards/code" || tamper === null || !reply.ok) return reply;
      return new Response(JSON.stringify(tamper((await reply.json()) as Record<string, unknown>)), { status: 200, headers: { "content-type": "application/json" } });
    });
  };
  const sent = (path: string) => requested.filter((one) => one === path).length;
  afterEach(() => {
    vi.unstubAllGlobals();
    browser.wallets = [];
  });

  it("puts the server's message together again for this site and this address, and only then asks the wallet to sign it", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    await behind(h);
    // "Sign in" takes nothing from the page: the address is the one the wallet itself gives.
    await useRewards.getState().signIn();
    expect(useRewards.getState()).toMatchObject({ step: "idle", error: null, wallets: [], session: { address: ALICE.address } });
    expect(useRewards.getState().mine?.swaps).toHaveLength(1);
    expect(useRewards.getState().mine?.address).toBe(ALICE.address);
    // The wallet was asked once, for the message that names this site and this address, in plain sentences.
    const host = new URL(h.url).host;
    expect(asked).toHaveLength(1);
    expect(asked[0]?.split("\n").slice(0, 3)).toEqual([`Sign in to SaplingDex at ${host}.`, `Address: ${ALICE.address}`, SIGN_IN_STATEMENT]);
    expect(asked[0]?.split("\n")).toHaveLength(6);
    expect(asked[0]).not.toMatch(/wants you to sign in|Chain ID|URI:/);
    // One code was asked for and one signature sent, and the session the server gave is good for that address.
    expect([sent("/api/rewards/code"), sent("/api/rewards/session")]).toEqual([1, 1]);
    expect(h.signIn.verify(useRewards.getState().session?.token, h.clock.t)).toBe(ALICE.address);
  });

  it("does not open the wallet for a message that names another site or another address, or that is not the message its parts make", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 100, windowMs: 60_000 } } });
    const host = new URL(h.url).host;
    const changes: Record<string, (code: Record<string, unknown>) => Record<string, unknown>> = {
      "another site's name": (code) => ({ ...code, message: String(code.message).replaceAll(host, "evil.example") }),
      "another site's name after this one's": (code) => ({ ...code, message: String(code.message).replace(`at ${host}.`, `at ${host}.evil.example.`) }),
      "another address": (code) => ({ ...code, message: String(code.message).replace(ALICE.address, BOB.address) }),
      "the address in other letters": (code) => ({ ...code, message: String(code.message).replace(ALICE.address, ALICE.address.toLowerCase()) }),
      "other words": (code) => ({ ...code, message: String(code.message).replace("This is not a transaction. ", "") }),
      "a line more": (code) => ({ ...code, message: `${String(code.message)}\nResources:\n- https://evil.example` }),
      "a transaction's worth of text in place of the message": (code) => ({ ...code, message: "Approve all of your coins" }),
      "the message laid out another way": (code) => ({ ...code, message: [`${host} wants you to sign in with your Solana account:`, ALICE.address, "", SIGN_IN_STATEMENT, "", `Nonce: ${String(code.nonce)}`, `Issued At: ${String(code.issuedAt)}`, `Expiration Time: ${String(code.expiresAt)}`].join("\n") }),
      "a line riding in on the code": (code) => {
        const nonce = `${String(code.nonce)}\nResources:\n- https://evil.example`;
        return { ...code, nonce, message: signInMessage({ host, address: ALICE.address, nonce, issuedAt: String(code.issuedAt), expiresAt: String(code.expiresAt) }) };
      },
      "another code than the one in the message": (code) => ({ ...code, nonce: "ab".repeat(16) }),
      "no time of making": (code) => ({ message: code.message, nonce: code.nonce, expiresAt: code.expiresAt }),
      "no message at all": (code) => ({ nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt }),
    };
    for (const [what, change] of Object.entries(changes)) {
      await behind(h);
      tamper = change;
      await useRewards.getState().signIn();
      expect(asked, what).toEqual([]);
      expect(useRewards.getState(), what).toMatchObject({ step: "idle", session: null, mine: null, error: "That sign-in did not work. Try again." });
      // And nothing was sent to the server as a signature.
      expect(sent("/api/rewards/session"), what).toBe(0);
    }
    // The page on another site than the one the server names: the same, with nothing changed on the way.
    await behind(h);
    vi.stubGlobal("window", { location: { host: "elsewhere.example" } });
    await useRewards.getState().signIn();
    expect(asked).toEqual([]);
    expect(useRewards.getState().error).toBe("That sign-in did not work. Try again.");
    // Left alone, the same server's message is signed.
    await behind(h);
    await useRewards.getState().signIn();
    expect(asked).toHaveLength(1);
    expect(useRewards.getState()).toMatchObject({ error: null, session: { address: ALICE.address } });
  });

  it("says so where the browser has no Solana wallet, and where it has several, offers them by name and asks only the one that is chosen", async () => {
    const h = await start();
    // None: one sentence, and nothing is asked of the server.
    await behind(h, []);
    await useRewards.getState().signIn();
    expect(NO_WALLET_WORDS).toBe("No Solana wallet was found in this browser. Install one, or open this page in your wallet's own browser.");
    expect(useRewards.getState()).toMatchObject({ step: "idle", wallets: [], session: null, error: NO_WALLET_WORDS });
    expect(requested).toEqual([]);
    // Several: their names, and no wallet is connected or asked anything until one is chosen.
    let connected: string[] = [];
    const named = (who: ReturnType<typeof wallet>, name: string) =>
      standIn(who, {
        name,
        accounts: async () => {
          connected.push(name);
          return [{ address: who.address, publicKey: who.publicKey }];
        },
      });
    await behind(h, [named(BOB, "First Wallet"), named(ALICE, "Second Wallet")]);
    await useRewards.getState().signIn();
    expect(useRewards.getState()).toMatchObject({ step: "choosing", wallets: ["First Wallet", "Second Wallet"], session: null, error: null });
    expect([connected, asked, requested]).toEqual([[], [], []]);
    // A name that is not among them chooses nothing.
    await useRewards.getState().choose("Some Other Wallet");
    expect(useRewards.getState()).toMatchObject({ step: "choosing", session: null });
    expect([connected, asked, requested]).toEqual([[], [], []]);
    // The second is chosen: it alone is connected and asked, and its address is the one signed in.
    await useRewards.getState().choose("Second Wallet");
    expect(connected).toEqual(["Second Wallet"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`Address: ${ALICE.address}`);
    expect(asked[0]).not.toContain(BOB.address);
    expect(useRewards.getState()).toMatchObject({ step: "idle", wallets: [], error: null, session: { address: ALICE.address } });
    // Once nothing is on offer, a name chooses nothing: no wallet is asked without "Sign in" being pressed first.
    connected = [];
    await behind(h, [named(BOB, "First Wallet"), named(ALICE, "Second Wallet")]);
    await useRewards.getState().choose("First Wallet");
    expect(useRewards.getState()).toMatchObject({ step: "idle", session: null });
    expect([connected, asked, requested]).toEqual([[], [], []]);
  });

  it("signs nobody in when the wallet refuses", async () => {
    const h = await start();
    // The person says no to the signature.
    await behind(h, [standIn(ALICE, { signs: refusal })]);
    await useRewards.getState().signIn();
    expect(asked).toHaveLength(1);
    expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, mine: null, error: "Nothing was signed, so you are not signed in." });
    expect(sent("/api/rewards/session")).toBe(0);
    // The person says no to connecting: no code is asked for, and the wallet is never asked to sign.
    await behind(h, [standIn(ALICE, { accounts: refusal })]);
    await useRewards.getState().signIn();
    expect(asked).toEqual([]);
    expect(requested).toEqual([]);
    expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, mine: null, error: "Nothing was signed, so you are not signed in." });
  });

  it("says something else when the wallet was never asked, or could not be reached: nobody is told they refused when they did not", async () => {
    const h = await start();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = "The wallet could not be asked to sign. Try again, or use another wallet.";
    try {
      await behind(h, [standIn(ALICE, { signs: () => Promise.reject(Object.assign(new Error(`Account ${ALICE.address} not found`), { name: "WalletAccountError" })) })]);
      await useRewards.getState().signIn();
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: failed });
      await behind(h, [standIn(ALICE, { signs: () => Promise.reject(Object.assign(new Error("Request already pending"), { code: -32002 })) })]);
      await useRewards.getState().signIn();
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: "Open your wallet and unlock it, then sign in again." });
      // A wallet that gives no account, or one whose key is not the address it says: no code is asked for, for that address or any other.
      await behind(h, [standIn(ALICE, { accounts: async () => [] })]);
      await useRewards.getState().signIn();
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: failed });
      await behind(h, [standIn(BOB, { accounts: async () => [{ address: ALICE.address, publicKey: BOB.publicKey }] })]);
      await useRewards.getState().signIn();
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: failed });
      expect([asked, requested]).toEqual([[], []]);
      // A wallet that says it signed other words than it was given, or gives back something that is no signature: its answer is sent nowhere.
      const other = new TextEncoder().encode("Approve all of your coins");
      await behind(h, [standIn(ALICE, { signs: async () => ({ signedMessage: other, signature: new Uint8Array(sign(null, Buffer.from(other), ALICE.privateKey)) }) })]);
      await useRewards.getState().signIn();
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: failed });
      expect([asked.length, sent("/api/rewards/session")]).toEqual([1, 0]);
      await behind(h, [standIn(ALICE, { signs: async (bytes) => ({ signedMessage: bytes, signature: new Uint8Array(32) }) })]);
      await useRewards.getState().signIn();
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: failed });
      expect(sent("/api/rewards/session")).toBe(0);
      // What was raised is named for whoever looks, by its name alone: never the address.
      expect(warned.mock.calls.map((call) => String(call[0]))).toEqual(["Rewards sign-in: WalletAccountError", "Rewards sign-in: Error(-32002)", "Rewards sign-in: NoSolanaAccount", "Rewards sign-in: NoSolanaAccount", "Rewards sign-in: OtherMessageSigned", "Rewards sign-in: NoSignature"]);
      expect(JSON.stringify(warned.mock.calls)).not.toContain(ALICE.address);
      // A wallet that signs with another key than the address it gave gets as far as the server, which refuses it.
      await behind(h, [standIn(ALICE, { signs: async (bytes) => ({ signedMessage: bytes, signature: new Uint8Array(sign(null, Buffer.from(bytes), BOB.privateKey)) }) })]);
      await useRewards.getState().signIn();
      expect(sent("/api/rewards/session")).toBeGreaterThan(0);
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, mine: null, error: "That sign-in did not work. Try again." });
    } finally {
      warned.mockRestore();
    }
  });
});

describe("the Rewards page, as it is drawn", () => {
  const week = { id: "2026-W41", start: new Date(MONDAY).toISOString(), end: new Date(MONDAY + 7 * 86_400_000).toISOString() };
  const ZEC = 10n ** 8n;
  /** The reserve wallet holds 1,234.5678 ZEC, worth $5,925.92544. */
  const POOL = { address: RESERVE, amount: (12_345_678n * 10n ** 4n).toString(), decimals: 8, usdMicro: "5925925440", readAt: new Date(MONDAY + 3_600_000).toISOString() };
  const summaryOf = (pool: RewardsPublic["pool"], points: bigint, extra: Partial<RewardsPublic> = {}): RewardsPublic => ({ week, weekPointsMicro: (points * MICRO).toString(), weeks: [], totalPaid: "0", weeksPaid: 0, pool, serverNow: new Date(MONDAY + 3_600_000).toISOString(), ...extra });
  /** An address's own answer, with its share as the server works it out: out of so many points in all, of the pool handed in. */
  const mineOf = (points: bigint, of: bigint, pool: RewardsPublic["pool"], payouts: RewardsView["payouts"] = []): RewardsView => {
    const part = poolShare(points * MICRO, of * MICRO, pool === null || pool.amount === null ? null : { amount: BigInt(pool.amount), usdMicro: pool.usdMicro === null ? null : BigInt(pool.usdMicro) });
    const share = { bps: Number(part.shareBps), estimate: pool === null || pool.amount === null ? null : part.estimate.toString(), estimateCents: part.estimateCents === null ? null : part.estimateCents.toString(), decimals: 8 };
    return { address: ALICE.address, week: { ...week, pointsMicro: (points * MICRO).toString(), carriedInMicro: "0" }, allTimeMicro: (points * MICRO).toString(), swaps: [], payouts, share };
  };
  /** The page as it is first drawn from what its store holds: put there for the length of one drawing, and taken away again. */
  const draw = (summary: RewardsPublic, mine: RewardsView | null = null, more: { step?: string; wallets?: string[]; error?: string | null } = {}): string => {
    const first = useRewards.getInitialState() as unknown as Record<string, unknown>;
    const kept = { summary: first.summary, session: first.session, mine: first.mine, step: first.step, wallets: first.wallets, error: first.error };
    Object.assign(first, { summary, mine, session: mine === null ? null : { address: mine.address, token: "t", expiresAt: MONDAY + 7_200_000 }, ...more });
    try {
      return renderToStaticMarkup(createElement(RewardsPage));
    } finally {
      Object.assign(first, kept);
    }
  };
  /** What a person reads: tags out, and what is written for a screen reader alone left out, so that an amount is read once. */
  const read = (html: string) => html.replace(/<span class="sr-only">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  /** The words rewards went by while they were paid in another coin on another chain. None of them is on the page now. */
  const OLD_WORDS = /\bNEAR\b|BNB|Binance|BscScan|bscscan|0x[0-9a-fA-F]{40}/;

  it("has no part for the pool while no reserve wallet is set: nothing stands in its place", () => {
    const html = draw(summaryOf(null, 0n));
    expect(html).not.toMatch(/Current pool|rewards-pool|Solscan|solscan/);
    expect(read(html)).not.toMatch(/\bpool's wallet\b|Current pool|cannot be read/i);
    expect(html).not.toMatch(OLD_WORDS);
    // The week and its total are there all the same, and say that nobody has points yet.
    expect(read(html)).toContain("This week's points 0 points No points have been collected yet this week.");
    // Signed in, an address still sees its share. With no pool there is no estimate, and nothing in its place.
    const signedIn = read(draw(summaryOf(null, 1000n), mineOf(250n, 1000n, null)));
    expect(signedIn).toContain("Your share 25.00%");
    expect(signedIn).not.toMatch(/Estimated reward|An estimate\.|\$[\d,]+\.\d\d/);
  });

  it("says, before anyone signs in, what signing in asks of a Solana wallet, and offers the wallets by name where there are several", () => {
    const html = draw(summaryOf(null, 0n));
    const text = read(html);
    // Said before any wallet opens: one plain message, and not a payment.
    expect(text).toContain("Your points Signing in asks your Solana wallet to sign one plain message, to show that an address is yours. It is not a transaction: it moves nothing, approves nothing and costs no network fee. Sign in with a Solana wallet");
    expect(html).toMatch(/<button type="button" class="button-primary">Sign in with a Solana wallet<\/button>/);
    // There is one button, and it signs in: no wallet is connected to the page beforehand, and nothing asks for one to be.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(text).not.toMatch(/\bConnect\b|connect a wallet|BNB|MetaMask|Ethereum|\bEVM\b/i);
    // Several wallets could sign in: their names, each a button, in place of the one.
    const choosing = draw(summaryOf(null, 0n), null, { step: "choosing", wallets: ["First Wallet", "Second Wallet"] });
    expect(choosing).toMatch(/<ul class="rewards-wallets" aria-label="Choose a wallet to sign in with"><li><button type="button" class="button-secondary">First Wallet<\/button><\/li><li><button type="button" class="button-secondary">Second Wallet<\/button><\/li><\/ul>/);
    expect(read(choosing)).toContain("It is not a transaction: it moves nothing, approves nothing and costs no network fee. First Wallet Second Wallet");
    expect(choosing).not.toContain("Sign in with a Solana wallet");
    // What went wrong is said in its one sentence, under the button.
    expect(draw(summaryOf(null, 0n), null, { error: NO_WALLET_WORDS })).toContain(`<p class="rewards-message" role="status">${NO_WALLET_WORDS.replace("'", "&#x27;")}</p>`);
    // The rules say what the smallest payout is, from the number the payout tools go by, and that a smaller share is carried.
    expect(MIN_PAYOUT_TEXT).toBe("0.001 ZEC");
    expect(RULES_IN_SHORT).toContain("The smallest payout that is sent is 0.001 ZEC. A smaller share is not lost: its points are carried into the next week.");
    for (const rule of RULES_IN_SHORT) expect(text).toContain(rule);
    expect(RULES_IN_SHORT.join(" ")).toContain("in ZEC on Solana");
    expect(RULES_IN_SHORT.join(" ")).not.toMatch(OLD_WORDS);
    expect(text).toContain("Each delivered swap adds points to the Solana address named for it. Each week the pool is shared out by points, in ZEC.");
  });

  it("keeps every part's room from the first drawing, before the server has answered: the week with its dates and countdown, and the pool's frame wherever the page itself names a rewards wallet", () => {
    /** The page as it is drawn before any answer, with the wallet the server wrote into the page (or none). */
    const waiting = (wallet: string | null, failed = false): string => {
      const first = useRewards.getInitialState() as unknown as Record<string, unknown>;
      const kept = { summary: first.summary, summaryFailed: first.summaryFailed, session: first.session, mine: first.mine };
      Object.assign(first, { summary: null, summaryFailed: failed, mine: null, session: null });
      vi.stubGlobal("document", { documentElement: { dataset: wallet === null ? {} : { rewardsWallet: wallet } } });
      try {
        return renderToStaticMarkup(createElement(RewardsPage));
      } finally {
        vi.unstubAllGlobals();
        Object.assign(first, kept);
      }
    };
    const parts = (html: string) => [...html.matchAll(/<(?:h2 id="rewards-[a-z]+"|p) class="(rewards-(?:label mono|count mono|heading|pool-total|address)|muted rewards-(?:dates|total-note)|skeleton rewards-total-waiting|rewards-figure mono(?: rewards-pool-line)?|muted rewards-pool-line)"/g)].map((match) => match[1]);

    // No wallet named: the week is whole (the page knows the calendar), the total's line waits in its room, and no pool is drawn.
    const bare = waiting(null);
    expect(read(bare)).toMatch(/This week \d+d \d{2}:\d{2}:\d{2} \w{3} \d+ \w{3} to \w{3} \d+ \w{3}, UTC time\./);
    expect(bare).toContain('<p class="skeleton rewards-total-waiting" aria-hidden="true"></p>');
    expect(bare).not.toMatch(/Current pool|rewards-pool|solscan/i);

    // A wallet named: the pool's frame is there at once, with the wallet's own address and link, and room for each figure.
    const framed = waiting(RESERVE);
    expect(framed).toMatch(/<h2 id="rewards-pool" class="rewards-heading">Current pool<\/h2><p class="rewards-pool-total" aria-hidden="true"><span class="skeleton rewards-waiting"><\/span><\/p><p class="rewards-figure mono rewards-pool-line"><\/p>/);
    expect(framed).toContain(`<a class="outbound" href="https://solscan.io/account/${RESERVE}" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">View the wallet on Solscan`);
    expect(read(framed)).not.toMatch(/ZEC about|\$[\d,]+\.\d\d|Read from the chain|cannot be read/);
    // The same parts, in the same order, before the answer and after it: nothing is put in between later.
    const answered = draw(summaryOf(POOL, 1000n));
    expect(parts(framed).map((part) => part!.replace("skeleton rewards-total-waiting", "rewards-figure mono"))).toEqual(parts(answered));
    expect(parts(answered)).toContain("rewards-pool-total");
    // Only a plain Solana address is taken from the page (an address of another kind is not one), and none once the server has said it cannot be asked.
    for (const other of ["<b>not an address</b>", ADDR.evm3, ADDR.evm3.toLowerCase(), `${RESERVE} `, `${RESERVE}"><script>`, ""]) expect(waiting(other), other).not.toMatch(/Current pool/);
    expect(waiting(RESERVE, true)).not.toMatch(/Current pool/);
    // What was paid from the pool stands last, after the rules, so that its arrival moves nothing above it.
    const paid = draw(summaryOf(POOL, 1000n, { weeks: [{ week: "2026-W40", paid: (5n * ZEC).toString(), asset: "ZEC", decimals: 8, txs: [] }], totalPaid: (5n * ZEC).toString(), weeksPaid: 1 }));
    expect(paid.indexOf('id="rewards-paid"')).toBeGreaterThan(paid.indexOf('id="rewards-rules"'));
    expect(read(paid)).toContain("Paid out so far: 5 ZEC over 1 week.");
  });

  it("shows the current pool as an amount of ZEC with its dollar value beneath, a link to the wallet on Solscan, and no other coin", () => {
    const html = draw(summaryOf(POOL, 1000n));
    const text = read(html);
    expect(html).toMatch(/<h2 id="rewards-pool" class="rewards-heading">Current pool<\/h2><p class="rewards-pool-total">/);
    // The amount in the site's short form, rounded down, and in full for a screen reader; its dollars beneath.
    expect(text).toContain("Current pool 1,234.56 ZEC about $5,925.92 What the pool's wallet holds in ZEC on Solana.");
    expect(html).toContain('<span class="sr-only">1234.5678 ZEC</span>');
    expect(text).toContain("Each week's payout is sent from it, shared out by points. Other coins in that wallet are no part of the pool.");
    expect(text).toContain("Rewards are paid in ZEC on Solana, to the Solana address the points belong to.");
    // ZEC's own mark beside the amount, as a coin's icon, from the site's own files.
    expect(html).toMatch(/<p class="rewards-pool-total"><span class="coin-icon" data-size="32" aria-hidden="true"><img class="coin-icon-image" src="\/coins\/zec\.svg"/);
    expect(html).toContain(`<a class="outbound" href="https://solscan.io/account/${RESERVE}" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">View the wallet on Solscan`);
    // Nothing else the wallet holds is listed, and nothing on the page names the coin or the chain rewards were once paid on.
    expect(text).not.toMatch(OLD_WORDS);
    expect(html).not.toMatch(/bscscan|\/coins\/near\./i);
    expect(text).not.toMatch(/\$SAPDEX|not counted in the total/);
    // The week's points are told as they are, with no "about" before them.
    expect(text).toContain("This week's points 1,000 points Collected by everyone together. Brought up to date every 15 minutes.");
    expect(read(draw(summaryOf(POOL, 14_000n)))).toContain("This week's points 14,000 points");
    // Nobody has signed in: no points of any one address, no share, and no address but the wallet's own.
    expect(html).not.toMatch(/rewards-points|Your share|Estimated reward/);
    // (An address is drawn in three parts, so that its two ends stand out: the parts are put together again before it is looked for.)
    expect(addressesIn(html.replace(/<\/?span[^>]*>/g, "").replace(/<[^>]+>/g, " "))).toEqual([RESERVE]);
    // With no price for the coin just now, the amount is shown and no dollar line.
    const unpriced = read(draw(summaryOf({ ...POOL, usdMicro: null }, 1000n)));
    expect(unpriced).toContain("Current pool 1,234.56 ZEC What the pool's wallet holds in ZEC on Solana.");
    expect(unpriced).not.toMatch(/about \$|\$[\d,]+\.\d\d/);
    // Before anyone has points this week: the pool is shown, and the page says so.
    const early = read(draw(summaryOf(POOL, 0n)));
    expect(early).toContain("Current pool 1,234.56 ZEC");
    expect(early).toContain("No points have been collected yet this week.");
    // Where the wallet cannot be read: its link, one plain sentence, and no figure at all.
    const unread = draw(summaryOf({ address: RESERVE, amount: null, decimals: 8, usdMicro: null, readAt: null }, 0n));
    expect(read(unread)).toContain("Current pool The pool cannot be read right now. Its wallet is linked below, and can be checked on Solana itself. Rewards are paid in ZEC on Solana");
    expect(unread).toContain(`href="https://solscan.io/account/${RESERVE}"`);
    expect(unread).toContain("View the wallet on Solscan");
    const part = read(unread).slice(read(unread).indexOf("Current pool"), read(unread).indexOf("The rules, in short"));
    expect(part).toMatch(/^Current pool The pool cannot be read right now\./);
    expect(part).toContain(`${RESERVE.slice(0, 6)} ${RESERVE.slice(6, -6)} ${RESERVE.slice(-6)}`);
    // Not a digit in it but the wallet's own address.
    expect(part.replace(`${RESERVE.slice(0, 6)} ${RESERVE.slice(6, -6)} ${RESERVE.slice(-6)}`, "")).not.toMatch(/\d|\$|about|What the pool's wallet holds/);
    expect(unread).not.toMatch(/rewards-pool-total|rewards-pool-line/);
  });

  it("after a sign-in, shows the address its share of the week's points and what that share of the pool comes to in ZEC, with its dollars beside it, and says that it is an estimate", () => {
    const text = read(draw(summaryOf(POOL, 1000n), mineOf(250n, 1000n, POOL)));
    // 250 points of 1,000 is a quarter, and a quarter of 1,234.5678 ZEC is 308.64195: shown rounded down, with a quarter of its dollars.
    expect(text).toContain("Your points this week 250.00");
    expect(text).toContain("Your share 25.00% Estimated reward 308.6419 ZEC about $1,481.48 An estimate. Your share changes as others swap, and the pool changes until the week closes.");
    expect(ESTIMATE_NOTE).toBe("An estimate. Your share changes as others swap, and the pool changes until the week closes.");
    expect(text).not.toContain("Make a swap to collect points.");
    expect(text).not.toMatch(OLD_WORDS);
    // Signed in, the page no longer asks for a signature.
    expect(text).not.toMatch(/Sign in with a Solana wallet|Signing in asks/);
    // 1 point of 100 is 1%.
    expect(read(draw(summaryOf(POOL, 100n), mineOf(1n, 100n, POOL)))).toContain("Your share 1.00% Estimated reward 12.3456 ZEC about $59.25");
    // The page shows what the server sent, and works nothing out from the round total anyone is told: here the two do not agree, and the server's stands.
    expect(read(draw(summaryOf(POOL, 9_000n), mineOf(250n, 1000n, POOL)))).toContain("Your share 25.00% Estimated reward 308.6419 ZEC about $1,481.48");
    // With no price for the coin: the estimate in ZEC, and nothing in dollars.
    const unpriced = read(draw(summaryOf({ ...POOL, usdMicro: null }, 1000n), mineOf(250n, 1000n, { ...POOL, usdMicro: null })));
    expect(unpriced).toContain("Your share 25.00% Estimated reward 308.6419 ZEC An estimate.");
    expect(unpriced).not.toMatch(/about \$/);
    // With no points of its own: 0%, and a short way to the swap page.
    const none = draw(summaryOf(POOL, 1000n), mineOf(0n, 1000n, POOL));
    expect(read(none)).toContain("Your share 0% Estimated reward 0 ZEC about $0.00");
    expect(none).toMatch(/<a href="\/"[^>]*>Make a swap to collect points\.<\/a>/);
  });

  it("shows what has been paid in ZEC, and a week that was paid in another coin in that coin", () => {
    const weeks = [
      { week: "2026-W40", asset: "ZEC", decimals: 8, paid: (125n * 10n ** 7n).toString(), txs: [signature("a1")] },
      { week: "2026-W39", asset: "NEAR", decimals: 18, paid: (3n * 10n ** 18n).toString(), txs: [`0x${"b2".repeat(32)}`] },
    ];
    const payouts = [
      { week: "2026-W40", amount: (25n * 10n ** 7n).toString(), asset: "ZEC", decimals: 8, txs: [] },
      { week: "2026-W39", amount: 10n ** 18n + "", asset: "NEAR", decimals: 18, txs: [] },
    ];
    const html = draw(summaryOf(POOL, 1000n, { weeks, totalPaid: (125n * 10n ** 7n).toString(), weeksPaid: 1 }), mineOf(250n, 1000n, POOL, payouts));
    const text = read(html);
    expect(text).toContain("Paid out so far: 12.5 ZEC over 1 week.");
    expect(text).toContain("Week 40, 2026 12.5 ZEC");
    expect(text).toContain("Week 39, 2026 3 NEAR");
    expect(text).toContain("Week 40, 2026 2.5 ZEC");
    expect(text).toContain("Week 39, 2026 1 NEAR");
    // A payout made on Solana is linked to the Solana explorer, by its signature.
    expect(html).toContain(`href="https://solscan.io/tx/${signature("a1")}"`);
    expect(html).not.toMatch(/bscscan/i);
    // With every week paid in ZEC, the page nowhere names another coin.
    expect(read(draw(summaryOf(POOL, 1000n, { weeks: weeks.slice(0, 1), totalPaid: weeks[0]!.paid, weeksPaid: 1 }), mineOf(250n, 1000n, POOL, payouts.slice(0, 1))))).not.toMatch(OLD_WORDS);
  });
});

describe("the reserve setting", () => {
  /** What stops a server from starting with these settings. */
  const refusal = async (env: Record<string, string>): Promise<Error> => {
    try {
      await start({ env });
    } catch (error) {
      return error as Error;
    }
    throw new Error("the server started");
  };
  const SITE_COIN = wallet("the site's own coin").address;

  it("must be a Solana address, and not the token's", async () => {
    await expect(start({ env: { RESERVE_ADDRESS: "0x1234" } })).rejects.toThrow(/RESERVE_ADDRESS/);
    await expect(start({ env: { TOKEN_ADDRESS: SITE_COIN, RESERVE_ADDRESS: SITE_COIN } })).rejects.toThrow(/^RESERVE_ADDRESS: must be the pool's wallet, not the coin's own address/);
    // It is kept exactly as it is written.
    const h = await start({ env: { RESERVE_ADDRESS: RESERVE, TOKEN_ADDRESS: SITE_COIN } });
    expect(h.config.reserveAddress).toBe(RESERVE);
    expect(h.config.tokenAddress).toBe(SITE_COIN);
    expect((await h.get("/api/config")).body.reserveAddress).toBe(RESERVE);
    // An address of another kind stops the start, for each of the three settings: the message begins with the setting's name, says what is wanted, and never repeats the value.
    for (const name of ["RESERVE_ADDRESS", "TOKEN_ADDRESS", "REWARD_TOKEN_ADDRESS"]) {
      for (const value of [ADDR.evm3, ADDR.evm3.toLowerCase(), "0x1234", ADDR.btc, `1${RESERVE}`, `${RESERVE}${RESERVE}`]) {
        const error = await refusal({ [name]: value });
        expect(error, `${name} ${value}`).toBeInstanceOf(ConfigError);
        expect(error.message.startsWith(`${name}: `), `${name} ${value}`).toBe(true);
        expect(error.message, `${name} ${value}`).toContain("must be a Solana address");
        expect(error.message, `${name} ${value}`).not.toContain(value);
        expect(error.message, `${name} ${value}`).not.toMatch(/0x|BNB|checksum/);
      }
    }
  });

  it("goes with a reward coin that is ZEC's mint on Solana unless another is named, and that is neither the pool's wallet nor the site's own coin", async () => {
    const OTHER_MINT = wallet("another mint").address;
    expect((await start()).config.rewardTokenAddress).toBe(RESERVE_ASSET.contract);
    expect((await start({ env: { RESERVE_ADDRESS: RESERVE } })).config.rewardTokenAddress).toBe("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS");
    expect((await start({ env: { REWARD_TOKEN_ADDRESS: OTHER_MINT } })).config.rewardTokenAddress).toBe(OTHER_MINT);
    await expect(start({ env: { RESERVE_ADDRESS: RESERVE, REWARD_TOKEN_ADDRESS: RESERVE } })).rejects.toThrow(/^REWARD_TOKEN_ADDRESS: must be the reward coin's mint, not the pool's wallet/);
    await expect(start({ env: { TOKEN_ADDRESS: SITE_COIN, REWARD_TOKEN_ADDRESS: SITE_COIN } })).rejects.toThrow(/^REWARD_TOKEN_ADDRESS: must be the reward coin's mint, not the site's own coin/);
    // The built-in mint is no wallet and no coin of the site's either: named as one of them, it is refused in its turn.
    await expect(start({ env: { RESERVE_ADDRESS: RESERVE_ASSET.contract } })).rejects.toThrow(/^REWARD_TOKEN_ADDRESS: /);
    await expect(start({ env: { TOKEN_ADDRESS: RESERVE_ASSET.contract } })).rejects.toThrow(/^REWARD_TOKEN_ADDRESS: /);
    // There is no setting for a trading pair any more: one that is still set changes nothing and stops nothing.
    const h = await start({ env: { RESERVE_ADDRESS: RESERVE, TOKEN_PAIR_ADDRESS: ADDR.evm2 } });
    expect(h.config.reserveAddress).toBe(RESERVE);
    expect(Object.values(h.config)).not.toContain(ADDR.evm2);
    expect(Object.keys(h.config).filter((key) => /pair/i.test(key))).toEqual([]);
  });
});

// The asset list of the harness has the coins these tests swap.
void ASSET;
