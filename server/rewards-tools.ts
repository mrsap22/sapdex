// What the two payout tools do, apart from reading the command line: showing what closing a week
// would do, closing it into a list of payouts, and checking that a payout transaction really paid
// an address on that list from the reserve wallet. Run by hand by the operator; there is no web
// route for any of it, and nothing here sends anything.

import { formatExact, parseAmount } from "../shared/amounts.ts";
import { isValidTxHash } from "../shared/addresses.ts";
import { MICRO, minPayoutFor, RESERVE_ASSET, weekBounds } from "../shared/rewards.ts";
import { decimalsOf, type Rewards, type WeekRecord, type WeekShare } from "./rewards.ts";
import { base58 } from "@scure/base";
import { checkAddress } from "../shared/addresses.ts";
import type { Rpc, RpcCall } from "./rpc.ts";
import type { Sanctions } from "./sanctions.ts";

/** A whole number of millionths as a plain decimal with six places: 1234567n gives "1.234567". */
const sixPlaces = (micro: bigint): string => `${micro / MICRO}.${(micro % MICRO).toString().padStart(6, "0")}`;

/** An amount of a coin, from its smallest unit, as a plain decimal. */
const coins = (raw: bigint, decimals: number): string => formatExact(raw, decimals);

/**
 * The coin rewards are paid in, as the tools need it: the token's mint on Solana, and its
 * decimals. Every amount the tools take, work out and write down is of this token, in its own
 * smallest unit.
 */
