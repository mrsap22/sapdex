// Reads and validates every environment variable once, at startup.
// A bad value stops the server from starting. Nothing here is ever logged in full.

import path from "node:path";
import { checkAddress } from "../shared/addresses.ts";
import type { Confidentiality } from "../shared/api.ts";
import { WALLET_CHAIN_NODE, WALLET_CHAINS, type WalletChain } from "../shared/chains.ts";
import { RESERVE_ASSET } from "../shared/rewards.ts";

export type RuntimeEnv = "production" | "development" | "test";

export interface Config {
  env: RuntimeEnv;
  port: number;
  dataDir: string;
  trustProxyHops: number;
  oneClickApiKey: string | null;
  oneClickMaxPerMin: number;
  /**
   * How swaps are routed at the provider, as it is in force. "basic" asks for its private routing,
   * where the deposit and the delivery are not tied to each other in public records; "public" is
   * the ordinary kind. Every quote is sent with this level. A request can ask for one swap in
   * public, and nothing more.
   */
  privacyMode: Confidentiality;
  /**
   * True when PRIVACY_MODE was left unset and there is no partner key: the site would route
   * privately, cannot yet, and routes in public until a key is set. Said in the log at start.
   */
  privateRoutingWaitsForKey: boolean;
  /**
   * Where a fee of SaplingDex's is paid. Null when none is set, which only happens while both fee
   * settings are 0: nothing is then sent to the provider in this site's name, and nothing needs it.
   */
  feeRecipient: string | null;
  /** SaplingDex's fee on a publicly routed swap, in basis points. 0, unless it is set: no fee of ours is sent with one. */
  feeBps: number;
  /** SaplingDex's fee on a privately routed swap, in basis points. 0, unless it is set: no fee of ours is sent with one. */
  feeBpsPrivate: number;
  swapsPaused: boolean;
  /**
   * Local development only: use the built-in practice provider for real orders.
   * Without it, development never creates a real order at the provider.
   */
  providerStub: boolean;
  /**
   * Whether visitors are refused by where they are (REGION_BLOCK=on). Off unless it is set: then
   * no request is refused for its country or region, and the region database is never fetched.
   */
  regionBlock: boolean;
  blockedCountries: ReadonlySet<string>;
  /** Whether the site has its Stats page (STATS_PAGE, on unless it is set to "off"). Off, the link, the page's address and its data route are all gone. */
  statsPage: boolean;
  /** Whether gas may be added beside a swap (ADD_GAS, on unless it is set to "off"). Off, a preview of gas answers "not offered" and no gas order is made; swaps are as ever. */
  addGas: boolean;
  /** How many swaps the site must have delivered before the Stats page lists the coins received. */
  statsReceivedMin: number;
  rpcUrls: Readonly<Record<WalletChain | "sol", string>>;
  /** The site's own coin: its mint on Solana. The token's page and the home page's token section are there once it is set. */
  tokenAddress: string | null;
  /** The pool's wallet, on Solana: weekly payouts are sent from it. The site shows what it holds in ZEC, and its payouts, once it is set, and nothing about a pool until then. */
  reserveAddress: string | null;
  /** The coin rewards are paid in: ZEC on Solana, by its mint (REWARD_TOKEN_ADDRESS). The built-in one unless the setting names another. */
  rewardTokenAddress: string;
  /**
   * Whether it has been shown, by a real swap, that ZEC sent to a unified Zcash address with no
   * transparent part arrives shielded (ZEC_SHIELDED). "unproven" unless it is set to "proven": the
   * site then says only that the provider delivers to the address.
   */
  zecShielded: "unproven" | "proven";
  xUrl: string | null;
  /** The project's account on X and its page on GitHub. Each is a link behind an icon in the header and the footer; while unset there is no icon. */
  githubUrl: string | null;
  supportContact: string | null;
  /** Chains that are never offered, whatever the provider lists (the provider's own chain codes): the built-in list and whatever EXCLUDED_CHAINS adds to it. Their coins are left out as the coin list is built. */
  excludedChains: ReadonlySet<string>;
  /** Where the site is reached, as an origin ("https://example.org"). Only used to give link previews the full address of the share image. */
  siteUrl: string | null;
  /** True when SITE_URL itself was set. The site's address is then taken as given everywhere, the sign-in included. */
  siteUrlSet: boolean;
  alertWebhookUrl: string | null;
}

export class ConfigError extends Error {}

