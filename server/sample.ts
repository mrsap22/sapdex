// Sample content for practice mode: past orders in every end state, a token with an address and
// three months of made-up swaps behind the Stats page, so that every screen can be looked at full
// while testing on one's own machine.
//
// It exists only in practice mode (local development with the practice provider). The live site
// never has it: production refuses to start in practice mode, nothing here runs unless practice
// is on, and a test holds both. A data folder that has been given any of it says so in a note of
// its own (SAMPLE-CONTENT), and a server that is not in practice mode will not start on
// such a folder. Every address and hash below is made up from fixed text, so they are nobody's.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { base58 } from "@scure/base";
import { toChecksumAddress } from "../shared/addresses.ts";
import type { CoinRef, OrderDetails, OrderStatus } from "../shared/api.ts";
import { explorerTxUrl } from "../shared/chains.ts";
import type { Config } from "./config.ts";
import type { Delivery, Stats } from "./stats.ts";
import { writeDurable, type OrderRecord, type OrderStore } from "./store.ts";

const made = (label: string, bytes: number) => createHash("sha256").update(`saplingdex sample ${label}`).digest("hex").slice(0, bytes * 2);
const address = (label: string) => toChecksumAddress(`0x${made(label, 20)}`);
const hash = (label: string) => `0x${made(label, 32)}`;
/** A made-up Solana address: 32 bytes written in base58, as a real one is. Nobody holds its key. */
const solAddress = (label: string) => base58.encode(createHash("sha256").update(`saplingdex sample ${label}`).digest());

/** What a practice server shows where the operator has set nothing yet. */
export const SAMPLE = {
  tokenAddress: solAddress("token"),
} as const;

/** Where, inside a data folder, the note is kept that says the folder holds practice content. */
export const SAMPLE_MARKER = "SAMPLE-CONTENT";
/** The same note one folder down, where a data folder filled by an earlier practice server has it. It is read, and never written. */
export const SAMPLE_MARKER_BEFORE = path.join("rewards", "SAMPLE-CONTENT");