export interface RewardToken {
  address: string;
  decimals: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What is asked of Solana is asked of blocks that can no longer be undone. */
const SETTLED = "finalized";

/** The two programs that keep token accounts on Solana. An account kept by anything else is no token account. */
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** A whole number of a coin's smallest unit, as Solana writes one: digits only. Null for anything else. */
const units = (value: unknown): bigint | null => (typeof value === "string" && /^\d{1,40}$/.test(value) ? BigInt(value) : null);

/** The question "which accounts of this mint does this wallet own", as one call. */
const accountsCall = (owner: string, mint: string): RpcCall => ({ method: "getTokenAccountsByOwner", params: [owner, { mint }, { encoding: "jsonParsed", commitment: SETTLED }] });

/**
 * What the answer to that question adds up to, in the mint's smallest unit, and how many accounts
 * it was. Every account must say of itself that it is a token account of that mint, owned by that
 * wallet, kept by a token program: an answer with anything else in it is not believed at all.
 */
function heldIn(result: unknown, owner: string, mint: string): { amount: bigint; accounts: number } | null {
  if (!isRecord(result) || !Array.isArray(result.value)) return null;
  let amount = 0n;
  for (const entry of result.value as unknown[]) {
    const account = isRecord(entry) ? entry.account : null;
    if (!isRecord(account) || typeof account.owner !== "string" || !TOKEN_PROGRAMS.has(account.owner)) return null;
    const parsed = isRecord(account.data) ? account.data.parsed : null;
    const info = isRecord(parsed) && parsed.type === "account" ? parsed.info : null;
    if (!isRecord(info) || info.mint !== mint || info.owner !== owner) return null;
    const held = isRecord(info.tokenAmount) ? units(info.tokenAmount.amount) : null;
    if (held === null) return null;
    amount += held;
  }
  return { amount, accounts: result.value.length };
}

/** A mint's decimals, from what Solana answers when asked for its supply. Null for anything that is not a small whole number. */
function decimalsIn(result: unknown): number | null {
  const value = isRecord(result) && isRecord(result.value) ? result.value.decimals : null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 36 ? value : null;
}

/**
 * The reward token's decimals, as its mint reports them on Solana. Null when they could not be
 * read, and also when the built-in mint reports anything but the 8 it is known to have: nothing is
 * then guessed.
 */
export async function rewardTokenDecimals(rpc: Rpc, token: string): Promise<number | null> {
  try {
    const [reply] = await rpc.solana([{ method: "getTokenSupply", params: [token, { commitment: SETTLED }] }]);
    const decimals = reply !== undefined && reply.ok ? decimalsIn(reply.result) : null;
    if (decimals === null) return null;
    return token === RESERVE_ASSET.contract && decimals !== RESERVE_ASSET.decimals ? null : decimals;
  } catch {
    return null;
  }
}

/** A pool as it is typed ("12.5"), as an amount of the reward token in its smallest unit. Anything that is not an amount of it is refused. */
export function poolAmount(text: string, decimals: number): bigint {
  const amount = parseAmount(text, decimals);
  if (!amount.ok) throw new Error(`"${text}" is not an amount of ${RESERVE_ASSET.symbol}.`);
  return amount.raw;
}

/**
 * The list of payouts for a week, as a CSV: one line per rewards address, in the order of the
 * addresses, with its points (ten for each dollar it swapped, and what was carried in), its share
 * of the week's points, its payout, the points carried into the next week, and what was kept back
 * from an address on the sanctions list. Where Solana was asked, a last column says which of the
 * addresses to be paid have no account for the coin yet. The same week always gives the same text.
 */
export function weekCsv(week: WeekRecord, needAccount: ReadonlySet<string> | null = null): string {
  const total = BigInt(week.totalPointsMicro);
  const coin = week.asset.toLowerCase();
  const decimals = decimalsOf(week);
  // The last column is there only when Solana was asked: "yes" for an address that is paid and has no account for the coin yet.
  const lines = [`rewards_address,points,share,payout_${coin},carried_points,withheld_${coin}${needAccount === null ? "" : `,needs_${coin}_account`}`];
  for (const share of week.shares) {
    const points = BigInt(share.pointsMicro);
    // The share as a decimal fraction of one, to eight places, rounded down.
    const fraction = total === 0n ? 0n : (points * 100_000_000n) / total;
    lines.push([share.address, sixPlaces(points), `${fraction / 100_000_000n}.${(fraction % 100_000_000n).toString().padStart(8, "0")}`, coins(BigInt(share.payout), decimals), sixPlaces(BigInt(share.carriedMicro)), coins(BigInt(share.withheld ?? "0"), decimals), ...(needAccount === null ? [] : [BigInt(share.payout) > 0n && needAccount.has(share.address) ? "yes" : "no"])].join(","));
  }
  return `${lines.join("\n")}\n`;
}

export interface WeekSummary {
  week: string;
  from: string;
  to: string;
  asset: string;
  pool: string;
  /** What is to be sent: the payouts on the list, added up. */
  paid: string;
  /** What stays in the reserve: what rounding left over, shares too small to send, and what was kept back. */
  leftInReserve: string;
  /** Of that, what was kept back from addresses on the sanctions list. */
  withheld: string;
  addresses: number;
  addressesPaid: number;
  addressesCarried: number;
  addressesWithheld: number;
  totalPoints: string;
  /** The week's volume in US dollars, every address's swaps together. Null for a week closed before it was kept. */
  volumeUsd: string | null;
}

export function weekSummary(week: WeekRecord): WeekSummary {
  const bounds = weekBounds(week.week);
  const kept = week.shares.filter((share) => share.withheld !== undefined);
  const decimals = decimalsOf(week);
  return {
    week: week.week,
    from: new Date(bounds?.start ?? 0).toISOString(),
    to: new Date((bounds?.end ?? 1) - 1).toISOString(),
    asset: week.asset,
    pool: coins(BigInt(week.pool), decimals),
    paid: coins(BigInt(week.paid), decimals),
    leftInReserve: coins(BigInt(week.left), decimals),
    withheld: coins(kept.reduce((sum, share) => sum + BigInt(share.withheld ?? "0"), 0n), decimals),
    addresses: week.shares.length,
    addressesPaid: week.shares.filter((share) => BigInt(share.payout) > 0n).length,
    addressesCarried: week.shares.filter((share) => BigInt(share.carriedMicro) > 0n).length,
    addressesWithheld: kept.length,
    totalPoints: sixPlaces(BigInt(week.totalPointsMicro)),
    volumeUsd: week.volumeUsdMicro === undefined ? null : sixPlaces(BigInt(week.volumeUsdMicro)),
  };
}

/**
 * What the reserve wallet holds of the reward token, in the token's smallest unit, with the token's
 * decimals: one request to Solana for both. A wallet may keep one coin in more than one account;
 * they are added up. A wallet with no account for the coin holds none of it. Null when the chain
 * could not be read, or answered with anything that is not plainly this wallet's accounts of this mint.
 */
export async function reserveHolds(rpc: Rpc, reserve: string, token: string): Promise<{ amount: bigint; decimals: number } | null> {
  try {
    const [accounts, supply] = await rpc.solana([accountsCall(reserve, token), { method: "getTokenSupply", params: [token, { commitment: SETTLED }] }]);
    if (accounts === undefined || supply === undefined || !accounts.ok || !supply.ok) return null;
    const held = heldIn(accounts.result, reserve, token);
    const decimals = decimalsIn(supply.result);
    if (held === null || decimals === null) return null;
    // The built-in mint is known to have 8 decimals. An endpoint that says otherwise is not believed.
    if (token === RESERVE_ASSET.contract && decimals !== RESERVE_ASSET.decimals) return null;
    return { amount: held.amount, decimals };
  } catch {
    return null;
  }
}

/**
 * Which of some wallets have no account for the reward token yet. A payment to one of them first
 * opens the account, which costs the sender a little SOL, so the list of payouts says which they
 * are. Null when Solana could not be read: nothing is then said either way.
 */
export async function withoutAccount(rpc: Rpc, owners: readonly string[], token: string): Promise<Set<string> | null> {
  const none = new Set<string>();
  try {
    // A few at a time: a public endpoint takes only small batches.
    for (let at = 0; at < owners.length; at += 10) {
      const some = owners.slice(at, at + 10);
      const replies = await rpc.solana(some.map((owner) => accountsCall(owner, token)));
      for (const [index, owner] of some.entries()) {
        const reply = replies[index];
        const held = reply !== undefined && reply.ok ? heldIn(reply.result, owner, token) : null;
        if (held === null) return null;
        if (held.accounts === 0) none.add(owner);
      }
    }
    return none;
  } catch {
    return null;
  }
}

export interface WeekExport {
  /** True when the week's record is on disk: written by this run, or there already. False for a look at what closing would do. */
  closed: boolean;
  /** True when the week was closed before this run. Its record stands as it is. */
  already: boolean;
  /** What the reserve wallet held of the reward token when it was asked, less what closed weeks are still owed from it, in the token's smallest unit. Null when it was not asked or the chain could not be read. */
  reserveHolds: bigint | null;
  /** The addresses on the list that are to be paid and have no account for the reward token yet: a payment to one costs a little SOL to open it. Null when Solana was not asked or could not be read. */
  needAccount: string[] | null;
  record: WeekRecord;
  csv: string;
  summary: WeekSummary;
}

/**
 * Shows what closing a week with a pool would do, and closes it only when told to.
 *
 * Without `close` nothing at all is written: the week's payouts are worked out, screened and given
 * back to be looked at. With `close` the pool is first checked against what the reserve wallet
 * holds, read from the chain: a pool larger than that, or a balance that cannot be read, closes
 * nothing. A week that is closed already is read back as it stands.
 */
export async function exportWeek(options: { rewards: Rewards; sanctions: Sanctions; rpc: Rpc; reserve: string | null; token: RewardToken; week: string; pool: bigint; asset: string; now: number; close?: boolean }): Promise<WeekExport> {
  const { rewards, week, pool, token } = options;
  const symbol = RESERVE_ASSET.symbol;
  if (options.asset.toUpperCase() !== symbol) throw new Error(`Payouts are sent in ${symbol}. "${options.asset}" is not it.`);
  if (pool < 0n) throw new Error("The pool cannot be less than nothing.");
  const already = rewards.week(week) !== null;
  const plan = rewards.planWeek(week, pool, symbol, minPayoutFor(token.decimals), options.now, options.sanctions, token.decimals);
  // Which of the addresses to be paid have no account for the coin yet. Asked of Solana wherever there is a reserve wallet to pay from; it changes nothing but what the list says.
  const toPay = (record: WeekRecord) => record.shares.filter((share) => BigInt(share.payout) > 0n && share.tx === undefined).map((share) => share.address);
  const asked = async (record: WeekRecord) => (options.reserve === null || toPay(record).length === 0 ? null : await withoutAccount(options.rpc, toPay(record), token.address));
  const out = (record: WeekRecord, need: Set<string> | null, rest: { closed: boolean; already: boolean; reserveHolds: bigint | null }): WeekExport => ({ ...rest, needAccount: need === null ? null : [...need].sort(), record, csv: weekCsv(record, need), summary: weekSummary(record) });
  if (already) return out(plan, await asked(plan), { closed: true, already: true, reserveHolds: null });
  const inWallet = options.reserve === null ? null : ((await reserveHolds(options.rpc, options.reserve, token.address))?.amount ?? null);
  // What earlier closed weeks are still owed out of the same wallet is not there to be shared out a second time:
  // every payout of the reward coin that is on a closed week's list and has no transaction on record yet.
  const owed = rewards
    .weeks()
    .filter((closed) => closed.week !== week && closed.asset === symbol)
    .flatMap((closed) => closed.shares)
    .reduce((sum, share) => (BigInt(share.payout) > 0n && share.tx === undefined ? sum + BigInt(share.payout) : sum), 0n);
  const holds = inWallet === null ? null : inWallet > owed ? inWallet - owed : 0n;
  // Only the word to close closes. Anything else is a look, and a look writes nothing.
  if (options.close !== true) return out(plan, await asked(plan), { closed: false, already: false, reserveHolds: holds });
  // A pool of nothing sends nothing, so there is nothing to check it against: a week from before
  // there was a reserve wallet can be closed, and its points carried, without one.
  if (pool > 0n && options.reserve === null) throw new Error("RESERVE_ADDRESS is not set, so there is no reserve wallet to check the pool against. Nothing was closed.");
  if (pool > 0n && holds === null) throw new Error("The reserve wallet's balance could not be read from Solana, so the pool could not be checked against it. Nothing was closed. Try again shortly.");
  if (holds !== null && pool > holds) throw new Error(`The pool is ${coins(pool, token.decimals)} ${symbol} and the reserve wallet holds ${coins(holds, token.decimals)}${owed > 0n ? ` that is not already owed to earlier weeks (${coins(owed, token.decimals)} is)` : ""}. A week is not closed with more than the reserve holds. Nothing was closed.`);
  const record = rewards.closeWeek(week, pool, symbol, minPayoutFor(token.decimals), options.now, options.sanctions, token.decimals);
  return out(record, await asked(record), { closed: true, already: false, reserveHolds: holds });
}

/** What one wallet received of the reward token in a payout transaction: the reserve wallet's coins, arriving. */
export interface PayoutTransfer {
  /** Who was paid: the wallet that owns the account the coins arrived in, exactly as Solana writes it. */
  to: string;
  amount: bigint;
}

/** What each wallet held of a mint, added up over its accounts, from one of the two lists a Solana transaction carries (before, and after). Null for a list that cannot be read. */
function balancesOf(list: unknown, mint: string): Map<string, bigint> | null {
  if (list === undefined || list === null) return new Map();
  if (!Array.isArray(list)) return null;
  const out = new Map<string, bigint>();
  for (const entry of list as unknown[]) {
    if (!isRecord(entry) || typeof entry.mint !== "string") return null;
    if (entry.mint !== mint) continue;
    const amount = isRecord(entry.uiTokenAmount) ? units(entry.uiTokenAmount.amount) : null;
    // Who owns the account, and which program keeps it, are part of every entry a node of today gives. One without them is not read.
    if (amount === null || typeof entry.owner !== "string" || typeof entry.programId !== "string" || !TOKEN_PROGRAMS.has(entry.programId)) return null;
    out.set(entry.owner, (out.get(entry.owner) ?? 0n) + amount);
  }
  return out;
}

/**
 * Checks on Solana that a transaction went through, for good, and reads what it did with the
 * reward token: what each wallet held of it before and after. It is a payout from the reserve
 * wallet when the reserve wallet's holding of the token went down, every other change of the token
 * is a wallet's holding going up, and the two add up exactly: what left the reserve is what
 * arrived, and nothing of the token moved from or to anywhere else. Each wallet that gained is one
 * transfer, for exactly what it gained. Any other token moving in the same transaction says nothing
 * and counts for nothing. The reason is given in plain words when it did not pass, so that a wrong
 * signature is never recorded.
 */
export async function checkPayoutTx(rpc: Rpc, reserve: string, hash: string, token: string): Promise<{ ok: true; transfers: PayoutTransfer[] } | { ok: false; reason: string }> {
  // A signature is 64 bytes written in base58, in the one way such bytes are written.
  let written: Uint8Array | null;
  try {
    written = isValidTxHash("sol", hash) ? base58.decode(hash) : null;
  } catch {
    written = null;
  }
  if (written === null || written.length !== 64 || base58.encode(written) !== hash) return { ok: false, reason: "that is not a Solana transaction signature" };
  const [reply] = await rpc.solana([{ method: "getTransaction", params: [hash, { encoding: "jsonParsed", commitment: SETTLED, maxSupportedTransactionVersion: 0 }] }]);
  if (reply === undefined || !reply.ok) return { ok: false, reason: "Solana could not be read" };
  if (reply.result === null) return { ok: false, reason: "no such transaction on Solana, or it is not final yet" };
  const meta = isRecord(reply.result) ? reply.result.meta : null;
  if (!isRecord(meta) || !("err" in meta)) return { ok: false, reason: "Solana's answer could not be read" };
  if (meta.err !== null) return { ok: false, reason: "it failed on-chain" };
  const before = balancesOf(meta.preTokenBalances, token);
  const after = balancesOf(meta.postTokenBalances, token);
  if (before === null || after === null) return { ok: false, reason: "Solana's answer could not be read" };
  const change = (owner: string) => (after.get(owner) ?? 0n) - (before.get(owner) ?? 0n);
  const left = -change(reserve);
  if (left <= 0n) return { ok: false, reason: "it took nothing of the reward coin out of the reserve wallet" };
  const transfers: PayoutTransfer[] = [];
  let arrived = 0n;
  for (const owner of new Set([...before.keys(), ...after.keys()])) {
    if (owner === reserve) continue;
    const gained = change(owner);
    if (gained < 0n) return { ok: false, reason: "it also took the reward coin out of another wallet, so it cannot be read as a payout from the reserve" };
    if (gained === 0n) continue;
    // An owner that is not an address a person could have given (a program itself, say) is not a rewards address and is never matched.
    if (!checkAddress("sol", owner).ok) continue;
    transfers.push({ to: owner, amount: gained });
    arrived += gained;
  }
  if (arrived > left) return { ok: false, reason: "more of the reward coin arrived than left the reserve wallet, so it cannot be read as a payout from the reserve" };
  return { ok: true, transfers };
}

/**
 * Records payout transactions for a closed week, after checking each of them. A transaction counts
 * only for what it holds: a transfer of the reward token from the reserve wallet to an address on
 * the week's list, for exactly that address's payout, where no transfer is on record for it. Each
 * such transfer is written down with the share it paid. A transaction that holds none, or that
 * any week has on record already, is refused, and nothing is recorded unless every one passes.
 * (One Solana transaction can pay several addresses; each is matched for itself.)
 */
export async function recordPayouts(options: { rewards: Rewards; rpc: Rpc; reserve: string; token: string; week: string; hashes: readonly string[]; now: number }): Promise<WeekRecord> {
  const { rewards, week } = options;
  const held = rewards.week(week);
  if (held === null) throw new Error(`Week ${week} is not closed. Run rewards:export for it first.`);
  // A week closed in another coin was to be paid in that coin. A transfer of this one is not its payout.
  if (held.asset !== RESERVE_ASSET.symbol) throw new Error(`Week ${week} was closed in ${held.asset}, not in ${RESERVE_ASSET.symbol}. Only payouts in ${RESERVE_ASSET.symbol} are recorded. Nothing was recorded.`);
  if (options.hashes.length === 0) throw new Error("Give at least one transaction hash, with --tx.");
  // The payouts still to be recorded, by address. Each is taken off as a transfer is matched to it.
  const unpaid = new Map<string, WeekShare>(held.shares.filter((share) => BigInt(share.payout) > 0n && share.tx === undefined).map((share) => [share.address, share]));
  const paid: { address: string; hash: string }[] = [];
  // Each transaction once, however often it is given. (A Solana signature has one spelling; capitals are part of it.)
  for (const hash of new Set(options.hashes.map((given) => given.trim()))) {
    const recorded = rewards.weekOfTx(hash);
    if (recorded !== null) throw new Error(`${hash}: it is on record already, for week ${recorded}. Nothing was recorded.`);
    const check = await checkPayoutTx(options.rpc, options.reserve, hash, options.token);
    if (!check.ok) throw new Error(`${hash}: ${check.reason}. Nothing was recorded.`);
    let matched = 0;
    for (const transfer of check.transfers) {
      const share = unpaid.get(transfer.to);
      // The amount must be the listed payout exactly: more or less is not that payout.
      if (share === undefined || BigInt(share.payout) !== transfer.amount) continue;
      unpaid.delete(transfer.to);
      paid.push({ address: share.address, hash });
      matched += 1;
    }
    if (matched === 0) throw new Error(`${hash}: it holds no transfer of ${RESERVE_ASSET.symbol} from the reserve wallet to an address still to be paid in week ${week}, for exactly its payout. Nothing was recorded.`);
  }
  return rewards.recordPaid(week, paid, options.now);
}