/**
 * Chains left off the site, by the provider's chain code. EXCLUDED_CHAINS adds to this list; it
 * cannot remove from it. (A chain on this list has no line of its own in the chain table any more.
 * If a setting could bring its coins back, they would be offered with only the general address
 * check, so no setting can.)
 */
export const DEFAULT_EXCLUDED_CHAINS: readonly string[] = ["abs"];

/**
 * Countries blocked by default: the swap provider's prohibited list plus
 * comprehensively sanctioned jurisdictions. Regions inside Ukraine are handled
 * separately in the geo module. BLOCKED_COUNTRIES adds to this list; it cannot
 * remove from it.
 */
export const DEFAULT_BLOCKED_COUNTRIES: readonly string[] = [
  "AF", // Afghanistan
  "BY", // Belarus
  "CF", // Central African Republic
  "CU", // Cuba
  "CD", // DR Congo
  "GW", // Guinea-Bissau
  "HT", // Haiti
  "IR", // Iran
  "LY", // Libya
  "ML", // Mali
  "MM", // Myanmar
  "NI", // Nicaragua
  "KP", // North Korea
  "RU", // Russia
  "SO", // Somalia
  "SS", // South Sudan
  "SD", // Sudan
  "SY", // Syria
  "VE", // Venezuela
  "YE", // Yemen
  "ZW", // Zimbabwe
];

/** Stands in for a fee address in development and tests, where a fee is set and no address is. Never accepted in production. */
export const DEV_FEE_RECIPIENT = "0x00000000000000000000000000000000000000fe";

const DEFAULT_RPC: Record<WalletChain | "sol", string> = {
  ...WALLET_CHAIN_NODE,
  sol: "https://api.mainnet-beta.solana.com",
};

const RPC_ENV: Record<WalletChain | "sol", string> = {
  bsc: "BSC_RPC_URL",
  eth: "ETH_RPC_URL",
  base: "BASE_RPC_URL",
  arb: "ARBITRUM_RPC_URL",
  sol: "SOLANA_RPC_URL",
};


type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function fail(name: string, why: string): never {
  // The value itself is never included: it may be a secret.
  throw new ConfigError(`${name}: ${why}`);
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name);
  if (raw === null) return fallback;
  if (!/^\d{1,9}$/.test(raw)) fail(name, "must be a whole number");
  const n = Number(raw);
  if (n < min || n > max) fail(name, `must be between ${min} and ${max}`);
  return n;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = read(env, name);
  if (raw === null) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fail(name, 'must be "true" or "false"');
}

/** The only shape the site's own address may have. Also checked where it is written into the page (server/static.ts). */
export const SITE_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

function httpsUrl(env: Env, name: string, allowLocalHttp: boolean): string | null {
  const raw = read(env, name);
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(name, "must be a full URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:")) fail(name, "must start with https://");
  if (url.username !== "" || url.password !== "") {
    // Keys belong in the path or query of the URL, never as user:password.
    fail(name, "must not contain a username or password");
  }
  return url.toString();
}

/** An email address, an https link, or an @handle. Nothing else can become a link on the site. */
export function isSupportContact(value: string): boolean {
  if (value.length < 3 || value.length > 100 || /[\s<>"'`\\]/.test(value)) return false;
  if (/^@[A-Za-z0-9_]{1,30}$/.test(value)) return true;
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value)) return true;
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.includes(".");
  } catch {
    return false;
  }
}