/** True when a data folder holds practice content: a practice server has put some there at some time. */
export function holdsSampleContent(dataDir: string): boolean {
  return [SAMPLE_MARKER, SAMPLE_MARKER_BEFORE].some((place) => fs.existsSync(path.join(dataDir, place)));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const QUARTER_MS = HOUR / 4;

const COIN: Record<string, CoinRef> = {
  baseEth: { id: "nep141:base.omft.near", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
  solUsdt: { id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  arbUsdc: { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", name: "USD Coin", chain: "arb", decimals: 6, contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  baseUsdc: { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", symbol: "USDC", name: "USD Coin", chain: "base", decimals: 6, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  btc: { id: "1cs_v1:btc:native:coin", symbol: "BTC", name: "Bitcoin", chain: "btc", decimals: 8, contract: null },
  bnb: { id: "nep245:v2_1.omni.hot.tg:56_11111111111111111111", symbol: "BNB", name: "BNB", chain: "bsc", decimals: 18, contract: null },
};

interface Sample {
  n: number;
  status: OrderStatus;
  /** How long ago it was made, and how long it took. */
  daysAgo: number;
  from: CoinRef;
  to: CoinRef;
  amountIn: string;
  amountOut: string;
  usd: string;
  refundReason?: string;
  /** Part of the amount that arrived, for a deposit that was too small. */
  deposited?: string;
}

const SAMPLES: Sample[] = [
  { n: 1, status: "delivered", daysAgo: 1, from: COIN.baseEth!, to: COIN.solUsdt!, amountIn: "500000000000000000", amountOut: "1236150000", usd: "1240.82" },
  { n: 2, status: "delivered", daysAgo: 3, from: COIN.arbUsdc!, to: COIN.baseEth!, amountIn: "250000000", amountOut: "100412000000000000", usd: "249.91" },
  { n: 3, status: "refunded", daysAgo: 4, from: COIN.baseEth!, to: COIN.arbUsdc!, amountIn: "120000000000000000", amountOut: "297300000", usd: "297.80", refundReason: "SLIPPAGE_EXCEEDED" },
  { n: 4, status: "refunded", daysAgo: 6, from: COIN.baseUsdc!, to: COIN.solUsdt!, amountIn: "100000000", amountOut: "99310000", usd: "99.96", refundReason: "PARTIAL_DEPOSIT", deposited: "40000000" },
  { n: 5, status: "failed", daysAgo: 9, from: COIN.bnb!, to: COIN.arbUsdc!, amountIn: "2000000000000000000", amountOut: "1161200000", usd: "1164.40" },
  // Made a few hours ago: an order nothing was sent to is cleared away a day after its deadline, as on the live site.
  { n: 6, status: "expired", daysAgo: 0, from: COIN.btc!, to: COIN.arbUsdc!, amountIn: "1000000", amountOut: "611900000", usd: "613.25" },
];

/** A made-up order ID of the right shape: 27 characters. */
export const sampleOrderId = (n: number): string => `SampleOrder${String(n).padStart(16, "0")}`;

function sampleOrder(sample: Sample, now: number): OrderRecord {
  // The same made-up person on the chains the samples are paid from and delivered to.
  const owner = address("owner");
  const created = now - sample.daysAgo * DAY - 2 * HOUR;
  const finished = sample.status === "expired" ? created + 2 * HOUR : created + 4 * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const evm = sample.from.chain !== "btc";
  const refund = evm ? owner : "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const paid = hash(`deposit ${sample.n}`);
  const tx = (chain: string, value: string) => [{ hash: value, url: explorerTxUrl(chain, value) }];
  const none: OrderDetails = { originTxs: [], destinationTxs: [], depositedAmount: null, amountIn: null, amountOut: null, refundedAmount: null, refundReason: null };
  const details: OrderDetails | null =
    sample.status === "expired"
      ? null
      : sample.status === "delivered"
        ? { ...none, originTxs: tx(sample.from.chain, paid), destinationTxs: tx(sample.to.chain, hash(`delivery ${sample.n}`)), depositedAmount: sample.amountIn, amountIn: sample.amountIn, amountOut: sample.amountOut }
        : sample.status === "refunded"
          ? { ...none, originTxs: tx(sample.from.chain, paid), depositedAmount: sample.deposited ?? sample.amountIn, refundedAmount: sample.deposited ?? sample.amountIn, refundReason: sample.refundReason ?? null }
          : { ...none, originTxs: tx(sample.from.chain, paid), depositedAmount: sample.amountIn };
  // As on the site: no fee of SaplingDex's, and the provider's own 0.20%.
  const providerAmount = (BigInt(sample.amountIn) * 20n) / 10_000n;
  return {
    v: 1,
    id: sampleOrderId(sample.n),
    createdAt: iso(created),
    pay: "manual",
    from: sample.from,
    to: sample.to,
    amountIn: sample.amountIn,
    amountOut: sample.amountOut,
    minAmountOut: ((BigInt(sample.amountOut) * 99n) / 100n).toString(),
    amountInUsd: sample.usd,
    amountOutUsd: sample.usd,
    slippageBps: 100,
    timeEstimate: 45,
    fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: providerAmount.toString() },
    withdrawFee: null,
    refundFee: null,
    recipient: sample.to.chain === "sol" ? "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" : owner,
    refundTo: refund,
    // Every sample order is an ordinary, publicly routed one.
    confidentiality: "public",
    // The Stats page's sample figures are made up by themselves (see sampleDeliveries); these orders are not added to them.
    statsCounted: true,
    depositAddress: evm ? address(`deposit ${sample.n}`) : `bc1q${made(`deposit ${sample.n}`, 19)}`,
    depositMemo: null,
    deadline: iso(created + 60 * 60_000),
    termsVersion: "sample",
    screening: { result: "clear", listVersion: "sample", checkedAt: iso(created) },
    quoteResponse: { sample: true },
    state: {
      status: sample.status,
      upstreamStatus: sample.status === "delivered" ? "SUCCESS" : sample.status === "refunded" ? "REFUNDED" : sample.status === "failed" ? "FAILED" : "PENDING_DEPOSIT",
      statusSince: iso(finished),
      updatedAt: iso(finished),
      anchor: created,
      depositTxHash: sample.status === "expired" ? null : paid,
      depositVerified: sample.status !== "expired" && evm,
      depositForwarded: sample.status !== "expired",
      details,
      finishedAt: iso(finished),
      stopped: false,
      slowAlertSent: false,
    },
  };
}

/**
 * The coins the made-up swaps behind the Stats page send, the first of them the commonest: each
 * with its chain, how many decimal places its amounts have, and a round price in US dollars to
 * make an amount from.
 */
const SAMPLE_SENT: readonly (readonly [string, string, number, bigint])[] = [
  ["ETH", "base", 18, 2_500n],
  ["USDC", "arb", 6, 1n],
  ["BTC", "btc", 8, 60_000n],
  ["ETH", "base", 18, 2_500n],
  ["BNB", "bsc", 18, 600n],
  ["USDC", "base", 6, 1n],
  ["ETH", "eth", 18, 2_500n],
  ["USDC", "arb", 6, 1n],
  ["SOL", "sol", 9, 150n],
  ["USDT", "sol", 6, 1n],
];
/** How far back the made-up swaps go the first time: 90 days, in quarters of an hour. */
const SAMPLE_QUARTERS = 90 * 96;

/**
 * A made-up transaction hash of the right shape for a chain, and plainly no real one: one figure,
 * repeated from end to end.
 */
function sampleTx(chain: string, figure: number): string {
  const digit = String(1 + (figure % 9));
  return chain === "sol" ? digit.repeat(88) : chain === "btc" ? digit.repeat(64) : `0x${digit.repeat(64)}`;
}

/**
 * Made-up deliveries for the Stats page, for the quarters of an hour from one to another: one or
 * two to most quarters, of every size, worked out from the quarter's own number, so the same
 * quarter always gives the same swaps and some days are busier than others. Each is a sending side
 * and nothing more, as a real one is.
 */
export function sampleDeliveries(fromQuarter: number, toQuarter: number): Delivery[] {
  const out: Delivery[] = [];
  for (let quarter = fromQuarter; quarter <= toQuarter; quarter++) {
    const bytes = createHash("sha256").update(`saplingdex sample swaps ${quarter}`).digest();
    const busy = createHash("sha256").update(`saplingdex sample day ${Math.floor(quarter / 96)}`).digest()[0]! % 5;
    const count = (quarter % 3 === 0 ? 1 : 0) + (bytes[0]! % 8 < busy ? 1 : 0);
    for (let n = 0; n < count; n++) {
      const at = bytes.subarray(n * 8, n * 8 + 8);
      const [symbol, chain, decimals, price] = SAMPLE_SENT[at[0]! % SAMPLE_SENT.length]!;
      // Sizes: about half under $100, a third under $1,000, most of the rest under $10,000, and now and then one above.
      const [floor, span] = at[1]! < 120 ? [8, 90] : at[1]! < 205 ? [100, 900] : at[1]! < 249 ? [1_000, 7_000] : [10_000, 24_000];
      const usdMicro = BigInt(floor) * 1_000_000n + (BigInt(at.readUInt32BE(2)) * BigInt(span) * 1_000_000n) / 0x1_0000_0000n;
      const amount = (usdMicro * 10n ** BigInt(decimals)) / (price * 1_000_000n);
      const delivered = quarter * QUARTER_MS + (at.readUInt16BE(6) % 900) * 1000;
      const seconds = 22 + (at[6]! % 55);
      const [toSymbol, toChain] = SAMPLE_SENT[(at[0]! + 1 + (at[5]! % (SAMPLE_SENT.length - 1))) % SAMPLE_SENT.length]!;
      out.push({ coin: { symbol, chain, decimals }, amount: amount.toString(), usdMicro, tx: sampleTx(chain, at[7]!), seconds, at: delivered, began: delivered - seconds * 1000, to: { symbol: toSymbol, chain: toChain } });
    }
  }
  return out;
}

export interface Samples {
  /** The IDs of the sample orders, newest first: a practice browser lists them under Recent orders. */
  orderIds: string[];
  /** Makes sure the Stats page has made-up swaps up to the last quarter of an hour that has ended. Each quarter is filled once. */
  ensureStats(now: number): void;
}

/**
 * Puts the sample content in place. Only ever in practice mode: called with anything else, it
 * refuses. Safe to run at every start: what is already there is left as it is.
 */
export function seedSamples(options: { practice: boolean; dataDir: string; store: OrderStore; stats?: Stats; now: number }): Samples {
  if (options.practice !== true) throw new Error("sample data is for practice mode only");
  const { store, stats, dataDir, now } = options;
  // Said first, before anything is put in: the folder now holds made-up orders and totals, and
  // only a practice server may start on it (see where server/boot.ts looks for this).
  const marker = path.join(dataDir, SAMPLE_MARKER);
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, "This data folder holds practice content: orders and site totals made up for looking at the site.\nA server that is not in practice mode will not start on it.\n", { mode: 0o600 });
  }
  // The made-up swaps behind the Stats page. A note beside the totals says up to which quarter of an
  // hour they have been added, so that a quarter is never added twice, at this start or a later one.
  const through = path.join(dataDir, "stats", "sample-through");
  let filled: number | null = null;
  const ensureStats = (at: number): void => {
    if (stats === undefined) return;
    const last = Math.floor(at / QUARTER_MS) - 1;
    if (filled === null) {
      try {
        filled = Number(fs.readFileSync(through, "utf8"));
      } catch {
        filled = Number.NaN;
      }
    }
    const first = Number.isSafeInteger(filled) ? Math.max(filled + 1, last - SAMPLE_QUARTERS + 1) : last - SAMPLE_QUARTERS + 1;
    if (first > last) return;
    stats.seed(sampleDeliveries(first, last));
    filled = last;
    writeDurable(through, String(last));
  };
  ensureStats(now);
  for (const sample of SAMPLES) {
    if (store.get(sampleOrderId(sample.n)) !== null) continue;
    store.create(sampleOrder(sample, now));
  }

  return {
    orderIds: SAMPLES.map((sample) => sampleOrderId(sample.n)),
    ensureStats,
  };
}

/** A practice server's settings, with the sample token standing in where none is set. Anything the operator did set is kept. */
export function withSampleSettings(config: Config): Config {
  return Object.freeze({
    ...config,
    tokenAddress: config.tokenAddress ?? SAMPLE.tokenAddress,
  });
}
