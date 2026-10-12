import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toChecksumAddress } from "../shared/addresses.ts";
import { ConfigError, DEFAULT_BLOCKED_COUNTRIES, describeConfig, DEV_FEE_RECIPIENT, isSupportContact, loadConfig } from "../server/config.ts";

const FEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
// Solana addresses made up for these tests (32 bytes in base58): a coin's mint, and a wallet.
const SOL_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const KEY = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
const production = (extra: Record<string, string> = {}) => ({ NODE_ENV: "production", DATA_DIR: "/data", TRUST_PROXY_HOPS: "1", FEE_RECIPIENT: FEE, ...extra });
/** The same with a fee set, which is when the fee recipient is read at all. */
const charging = (extra: Record<string, string> = {}) => production({ FEE_BPS: "40", ...extra });

function problem(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  return "accepted";
}

describe("configuration", () => {
  it("treats an unset NODE_ENV as production", () => {
    expect(problem({})).toBe("DATA_DIR: is required in production");
    expect(loadConfig(production()).env).toBe("production");
  });

  it("has safe production defaults", () => {
    const config = loadConfig(production());
    expect(config).toMatchObject({
      port: 8787,
      trustProxyHops: 1,
      oneClickApiKey: null,
      oneClickMaxPerMin: 300,
      // SaplingDex takes no fee unless one is set.
      feeBps: 0,
      feeBpsPrivate: 0,
      swapsPaused: true,
      providerStub: false,
      tokenAddress: null,
      // No account on X and no repository is built in.
      xUrl: null,
      githubUrl: null,
      supportContact: null,
      alertWebhookUrl: null,
    });
    // With no fee set, the fee recipient is not read, whatever the variable holds.
    expect(config.feeRecipient).toBeNull();
    expect(loadConfig(charging()).feeRecipient).toBe(FEE.toLowerCase());
    expect([...config.blockedCountries].sort()).toEqual([...DEFAULT_BLOCKED_COUNTRIES].sort());
    expect(Object.keys(config.rpcUrls).sort()).toEqual(["arb", "base", "bsc", "eth"]);
  });

  it("blocks every country on the provider's list by default", () => {
    for (const code of ["AF", "BY", "CF", "CU", "CD", "GW", "HT", "IR", "LY", "ML", "MM", "NI", "KP", "RU", "SO", "SS", "SD", "SY", "VE", "YE", "ZW"]) {
      expect(DEFAULT_BLOCKED_COUNTRIES).toContain(code);
    }
    expect(DEFAULT_BLOCKED_COUNTRIES).toHaveLength(21);
  });

  it("starts without a fee recipient while no fee is set, and requires one as soon as either fee is above nothing", () => {
    const bare = { NODE_ENV: "production", DATA_DIR: "/data", TRUST_PROXY_HOPS: "1" };
    expect(problem(bare)).toBe("accepted");
    expect(loadConfig(bare)).toMatchObject({ feeBps: 0, feeBpsPrivate: 0, feeRecipient: null });
    expect(problem({ ...bare, FEE_BPS: "0", FEE_BPS_PRIVATE: "0" })).toBe("accepted");
    // In every environment, and whatever the variable holds: it is not read while no fee is set.
    for (const mode of ["development", "test"]) expect(loadConfig({ NODE_ENV: mode }).feeRecipient, mode).toBeNull();
    for (const held of ["0x1234", FEE.toLowerCase(), "not an address"]) expect(loadConfig({ ...bare, FEE_RECIPIENT: held }).feeRecipient, held).toBeNull();
    // A fee with nowhere to be paid stops the live server, whichever of the two it is.
    for (const fee of [{ FEE_BPS: "1" }, { FEE_BPS_PRIVATE: "1" }, { FEE_BPS: "40", FEE_BPS_PRIVATE: "20" }] as Record<string, string>[]) expect(problem({ ...bare, ...fee }), JSON.stringify(fee)).toBe("FEE_RECIPIENT: is required while FEE_BPS or FEE_BPS_PRIVATE is above 0");
    expect(loadConfig({ ...bare, FEE_BPS_PRIVATE: "20", FEE_RECIPIENT: FEE })).toMatchObject({ feeBps: 0, feeBpsPrivate: 20, feeRecipient: FEE.toLowerCase() });
  });

  it("requires a data folder and the proxy setting in production", () => {
    expect(problem({ NODE_ENV: "production", FEE_RECIPIENT: FEE, TRUST_PROXY_HOPS: "1" })).toBe("DATA_DIR: is required in production");
    // Guessing the proxy setting would either block every visitor or trust a forged address, so it must be stated.
    expect(problem({ NODE_ENV: "production", DATA_DIR: "/data", FEE_RECIPIENT: FEE })).toBe("TRUST_PROXY_HOPS: is required in production (1 on Railway)");
    expect(loadConfig(production({ TRUST_PROXY_HOPS: "0" })).trustProxyHops).toBe(0);
    expect(loadConfig({ NODE_ENV: "development" }).trustProxyHops).toBe(0);
  });

  it("wants the fee recipient in its checksum form in production, so a typo cannot send fees to nobody", () => {
    expect(problem(charging({ FEE_RECIPIENT: toChecksumAddress(DEV_FEE_RECIPIENT) }))).toBe("FEE_RECIPIENT: is still the development placeholder");
    expect(problem(charging({ FEE_RECIPIENT: FEE.toLowerCase() }))).toBe("FEE_RECIPIENT: must be copied in its mixed-case (checksum) form, exactly as the wallet shows it");
    expect(problem(charging({ FEE_RECIPIENT: FEE.toUpperCase().replace("0X", "0x") }))).toBe("FEE_RECIPIENT: must be copied in its mixed-case (checksum) form, exactly as the wallet shows it");
    // One wrong character in the mixed-case form is caught by the checksum.
    expect(problem(charging({ FEE_RECIPIENT: FEE.replace("d8dA", "d8dB") }))).toBe("FEE_RECIPIENT: must be a 0x address or a NEAR account");
    expect(loadConfig(charging({ FEE_RECIPIENT: FEE })).feeRecipient).toBe(FEE.toLowerCase());
    // The same for a fee on private swaps alone.
    expect(problem(production({ FEE_BPS_PRIVATE: "20", FEE_RECIPIENT: FEE.toLowerCase() }))).toBe("FEE_RECIPIENT: must be copied in its mixed-case (checksum) form, exactly as the wallet shows it");
    // Development is lenient.
    expect(loadConfig({ NODE_ENV: "development", FEE_BPS: "40", FEE_RECIPIENT: FEE.toLowerCase() }).feeRecipient).toBe(FEE.toLowerCase());
  });

  it("allows a placeholder fee recipient in development only", () => {
    // Where a fee is set and no address is: for trying a fee on one's own machine.
    const dev = loadConfig({ NODE_ENV: "development", FEE_BPS: "40" });
    expect(dev.feeRecipient).toBe(DEV_FEE_RECIPIENT);
    expect(dev.swapsPaused).toBe(false);
    expect(loadConfig({ NODE_ENV: "development" }).feeRecipient).toBeNull();
  });

  it("accepts a NEAR account as the fee recipient", () => {
    expect(loadConfig(charging({ FEE_RECIPIENT: "fees.saplingdex.near" })).feeRecipient).toBe("fees.saplingdex.near");
  });

  it("refuses the practice provider in production and behind any proxy", () => {
    expect(problem(production({ PROVIDER_STUB: "true" }))).toBe("PROVIDER_STUB: is for local development only");
    expect(problem({ NODE_ENV: "development", PROVIDER_STUB: "true", TRUST_PROXY_HOPS: "1" })).toBe("PROVIDER_STUB: cannot be used behind a proxy; it is for this machine only");
    expect(loadConfig({ NODE_ENV: "development", PROVIDER_STUB: "true" }).providerStub).toBe(true);
  });

  const invalid: Array<[string, Record<string, string>, string]> = [
    ["NODE_ENV", { NODE_ENV: "staging" }, "NODE_ENV"],
    ["PORT", production({ PORT: "eighty" }), "PORT"],
    ["PORT range", production({ PORT: "70000" }), "PORT"],
    ["PORT zero", production({ PORT: "0" }), "PORT"],
    ["TRUST_PROXY_HOPS", production({ TRUST_PROXY_HOPS: "-1" }), "TRUST_PROXY_HOPS"],
    ["TRUST_PROXY_HOPS range", production({ TRUST_PROXY_HOPS: "9" }), "TRUST_PROXY_HOPS"],
    ["ONECLICK_API_KEY", production({ ONECLICK_API_KEY: "not-a-key" }), "ONECLICK_API_KEY"],
    ["ONECLICK_MAX_PER_MIN", production({ ONECLICK_MAX_PER_MIN: "5" }), "ONECLICK_MAX_PER_MIN"],
    ["a routing level this site never asks for", production({ PRIVACY_MODE: "advanced", ONECLICK_API_KEY: KEY }), "PRIVACY_MODE"],
    ["a routing level that is no level", production({ PRIVACY_MODE: "yes" }), "PRIVACY_MODE"],
    ["FEE_RECIPIENT", charging({ FEE_RECIPIENT: "0x1234" }), "FEE_RECIPIENT"],
    ["FEE_RECIPIENT checksum", charging({ FEE_RECIPIENT: FEE.replace("d8dA", "D8dA") }), "FEE_RECIPIENT"],
    ["FEE_BPS under nothing", production({ FEE_BPS: "-1" }), "FEE_BPS"],
    ["FEE_BPS too high", production({ FEE_BPS: "301" }), "FEE_BPS"],
    ["FEE_BPS decimal", production({ FEE_BPS: "40.5" }), "FEE_BPS"],
    ["SWAPS_PAUSED", production({ SWAPS_PAUSED: "yes" }), "SWAPS_PAUSED"],
    ["BLOCKED_COUNTRIES", production({ REGION_BLOCK: "on", BLOCKED_COUNTRIES: "US,Germany" }), "BLOCKED_COUNTRIES"],
    ["BSC_RPC_URL", production({ BSC_RPC_URL: "not a url" }), "BSC_RPC_URL"],
    ["ETH_RPC_URL http", production({ ETH_RPC_URL: "http://rpc.example" }), "ETH_RPC_URL"],
    ["BASE_RPC_URL local http", production({ BASE_RPC_URL: "http://localhost:8545" }), "BASE_RPC_URL"],
    ["ARBITRUM_RPC_URL credentials", production({ ARBITRUM_RPC_URL: "https://user:pass@rpc.example" }), "ARBITRUM_RPC_URL"],
    ["BASE_RPC_URL password only", production({ BASE_RPC_URL: "https://:pass@rpc.example" }), "BASE_RPC_URL"],
    ["ETH_RPC_URL username only", production({ ETH_RPC_URL: "https://user@rpc.example" }), "ETH_RPC_URL"],
    ["ALERT_WEBHOOK_URL credentials", production({ ALERT_WEBHOOK_URL: "https://user:pass@hooks.example/x" }), "ALERT_WEBHOOK_URL"],
    ["SUPPORT_CONTACT script link", production({ SUPPORT_CONTACT: "javascript:alert(1)" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT data link", production({ SUPPORT_CONTACT: "data:text/html,hello" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT http link", production({ SUPPORT_CONTACT: "http://example.org/help" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT plain words", production({ SUPPORT_CONTACT: "call me maybe" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT too long", production({ SUPPORT_CONTACT: `${"a".repeat(100)}@example.org` }), "SUPPORT_CONTACT"],
    ["TOKEN_ADDRESS that is no address", production({ TOKEN_ADDRESS: "0x1234" }), "TOKEN_ADDRESS"],
    ["TOKEN_ADDRESS that is a 0x address, as on BNB Chain", production({ TOKEN_ADDRESS: FEE }), "TOKEN_ADDRESS"],
    ["X_URL", production({ X_URL: "https://example.com/saplingdex" }), "X_URL"],
    ["X_URL script", production({ X_URL: "javascript:alert(1)" }), "X_URL"],
    ["a GitHub link on another site", production({ GITHUB_URL: "https://github.example.org/saplingdex" }), "GITHUB_URL"],
    ["a GitHub link that is not https", production({ GITHUB_URL: "http://github.com/example" }), "GITHUB_URL"],
    ["a GitHub link with markup in it", production({ GITHUB_URL: "https://github.com/example/<b>" }), "GITHUB_URL"],
    ["a list of excluded chains that is not chain codes", production({ EXCLUDED_CHAINS: "abs; drop table" }), "EXCLUDED_CHAINS"],
    ["SUPPORT_CONTACT", production({ SUPPORT_CONTACT: "<script>alert(1)</script>" }), "SUPPORT_CONTACT"],
    ["ALERT_WEBHOOK_URL", production({ ALERT_WEBHOOK_URL: "http://hooks.example/x" }), "ALERT_WEBHOOK_URL"],
    ["a site address that is not https", production({ SITE_URL: "http://saplingdex.example" }), "SITE_URL"],
    ["a site address with a path", production({ SITE_URL: "https://saplingdex.example/app" }), "SITE_URL"],
    ["a site address with a query", production({ SITE_URL: "https://saplingdex.example/?a=1" }), "SITE_URL"],
    ["a site address with a login", production({ SITE_URL: "https://user:pw@saplingdex.example" }), "SITE_URL"],
    ["a site address that is no address", production({ SITE_URL: '"><script>alert(1)</script>' }), "SITE_URL"],
    // A URL may carry these in its host. A page may not.
    ["a site address with a quote in its host", production({ SITE_URL: 'https://exa"mple.org' }), "SITE_URL"],
    ["a site address with an apostrophe in its host", production({ SITE_URL: "https://exa'mple.org" }), "SITE_URL"],
    ["a site address with a dollar sign in its host", production({ SITE_URL: "https://a$'b.org" }), "SITE_URL"],
    ["a site address with an ampersand in its host", production({ SITE_URL: "https://a&b.org" }), "SITE_URL"],
  ];
  it.each(invalid)("refuses a bad %s", (_label, env, variable) => {
    const message = problem(env);
    expect(message.startsWith(`${variable}:`)).toBe(true);
  });

  it("never repeats a bad value in the error, because it may be a secret", () => {
    const secret = "sk-very-secret-value-123";
    for (const variable of ["ONECLICK_API_KEY", "BSC_RPC_URL", "ALERT_WEBHOOK_URL", "FEE_RECIPIENT", "PORT", "SUPPORT_CONTACT<"]) {
      const message = problem(charging({ [variable.replace("<", "")]: variable.endsWith("<") ? `${secret}<` : secret }));
      expect(message).not.toContain(secret);
    }
  });

  it("accepts good values", () => {
    const config = loadConfig(
      production({
        PORT: "3000",
        TRUST_PROXY_HOPS: "1",
        ONECLICK_API_KEY: "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
        ONECLICK_MAX_PER_MIN: "600",
        FEE_BPS: "60",
        SWAPS_PAUSED: "false",
        REGION_BLOCK: "on",
        BLOCKED_COUNTRIES: "us, gb",
        BSC_RPC_URL: "https://bsc.example/v1/key123",
        TOKEN_ADDRESS: SOL_MINT,
        X_URL: "https://x.com/example",
        GITHUB_URL: "https://github.com/example/project",
        SUPPORT_CONTACT: "help@saplingdex.example",
        ALERT_WEBHOOK_URL: "https://hooks.example/services/abc",
      }),
    );
    expect(config).toMatchObject({ port: 3000, trustProxyHops: 1, feeBps: 60, swapsPaused: false, oneClickMaxPerMin: 600, tokenAddress: SOL_MINT });
    // The two links behind the header's icons. Each is optional; none is built in, so none is set until the operator sets it.
    expect(config).toMatchObject({ xUrl: "https://x.com/example", githubUrl: "https://github.com/example/project" });
    const none = { xUrl: null, githubUrl: null };
    expect(loadConfig(production({}))).toMatchObject(none);
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }]) expect(loadConfig(env)).toMatchObject(none);
    expect(loadConfig(production({ X_URL: " ", GITHUB_URL: "" }))).toMatchObject(none);
    // Each is still held to its own site and to a plain path.
    for (const wrong of ["https://x.com.evil.example/a", "https://x.com/a?b=1", "https://evil.example/x.com/a"]) expect(problem(production({ X_URL: wrong })), wrong).toMatch(/^X_URL: /);
    for (const wrong of ["https://github.com.evil.example/a", "https://github.com/a/b/c", "https://evil.example/github.com/a"]) expect(problem(production({ GITHUB_URL: wrong })), wrong).toMatch(/^GITHUB_URL: /);
    expect(loadConfig(production({ GITHUB_URL: "https://github.com/example" })).githubUrl).toBe("https://github.com/example");
    expect(config.blockedCountries.has("US")).toBe(true);
    expect(config.blockedCountries.has("GB")).toBe(true);
    expect(config.rpcUrls.bsc).toBe("https://bsc.example/v1/key123");
  });

  it("needs a support contact before swaps are switched on in production, and not while they are paused", () => {
    expect(loadConfig(production()).swapsPaused).toBe(true);
    expect(loadConfig(production()).supportContact).toBeNull();
    expect(problem(production({ SWAPS_PAUSED: "false" })).startsWith("SUPPORT_CONTACT: is required before swaps are switched on")).toBe(true);
    expect(loadConfig(production({ SWAPS_PAUSED: "false", SUPPORT_CONTACT: "help@saplingdex.example" })).swapsPaused).toBe(false);
    // Local development needs none.
    expect(loadConfig({ NODE_ENV: "development", SWAPS_PAUSED: "false" }).supportContact).toBeNull();
  });

  it("ADD_GAS is on unless it is set to off, in every place a server runs", () => {
    for (const env of [production(), { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
      expect(loadConfig(env)).toMatchObject({ addGas: true });
      expect(loadConfig({ ...env, ADD_GAS: "on" }).addGas).toBe(true);
      expect(loadConfig({ ...env, ADD_GAS: "off" }).addGas).toBe(false);
    }
    for (const wrong of ["false", "0", "no", "OFF", "none"]) expect(problem(production({ ADD_GAS: wrong })), wrong).toBe('ADD_GAS: must be "on" or "off"');
    expect(describeConfig(loadConfig(production({ ADD_GAS: "off" })))).toMatchObject({ addGas: false });
    expect(describeConfig(loadConfig(production()))).toMatchObject({ addGas: true });
  });

  it("STATS_PAGE is on unless it is set to off, in every place a server runs", () => {
    for (const env of [production(), { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
      expect(loadConfig(env)).toMatchObject({ statsPage: true });
      expect(loadConfig({ ...env, STATS_PAGE: "on" }).statsPage).toBe(true);
      expect(loadConfig({ ...env, STATS_PAGE: "off" }).statsPage).toBe(false);
    }
    for (const wrong of ["false", "0", "no", "OFF", "hide"]) expect(problem(production({ STATS_PAGE: wrong })), wrong).toBe('STATS_PAGE: must be "on" or "off"');
    expect(describeConfig(loadConfig(production({ STATS_PAGE: "off" })))).toMatchObject({ statsPage: false });
    // The list of recent swaps has no threshold any more: a setting left over from when it had one is not read, and says nothing.
    expect(loadConfig(production({ STATS_FEED_MIN: "25" }))).not.toHaveProperty("statsFeedMin");
    expect(describeConfig(loadConfig(production({ STATS_FEED_MIN: "25" })))).not.toHaveProperty("statsFeedMin");
  });

  describe("REGION_BLOCK, whether visitors are refused by where they are", () => {
    const places: Array<[string, Record<string, string>]> = [["production", production()], ["development", { NODE_ENV: "development" }], ["test", { NODE_ENV: "test" }]];

    it("is off unless it is set to on, in every place a server runs, and says so in the summary that goes to the log", () => {
      for (const [place, env] of places) {
        expect(loadConfig(env).regionBlock, place).toBe(false);
        for (const unset of ["", "  ", "off"]) expect(loadConfig({ ...env, REGION_BLOCK: unset }).regionBlock, place).toBe(false);
        expect(loadConfig({ ...env, REGION_BLOCK: "on" }).regionBlock, place).toBe(true);
      }
      expect(describeConfig(loadConfig(production()))).toMatchObject({ regionBlock: false, blockedCountries: 0 });
      expect(describeConfig(loadConfig(production({ REGION_BLOCK: "on" })))).toMatchObject({ regionBlock: true, blockedCountries: DEFAULT_BLOCKED_COUNTRIES.length });
    });

    it("takes the two words only", () => {
      for (const wrong of ["true", "1", "yes", "ON", "Off", "block", "basic"]) expect(problem(production({ REGION_BLOCK: wrong })), wrong).toBe('REGION_BLOCK: must be "on" or "off"');
    });

    it("off, BLOCKED_COUNTRIES is not read at all: nothing in it is used, and nothing in it can stop the server", () => {
      for (const list of ["US,GB", "us, gb", "US,Germany", "!!", "x"]) {
        const config = loadConfig(production({ BLOCKED_COUNTRIES: list }));
        expect([...config.blockedCountries].sort(), list).toEqual([...DEFAULT_BLOCKED_COUNTRIES].sort());
      }
      // On, it adds to the built-in list as it always did, and a bad entry stops the server.
      const on = loadConfig(production({ REGION_BLOCK: "on", BLOCKED_COUNTRIES: "us, gb" }));
      expect(on.blockedCountries.has("US") && on.blockedCountries.has("GB") && on.blockedCountries.has("IR")).toBe(true);
      expect(problem(production({ REGION_BLOCK: "on", BLOCKED_COUNTRIES: "US,Germany" }))).toBe("BLOCKED_COUNTRIES: must be two-letter country codes separated by commas");
    });
  });

  describe("FEE_BPS_PRIVATE, SaplingDex's fee on a privately routed swap", () => {
    it("is nothing unless it is set, as the public fee is, and is in the summary that goes to the log", () => {
      expect(loadConfig(production()).feeBpsPrivate).toBe(0);
      expect(loadConfig(production({ FEE_BPS: "60" }))).toMatchObject({ feeBps: 60, feeBpsPrivate: 0 });
      expect(loadConfig({ NODE_ENV: "development" })).toMatchObject({ feeBps: 0, feeBpsPrivate: 0 });
      // Left empty is left unset.
      for (const empty of ["", "  "]) expect(loadConfig(production({ FEE_BPS_PRIVATE: empty, FEE_BPS: empty }))).toMatchObject({ feeBps: 0, feeBpsPrivate: 0 });
      expect(describeConfig(loadConfig(production()))).toMatchObject({ feeBps: 0, feeBpsPrivate: 0, feeRecipientSet: false });
    });

    it("is its own setting: a whole number from 0 to 300, and the public fee is not touched by it", () => {
      for (const [set, held] of [["0", 0], ["1", 1], ["20", 20], ["35", 35], ["300", 300]] as const) expect(loadConfig(production({ FEE_BPS_PRIVATE: set })), set).toMatchObject({ feeBps: 0, feeBpsPrivate: held });
      for (const [set, held] of [["0", 0], ["1", 1], ["40", 40], ["300", 300]] as const) expect(loadConfig(production({ FEE_BPS: set })), set).toMatchObject({ feeBps: held, feeBpsPrivate: 0 });
      expect(describeConfig(loadConfig(production({ FEE_BPS_PRIVATE: "20" })))).toMatchObject({ feeBpsPrivate: 20, feeRecipientSet: true });
    });

    it("stops the server on anything else, and names the setting", () => {
      for (const wrong of ["-1", "301", "20.5", "twenty", "0x14", "1e2", "20 bps"]) expect(problem(production({ FEE_BPS_PRIVATE: wrong })), wrong).toMatch(/^FEE_BPS_PRIVATE: /);
    });
  });

  describe("the coin: on Solana", () => {
    it("it is a Solana address, kept exactly as it is written", () => {
      const config = loadConfig(production({ TOKEN_ADDRESS: SOL_MINT }));
      expect(config).toMatchObject({ tokenAddress: SOL_MINT });
      // Spaces round it are not part of it.
      expect(loadConfig(production({ TOKEN_ADDRESS: ` ${SOL_MINT} ` })).tokenAddress).toBe(SOL_MINT);
      // None is set until the operator sets it: the site then has no token page.
      expect(loadConfig(production())).toMatchObject({ tokenAddress: null });
      for (const empty of ["", "  "]) expect(loadConfig(production({ TOKEN_ADDRESS: empty }))).toMatchObject({ tokenAddress: null });
    });

    it.each(["TOKEN_ADDRESS"])("%s: an address of any other kind stops the start, with a line that names the setting and never repeats the value", (name) => {
      // A 0x address, in either spelling; a NEAR account; a Zcash address; a Solana address with a character changed, cut short or run on; a program's own address.
      for (const wrong of [FEE, FEE.toLowerCase(), "0x1234", "wrap.near", "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", SOL_MINT.replace("E", "0"), SOL_MINT.slice(0, 20), `${SOL_MINT}${SOL_MINT}`, "11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]) {
        const message = problem(production({ [name]: wrong }));
        expect(message, wrong).toMatch(new RegExp(`^${name}: must be a Solana address`));
        expect(message, wrong).not.toContain(wrong);
        // It is the line the log prints: "config_invalid" with the setting's name, and nothing of what was typed.
        expect(message.startsWith(`${name}:`)).toBe(true);
      }
    });

    it("a setting the server does not read changes nothing, whatever it is set to: a host's variables may hold one, and the server starts all the same", () => {
      const before = loadConfig(production({ TOKEN_ADDRESS: SOL_MINT }));
      const after = loadConfig(production({ TOKEN_ADDRESS: SOL_MINT, TOKEN_PAIR_ADDRESS: "not even an address", DEXSCREENER_URL: "not a link", REOWN_PROJECT_ID: "abc", RESERVE_ADDRESS: SOL_WALLET, REWARD_TOKEN_ADDRESS: SOL_MINT, SOLANA_RPC_URL: "https://node.example.org/key" }));
      expect(after).toEqual(before);
      // Nor does one that would once have been refused: an address of the wrong kind, the coin's own address, a link that is no link.
      expect(loadConfig(production({ TOKEN_ADDRESS: SOL_MINT, RESERVE_ADDRESS: FEE, REWARD_TOKEN_ADDRESS: "near", SOLANA_RPC_URL: "ftp://rpc.example" }))).toEqual(before);
      expect(loadConfig(production({ TOKEN_ADDRESS: SOL_MINT, RESERVE_ADDRESS: SOL_MINT }))).toEqual(before);
      for (const gone of ["tokenPairAddress", "dexscreenerUrl", "reownProjectId", "reserveAddress", "rewardTokenAddress"]) expect(before).not.toHaveProperty(gone);
      expect(Object.keys(before.rpcUrls).sort()).toEqual(["arb", "base", "bsc", "eth"]);
      expect(JSON.stringify(describeConfig(after))).not.toMatch(/node\.example\.org|solana|reserve/i);
      const source = fs.readFileSync(path.resolve("server", "config.ts"), "utf8");
      expect(source).not.toMatch(/TOKEN_PAIR_ADDRESS|DEXSCREENER|REOWN|RESERVE_ADDRESS|REWARD_TOKEN|SOLANA_RPC|checkAddress\("bsc"/);
    });
  });

  describe("PRIVACY_MODE, how swaps are routed", () => {
    // The three places a server runs. The live one is told the least it must be told, and nothing about routing.
    const places: Array<[string, Record<string, string>]> = [["production", production()], ["development", { NODE_ENV: "development" }], ["test", { NODE_ENV: "test" }]];
    const WAITS = { privacyMode: "public", privateRoutingWaitsForKey: true };

    it("left unset: private where there is a partner key, and public until there is one, so a site told nothing always starts", () => {
      for (const [place, env] of places) {
        // With a key the provider answers private quotes, so that is how swaps are routed.
        expect(loadConfig({ ...env, ONECLICK_API_KEY: KEY }), place).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
        // Without one it could not work. The server starts, routes in public, and knows that private routing is waiting for a key.
        expect(loadConfig(env), place).toMatchObject(WAITS);
        // Left empty is left unset.
        expect(loadConfig({ ...env, PRIVACY_MODE: "" }), place).toMatchObject(WAITS);
        expect(loadConfig({ ...env, PRIVACY_MODE: "  " }), place).toMatchObject(WAITS);
        expect(loadConfig({ ...env, PRIVACY_MODE: " ", ONECLICK_API_KEY: KEY }).privacyMode, place).toBe("basic");
      }
      // The mode in force, and whether it is waiting, are in the summary that goes to the log.
      expect(describeConfig(loadConfig(production()))).toMatchObject(WAITS);
      expect(describeConfig(loadConfig(production({ ONECLICK_API_KEY: KEY })))).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
    });

    it("basic, written out: private, and the live site does not start that way without a partner key", () => {
      for (const [place, env] of places) expect(loadConfig({ ...env, PRIVACY_MODE: "basic", ONECLICK_API_KEY: KEY }), place).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
      // Asked for by name where it cannot work: the live site would answer every swap "not available", so it says what to set and stops.
      expect(problem(production({ PRIVACY_MODE: "basic" }))).toBe("PRIVACY_MODE: asks for private routing, and the provider answers private quotes only to a partner with a key. Add ONECLICK_API_KEY, or set PRIVACY_MODE=public");
      // Development and tests start: there private routing can be tried with the practice provider, which needs no key.
      for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }]) expect(loadConfig({ ...env, PRIVACY_MODE: "basic" })).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
    });

    it("public, written out: public whatever else is set, and nothing is waiting", () => {
      for (const [place, env] of places) {
        expect(loadConfig({ ...env, PRIVACY_MODE: "public" }), place).toMatchObject({ privacyMode: "public", privateRoutingWaitsForKey: false });
        expect(loadConfig({ ...env, PRIVACY_MODE: "public", ONECLICK_API_KEY: KEY }), place).toMatchObject({ privacyMode: "public", privateRoutingWaitsForKey: false });
      }
    });

    it("anything else stops the server wherever it runs, the provider's third level among them", () => {
      for (const bad of ["advanced", "private", "Basic", "PUBLIC", "true", "off", "basic,public", "basic public"]) {
        for (const [place, env] of places) {
          expect(problem({ ...env, PRIVACY_MODE: bad }), `${bad} in ${place}`).toBe('PRIVACY_MODE: must be "basic" or "public"');
          expect(problem({ ...env, PRIVACY_MODE: bad, ONECLICK_API_KEY: KEY }), `${bad} in ${place}`).toBe('PRIVACY_MODE: must be "basic" or "public"');
        }
      }
    });
  });

  it("keeps the site's own address as an origin, and has none built in: unset, the site names no address of its own", () => {
    // Told nothing, the site has no address, on the live site as anywhere.
    expect(loadConfig(production())).toMatchObject({ siteUrl: null });
    expect(loadConfig(production({ SITE_URL: "  " }))).toMatchObject({ siteUrl: null });
    // Set, it is taken as given.
    expect(loadConfig(production({ SITE_URL: "https://saplingdex.example" }))).toMatchObject({ siteUrl: "https://saplingdex.example" });
    // No address is written into the code that loads the settings.
    expect(fs.readFileSync(path.resolve("server", "config.ts"), "utf8")).not.toMatch(/DEFAULT_(?:SITE|X|GITHUB)_URL/);
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }]) expect(loadConfig(env)).toMatchObject({ siteUrl: null });
    expect(loadConfig(production({ SITE_URL: "https://SaplingDex.example/" })).siteUrl).toBe("https://saplingdex.example");
    expect(loadConfig(production({ SITE_URL: "https://saplingdex.example:8443" })).siteUrl).toBe("https://saplingdex.example:8443");
  });

  it("accepts a support contact that is an email address, an https link or a handle", () => {
    for (const contact of ["help@saplingdex.example", "support+swaps@mail.example.org", "https://t.me/saplingdex_help", "https://example.org/support?topic=swap", "@saplingdex"]) {
      expect(isSupportContact(contact), contact).toBe(true);
      expect(loadConfig(production({ SUPPORT_CONTACT: contact })).supportContact).toBe(contact);
    }
    for (const contact of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "mailto:a@b.co", "//evil.example", "https://user:pw@example.org", "https://localhost", "a@b", "@", "<b>@x.co", "x y@z.co", ""]) {
      expect(isSupportContact(contact), contact).toBe(false);
    }
  });

  it("lets BLOCKED_COUNTRIES add to the built-in list but never remove from it", () => {
    // (Read only where the region block is on.)
    const config = loadConfig(production({ REGION_BLOCK: "on", BLOCKED_COUNTRIES: "US" }));
    for (const code of DEFAULT_BLOCKED_COUNTRIES) expect(config.blockedCountries.has(code)).toBe(true);
    expect(config.blockedCountries.size).toBe(DEFAULT_BLOCKED_COUNTRIES.length + 1);
  });

  it("is frozen", () => {
    const config = loadConfig(production());
    expect(() => {
      (config as { feeBps: number }).feeBps = 0;
    }).toThrow();
  });

  it("describes itself for the log without secrets or full RPC URLs", () => {
    const config = loadConfig(
      charging({
        ONECLICK_API_KEY: "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
        BSC_RPC_URL: "https://bsc.example/v1/SECRET-PATH-KEY",
        ALERT_WEBHOOK_URL: "https://hooks.example/services/SECRET-HOOK",
      }),
    );
    const text = JSON.stringify(describeConfig(config));
    for (const secret of ["aaaaaaaaaaaa", "SECRET-PATH-KEY", "SECRET-HOOK", "hooks.example", FEE.toLowerCase()]) expect(text).not.toContain(secret);
    expect(text).toContain("bsc.example");
    expect(describeConfig(config)).toMatchObject({ partnerKey: true, alerts: true, feeRecipientSet: true });
  });
});
