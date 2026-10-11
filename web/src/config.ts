// Interface settings that are decisions, not secrets. Nothing here is sensitive.

/**
 * The pair the card opens with: pay USDC on Base (low fees, and no minimum there), receive ZEC on
 * Solana, the coin every Sapling coin trades in. Both can be changed.
 */
export const DEFAULT_PAIR = {
  from: { chain: "base", symbol: "USDC" },
  to: { chain: "sol", symbol: "ZEC" },
} as const;

/** The coin the receiving side leads with, wherever coins are listed for it: in a chain's list, and among matches on other chains. */
export const RECEIVE_FIRST = "ZEC";

/** The chains the receiving side lists first, before the usual order: where ZEC is received on Solana, and on Zcash itself. */
export const RECEIVE_CHAINS_FIRST = ["sol", "zec"] as const;

/** The amount of the opening pair's first coin used for the example quote on the Docs page. Only the amount is fixed: every number shown comes from the quote. */
export const EXAMPLE_AMOUNT = "100";

/** Coins shown first where coins of every chain are listed together (the picker's matches on other chains), in this order. */
export const PINNED_SYMBOLS = ["ZEC", "USDC", "USDT", "SOL", "ETH", "BTC", "BNB", "NEAR"] as const;

/** Chains in the order they are offered: the picker's grid of chains, the strip on the home page, the Docs' table. Anything not listed follows alphabetically. */
export const CHAIN_ORDER = ["sol", "eth", "base", "btc", "zec", "arb", "bsc", "op", "pol", "avax", "tron", "ton"] as const;

/**
 * How many chains the Stats page's grid keeps room for before the coin list has said how many there
 * are. It is the number on the list today; if the list grows or shrinks, the worst that happens is
 * that the page under the grid moves by one row of it as it loads.
 */
export const CHAINS_EXPECTED = 36;

/** Coins held to a currency's price. On a chain's list in the picker they follow the chain's own coin, in this order. */
export const STABLE_SYMBOLS = ["USDT", "USDC", "USDT0", "DAI", "USDe", "USD1", "USDG", "USDf", "USDCx", "USAD", "FRAX", "EURe", "GBPe"] as const;

export const QUOTE_DEBOUNCE_MS = 400;
export const QUOTE_REFRESH_MS = 15_000;
/** A quote request with no reply after this long is given up on (the server itself answers well within it). */
export const QUOTE_TIMEOUT_MS = 20_000;
/** A quote older than this is not accepted for review without a refresh. */
export const QUOTE_EXPIRES_MS = 60_000;

export const IMPACT_WARN_BPS = 300;
export const IMPACT_BLOCK_BPS = 1000;
export const SLOW_SWAP_SECONDS = 600;
