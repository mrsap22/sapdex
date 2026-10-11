// What the site says of its own coin that only Sapling knows: how Sapling splits the fee it takes
// on every trade of a coin, and where this coin's planter chose to send the planter's share.
//
// Sapling's public service is asked by this server, never by a browser: the answer is kept for a
// few minutes and handed on from the site's own address, so that the page asks no other address
// for anything. Two plain GET requests, no key. Nothing is ever sent to Sapling but the coin's own
// public address, and nothing about a visitor.
//
// Nothing here is believed further than it can be checked. An answer that is not exactly the shape
// expected, or whose parts do not add up, is no answer: the page then says nothing of it.

import { checkAddress } from "../shared/addresses.ts";
import type { TokenFacts } from "../shared/api.ts";
import { readCappedText } from "./read.ts";

/** Sapling's public service. The one address this module ever asks. */
export const SAPLING_API = "https://api.sapling.cash/v1";

/** How long an answer is kept before Sapling is asked again, and how long a failed asking is left alone. */
export const SAPLING_KEEP_MS = 5 * 60_000;
const SAPLING_RETRY_MS = 60_000;
const MAX_BYTES = 200_000;

export interface Sapling {
  /** The coin's facts as they were last read. Both parts are null until a read has worked. */
  facts(): Promise<TokenFacts>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const whole = (value: unknown, max: number): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null);

/**
 * The fee Sapling takes on a trade, and its four parts, each in hundredths of a percent of the
 * trade, from Sapling's own settings. The settings give the whole fee, and each part as a share of
 * it out of 10,000; the parts must add up to the whole, and each must come to a whole number of
 * hundredths of a percent. Null for anything else: a figure is never rounded into being.
 */
export function feeSplit(params: unknown): TokenFacts["fee"] {
  if (!isRecord(params) || !isRecord(params.split)) return null;
  const total = whole(params.creatorFeeBps, 1000);
  const parts = [params.split.lp, params.split.rootstock, params.split.treasury, params.split.deployer].map((part) => whole(part, 10_000));
  if (total === null || total === 0 || parts.some((part) => part === null)) return null;
  const [lp, burn, sapling, planter] = parts as [number, number, number, number];
  if (lp + burn + sapling + planter !== 10_000) return null;
  const of = (share: number) => ((total * share) % 10_000 === 0 ? (total * share) / 10_000 : null);
  const [liquidityBps, burnBps, saplingBps, planterBps] = [of(lp), of(burn), of(sapling), of(planter)];
  if (liquidityBps === null || burnBps === null || saplingBps === null || planterBps === null) return null;
  return { totalBps: total, liquidityBps, burnBps, saplingBps, planterBps };
}

/**
 * Whether Sapling says this coin's planter's share goes to the pool's wallet: true when the coin's
 * payee is a wallet and that wallet is the pool's own, letter for letter; false when Sapling names
 * anything else; null when the answer is not about this coin or cannot be read.
 */
export function feedsPool(coin: unknown, mint: string, poolWallet: string): boolean | null {
  if (!isRecord(coin) || coin.mint !== mint || !isRecord(coin.payee) || typeof coin.payee.mode !== "string") return null;
  if (coin.payee.mode !== "wallet") return false;
  return typeof coin.payee.address === "string" ? coin.payee.address === poolWallet : null;
}

export function createSapling(options: { mint: string; poolWallet: string | null; now: () => number; fetchImpl?: typeof fetch }): Sapling {
  const fetchImpl = options.fetchImpl ?? fetch;
  // The coin's address goes into a web address: it is one only if it is a plain Solana address.
  const checked = checkAddress("sol", options.mint);
  const mint = checked.ok ? checked.address : null;

  async function get(path: string): Promise<unknown> {
    const res = await fetchImpl(`${SAPLING_API}${path}`, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return JSON.parse(await readCappedText(res, MAX_BYTES)) as unknown;
  }

  let seen: TokenFacts = { fee: null, feedsPool: null };
  let askedAt: number | null = null;
  let goodAt: number | null = null;
  let asking: Promise<void> | null = null;

  return {
    async facts() {
      const now = options.now();
      const due = askedAt === null || now - askedAt >= (goodAt === askedAt ? SAPLING_KEEP_MS : SAPLING_RETRY_MS);
      if (asking !== null || due) {
        // One asking at a time: requests that arrive while it is under way wait for the same one.
        asking ??= (async () => {
          askedAt = options.now();
          const [params, coin] = await Promise.all([get("/params").catch(() => null), mint === null ? null : get(`/coins/${mint}`).catch(() => null)]);
          const fee = feeSplit(params);
          const feeds = mint === null || options.poolWallet === null ? null : feedsPool(coin, mint, options.poolWallet);
          // What could be read replaces what was known; what could not, leaves it standing until it has grown old.
          if (fee !== null || feeds !== null) goodAt = askedAt;
          seen = { fee: fee ?? seen.fee, feedsPool: feeds ?? seen.feedsPool };
        })().finally(() => {
          asking = null;
        });
        await asking;
      }
      // Figures that have not been confirmed for a long while are no longer said.
      if (goodAt === null || options.now() - goodAt > 6 * SAPLING_KEEP_MS) return { fee: null, feedsPool: null };
      return seen;
    },
  };
}