export function loadConfig(env: Env = process.env): Config {
  const mode = read(env, "NODE_ENV") ?? "production";
  if (mode !== "production" && mode !== "development" && mode !== "test") fail("NODE_ENV", "must be production, development or test");
  const runtime: RuntimeEnv = mode;
  const production = runtime === "production";

  const port = int(env, "PORT", 8787, 1, 65535);

  const dataDirRaw = read(env, "DATA_DIR");
  if (production && dataDirRaw === null) fail("DATA_DIR", "is required in production");
  const dataDir = path.resolve(dataDirRaw ?? "data");

  // In production this must be stated: a wrong guess either blocks every visitor or trusts a forged address.
  if (production && read(env, "TRUST_PROXY_HOPS") === null) fail("TRUST_PROXY_HOPS", "is required in production (1 on Railway)");
  const trustProxyHops = int(env, "TRUST_PROXY_HOPS", 0, 0, 5);

  const oneClickApiKey = read(env, "ONECLICK_API_KEY");
  if (oneClickApiKey !== null && !/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(oneClickApiKey)) {
    fail("ONECLICK_API_KEY", "does not look like a partner key (three dot-separated parts)");
  }
  const oneClickMaxPerMin = int(env, "ONECLICK_MAX_PER_MIN", 300, 10, 6000);

  // SaplingDex takes no fee unless one is set: each setting is 0 when left out. A swap routed in
  // public and one routed privately have a setting each, because the provider treats the two
  // differently: it halves the fee of a public swap and keeps one half, and leaves the fee of a
  // private swap whole, adding its own beside it. With a setting at 0 no fee of ours is sent with
  // that kind of quote at all.
  const feeBps = int(env, "FEE_BPS", 0, 0, 300);
  const feeBpsPrivate = int(env, "FEE_BPS_PRIVATE", 0, 0, 300);
  const feeCharged = feeBps > 0 || feeBpsPrivate > 0;

  // Where a fee is paid. It is needed, and read, only while a fee is set: with both settings at 0
  // the server starts without it in every environment, and whatever the variable holds is left
  // unread, as nothing is then sent to the provider in this site's name.
  let feeRecipient = feeCharged ? read(env, "FEE_RECIPIENT") : null;
  if (feeCharged) {
    if (feeRecipient === null) {
      if (production) fail("FEE_RECIPIENT", "is required while FEE_BPS or FEE_BPS_PRIVATE is above 0");
      feeRecipient = DEV_FEE_RECIPIENT;
    }
    const feeCheck = checkAddress("eth", feeRecipient);
    if (feeCheck.ok) {
      // An all-lower-case address carries no checksum, so one wrong character would send every fee
      // to nobody. Production wants the mixed-case form a wallet shows, which catches typos.
      if (production && feeRecipient !== feeCheck.address) fail("FEE_RECIPIENT", "must be copied in its mixed-case (checksum) form, exactly as the wallet shows it");
      feeRecipient = feeCheck.address.toLowerCase();
    } else if (/^0x/i.test(feeRecipient) || !checkAddress("near", feeRecipient).ok) {
      fail("FEE_RECIPIENT", "must be a 0x address or a NEAR account");
    }
    if (production && feeRecipient === DEV_FEE_RECIPIENT) fail("FEE_RECIPIENT", "is still the development placeholder");
  }

  // Swaps stay paused in production unless switched on explicitly.
  const swapsPaused = bool(env, "SWAPS_PAUSED", production);

  const providerStub = bool(env, "PROVIDER_STUB", false);
  if (production && providerStub) fail("PROVIDER_STUB", "is for local development only");
  // The practice provider hands out pretend deposit addresses. It must never sit behind a public address.
  if (providerStub && trustProxyHops > 0) fail("PROVIDER_STUB", "cannot be used behind a proxy; it is for this machine only");

  // Refusing visitors by country or region is a switch, and it is off unless set to "on". Off, nobody
  // is refused for where they are, on any route, and BLOCKED_COUNTRIES is not read at all.
  const regionAsked = read(env, "REGION_BLOCK");
  if (regionAsked !== null && regionAsked !== "on" && regionAsked !== "off") fail("REGION_BLOCK", 'must be "on" or "off"');
  const regionBlock = regionAsked === "on";

  const blocked = new Set(DEFAULT_BLOCKED_COUNTRIES);
  const extra = regionBlock ? read(env, "BLOCKED_COUNTRIES") : null;
  if (extra !== null) {
    for (const code of extra.split(",").map((c) => c.trim().toUpperCase())) {
      if (code === "") continue;
      if (!/^[A-Z]{2}$/.test(code)) fail("BLOCKED_COUNTRIES", "must be two-letter country codes separated by commas");
      blocked.add(code);
    }
  }

  // The Stats page is a switch, and it is on unless set to "off". Off, the site has no link to it, its
  // address is no page and its data route is no route.
  const statsAsked = read(env, "STATS_PAGE");
  if (statsAsked !== null && statsAsked !== "on" && statsAsked !== "off") fail("STATS_PAGE", 'must be "on" or "off"');
  const statsPage = statsAsked !== "off";
  const statsReceivedMin = int(env, "STATS_RECEIVED_MIN", 1, 1, 1_000_000);

  // "Add gas" is a switch, and it is on unless set to "off". Off, the page is never offered gas and no
  // gas order is made, whatever a request asks for. Swaps themselves are untouched by it either way.
  const gasAsked = read(env, "ADD_GAS");
  if (gasAsked !== null && gasAsked !== "on" && gasAsked !== "off") fail("ADD_GAS", 'must be "on" or "off"');
  const addGas = gasAsked !== "off";

  const excludedChains = new Set(DEFAULT_EXCLUDED_CHAINS);
  const excluded = read(env, "EXCLUDED_CHAINS");
  if (excluded !== null) {
    for (const key of excluded.split(",").map((part) => part.trim().toLowerCase())) {
      if (key === "") continue;
      if (!/^[a-z0-9_-]{1,32}$/.test(key)) fail("EXCLUDED_CHAINS", "must be chain codes (such as tron) separated by commas");
      excludedChains.add(key);
    }
  }

  const rpcUrls = { ...DEFAULT_RPC };
  for (const chain of [...WALLET_CHAINS, "sol"] as const) {
    const url = httpsUrl(env, RPC_ENV[chain], !production);
    if (url !== null) rpcUrls[chain] = url;
  }

  // The coin, the pool's wallet and the coin rewards are paid in are all on Solana. Each is checked
  // as a Solana address, exactly as written (capitals are part of one); an address of another kind
  // (a 0x address, say) stops the start. The value is never repeated in the message.
  const solanaAddress = (name: string, what: string): string | null => {
    const given = read(env, name);
    if (given === null) return null;
    const check = checkAddress("sol", given);
    if (!check.ok) fail(name, `must be a Solana address (${what})`);
    return check.address;
  };

  const tokenAddress = solanaAddress("TOKEN_ADDRESS", "the coin's mint");

  const reserveAddress = solanaAddress("RESERVE_ADDRESS", "the pool's wallet");
  if (reserveAddress !== null && reserveAddress === tokenAddress) fail("RESERVE_ADDRESS", "must be the pool's wallet, not the coin's own address");

  // The coin rewards are paid in, by its mint on Solana. Left unset it is the built-in one: ZEC on
  // Solana. The pool, the payout tools and the check of each payout all go by it.
  const rewardTokenAddress: string = solanaAddress("REWARD_TOKEN_ADDRESS", "the reward coin's mint") ?? RESERVE_ASSET.contract;
  if (rewardTokenAddress === reserveAddress) fail("REWARD_TOKEN_ADDRESS", "must be the reward coin's mint, not the pool's wallet");
  if (rewardTokenAddress === tokenAddress) fail("REWARD_TOKEN_ADDRESS", "must be the reward coin's mint, not the site's own coin");

  // Shielded ZEC is a switch, and it is "unproven" unless set to "proven". Unproven, no page says
  // that ZEC arrives shielded. It is set to "proven" only after a real swap has shown it.
  const shieldedAsked = read(env, "ZEC_SHIELDED");
  if (shieldedAsked !== null && shieldedAsked !== "unproven" && shieldedAsked !== "proven") fail("ZEC_SHIELDED", 'must be "unproven" or "proven"');
  const zecShielded = shieldedAsked === "proven" ? "proven" : "unproven";

  // The two links behind the header's icons. Each is held to its own site, over https, with nothing after the path.
  // The project's account on X. None is built in: left unset, the site has no X icon.
  const xUrl = httpsUrl(env, "X_URL", false);
  if (xUrl !== null && !/^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,30}\/?$/.test(xUrl)) fail("X_URL", "must be an x.com profile link");
  // The project's repository. None is built in: left unset, the site has no GitHub icon.
  const githubUrl = httpsUrl(env, "GITHUB_URL", false);
  if (githubUrl !== null && !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9._-]{1,100})?\/?$/.test(githubUrl)) fail("GITHUB_URL", "must be a github.com link, for example https://github.com/name/project");

  const supportContact = read(env, "SUPPORT_CONTACT");
  if (supportContact !== null && !isSupportContact(supportContact)) {
    fail("SUPPORT_CONTACT", "must be an email address, an https link or an @handle, up to 100 characters");
  }
  // A swap can fail, and the page then tells the person to write to support. Before real swaps are
  // switched on there must be someone to write to. A paused site (the state it is deployed in) needs none yet.
  if (production && !swapsPaused && supportContact === null) fail("SUPPORT_CONTACT", "is required before swaps are switched on (SWAPS_PAUSED=false): people need someone to write to when a swap fails");

  // The site's own address. It is written into the page, so it is held to the plainest form there is:
  // the scheme, a host of letters, digits, dots and hyphens, and at most a port. No path, no query,
  // and none of the characters (quotes, "&", "$") that a URL may carry in its host and a page may not.
  let siteUrl = httpsUrl(env, "SITE_URL", !production);
  if (siteUrl !== null) {
    const parsed = new URL(siteUrl);
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") fail("SITE_URL", "must be the site's address alone, for example https://example.org");
    if (!SITE_ORIGIN.test(parsed.origin)) fail("SITE_URL", "must be the site's address alone, for example https://example.org");
    siteUrl = parsed.origin;
  }
  // No address is built in. Set, it is what the page says of itself (the share image's address, each
  // page's canonical link), and the sign-in names it and nothing else. Left unset, the page says
  // neither, and the sign-in names the host it was asked on.
  const siteUrlSet = siteUrl !== null;

  const alertWebhookUrl = httpsUrl(env, "ALERT_WEBHOOK_URL", !production);

  // How swaps are routed. The provider answers private quotes only to a partner with a key, so left
  // unset the setting is private wherever private can work: "basic" with a key, and "public" without
  // one, until there is one. A site that is told nothing about it therefore always starts.
  const privacyAsked = read(env, "PRIVACY_MODE");
  if (privacyAsked !== null && privacyAsked !== "basic" && privacyAsked !== "public") fail("PRIVACY_MODE", 'must be "basic" or "public"');
  const privacyMode: Confidentiality = privacyAsked ?? (oneClickApiKey === null ? "public" : "basic");
  const privateRoutingWaitsForKey = privacyAsked === null && oneClickApiKey === null;
  // Private routing asked for by name, with no key: the live site would answer every swap with
  // "not available". It does not start that way. (Development and tests do, so that private routing
  // can be tried with the practice provider, and say so in the log: see server/app.ts.)
  if (production && privacyAsked === "basic" && oneClickApiKey === null) {
    fail("PRIVACY_MODE", "asks for private routing, and the provider answers private quotes only to a partner with a key. Add ONECLICK_API_KEY, or set PRIVACY_MODE=public");
  }

  return Object.freeze({
    env: runtime,
    port,
    dataDir,
    trustProxyHops,
    oneClickApiKey,
    oneClickMaxPerMin,
    privacyMode,
    privateRoutingWaitsForKey,
    feeRecipient,
    feeBps,
    feeBpsPrivate,
    swapsPaused,
    providerStub,
    regionBlock,
    blockedCountries: blocked,
    statsPage,
    addGas,
    statsReceivedMin,
    rpcUrls: Object.freeze(rpcUrls),
    tokenAddress,
    reserveAddress,
    rewardTokenAddress,
    zecShielded,
    xUrl,
    githubUrl,
    supportContact,
    excludedChains,
    siteUrl,
    siteUrlSet,
    alertWebhookUrl,
  });
}

