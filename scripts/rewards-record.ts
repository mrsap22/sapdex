// Records the transactions that paid a closed week, so that the Rewards page can show them. Run by
// hand, by the operator, after the payouts have been sent from the reserve wallet.
//
//   npm run rewards:record -- --week 2026-W41 --tx <signature> [--tx <signature> …]
//
// Each transaction is checked on Solana first, by its signature. It must have gone through, for
// good, and have taken the reward coin (ZEC on Solana, REWARD_TOKEN_ADDRESS) out of the pool's
// wallet (RESERVE_ADDRESS). It counts only for what it did: ZEC arriving at an address on the
// week's list, for exactly that address's payout, where none is on record for it yet. One
// transaction may pay several addresses. The signature is written down with each payout it made.
// A transaction that made no such payment, or that is on record already for any week, is refused.
// If any one does not pass, nothing is recorded.

import { loadConfig } from "../server/config.ts";
import { createRewards } from "../server/rewards.ts";
import { recordPayouts } from "../server/rewards-tools.ts";
import { createRpc } from "../server/rpc.ts";

function options(name: string): string[] {
  const found: string[] = [];
  process.argv.forEach((arg, at) => {
    const value = process.argv[at + 1];
    if (arg === `--${name}` && value !== undefined) found.push(value);
  });
  return found;
}

try {
  const [week] = options("week");
  const hashes = options("tx");
  if (week === undefined || hashes.length === 0) throw new Error("Usage: npm run rewards:record -- --week 2026-W41 --tx <signature> [--tx <signature> …]");
  const config = loadConfig(process.env);
  if (config.reserveAddress === null) throw new Error("RESERVE_ADDRESS is not set, so there is no pool wallet to check the transactions against.");
  const record = await recordPayouts({ rewards: createRewards(config.dataDir), rpc: createRpc({ urls: config.rpcUrls }), reserve: config.reserveAddress, token: config.rewardTokenAddress, week, hashes, now: Date.now() });
  const due = record.shares.filter((share) => BigInt(share.payout) > 0n);
  const sent = due.filter((share) => share.tx !== undefined).length;
  console.log(`rewards:record: week ${week}: ${sent} of ${due.length} payout(s) now have their transaction on record.`);
  if (sent < due.length) console.log(`rewards:record: ${due.length - sent} still to be sent or recorded.`);
} catch (error) {
  console.error(`rewards:record: ${(error as Error).message}`);
  process.exit(1);
}