/** A summary that is safe to log: no secrets and no full RPC URLs. */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    env: config.env,
    port: config.port,
    trustProxyHops: config.trustProxyHops,
    partnerKey: config.oneClickApiKey !== null,
    oneClickMaxPerMin: config.oneClickMaxPerMin,
    privacyMode: config.privacyMode,
    privateRoutingWaitsForKey: config.privateRoutingWaitsForKey,
    feeBps: config.feeBps,
    feeBpsPrivate: config.feeBpsPrivate,
    feeRecipientSet: config.feeRecipient !== null && config.feeRecipient !== DEV_FEE_RECIPIENT,
    swapsPaused: config.swapsPaused,
    providerStub: config.providerStub,
    regionBlock: config.regionBlock,
    blockedCountries: config.regionBlock ? config.blockedCountries.size : 0,
    statsPage: config.statsPage,
    addGas: config.addGas,
    zecShielded: config.zecShielded,
    // Solana's endpoint is left out even by its host: with some providers the host itself names the account.
    rpcHosts: Object.fromEntries(Object.entries(config.rpcUrls).filter(([chain]) => chain !== "sol").map(([chain, url]) => [chain, new URL(url).host])),
    solanaRpcSet: config.rpcUrls.sol !== DEFAULT_RPC.sol,
    tokenPage: config.tokenAddress !== null,
    reserve: config.reserveAddress !== null,
    siteUrl: config.siteUrl !== null,
    alerts: config.alertWebhookUrl !== null,
  };
}
