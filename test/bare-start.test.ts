// The live site, told nothing but the provider's key and the two things its host must say (where
// to keep its files, and that one proxy stands in front of it). It starts, lists coins and answers,
// and every block that needs a setting is absent: no coin, no pool, no links, no address of its
// own. Then each setting is given by itself, and its block, and only its block, appears.

import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boot, type Booted } from "../server/boot.ts";
import { createLogger } from "../server/log.ts";
import { SocialLinks } from "../web/src/components/Social.tsx";
import { HomeSections } from "../web/src/components/Home.tsx";
import { useApp } from "../web/src/stores/app.ts";
import { FIXTURE_TOKENS } from "./helpers.ts";

// Made up for this test: a key of the right shape, a coin's mint and a pool's wallet on Solana.
const KEY = ["practicekey", "practicekey", "practicekey"].join(".");
const MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const POOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

let dir = "";
let running: Booted[] = [];
let lines: string[] = [];

// A pretend outside world: the provider's coin list works, everything else is unreachable.
const network: typeof fetch = async (input) => {
  if (String(input).includes("/v0/tokens")) return new Response(JSON.stringify(FIXTURE_TOKENS));
  throw new Error("unreachable in tests");
};

interface Site {
  get(address: string): Promise<{ status: number; text: string; json: any }>;
  started: Record<string, unknown>;
}

async function site(extra: Record<string, string> = {}): Promise<Site> {
  const siteDir = fs.mkdtempSync(path.join(dir, "site-"));
  fs.copyFileSync(path.resolve("web", "index.html"), path.join(siteDir, "index.html"));
  lines = [];
  const booted = boot({
    env: { NODE_ENV: "production", DATA_DIR: fs.mkdtempSync(path.join(dir, "data-")), TRUST_PROXY_HOPS: "1", PORT: "24680", ONECLICK_API_KEY: KEY, ...extra },
    log: createLogger((line) => lines.push(line)),
    fetchImpl: network,
    siteDir,
  });
  running.push(booted);
  const { server } = booted;
  const really = server.listen.bind(server) as (port: number, host: string | undefined, listening: () => void) => unknown;
  server.listen = ((_asked: number, host: string | undefined, listening: () => void) => {
    really(0, host, listening);
    return server;
  }) as typeof server.listen;
  const address = await new Promise<AddressInfo>((resolve) => booted.start(() => resolve(server.address() as AddressInfo)));
  const started = JSON.parse(lines.find((line) => line.includes('"starting"')) ?? "{}") as Record<string, unknown>;
  return {
    started,
    async get(where) {
      const reply = await fetch(`http://127.0.0.1:${address.port}${where}`, { headers: { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" } });
      const text = await reply.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: reply.status, text, json };
    },
  };
}

/** A part of the page as it is drawn with the given settings from the server. */
function drawnWith(config: object, part: "links" | "home"): string {
  const first = useApp.getInitialState() as { config: unknown };
  const before = first.config;
  first.config = config;
  try {
    return renderToStaticMarkup(part === "links" ? createElement(SocialLinks, { where: "footer" }) : createElement(HomeSections));
  } finally {
    first.config = before;
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "saplingdex-bare-"));
});
afterEach(async () => {
  await Promise.all(running.map((b) => new Promise<void>((resolve) => (b.server.listening ? b.stop(resolve) : resolve()))));
  running = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the live site with nothing set but the provider's key", () => {
  it("starts, answers, lists coins, and routes swaps privately", async () => {
    const s = await site();
    expect((await s.get("/api/status")).json.status).toBe("paused");
    const config = (await s.get("/api/config")).json;
    expect(config.privacyMode).toBe("basic");
    expect(config.zecShielded).toBe("unproven");
    const tokens = (await s.get("/api/tokens")).json;
    expect(tokens.tokens.length).toBeGreaterThan(10);
    expect((await s.get("/")).status).toBe(200);
    // Nothing it logs is an error, but for the one list this pretend world cannot serve.
    expect(lines.filter((line) => line.includes('"level":"error"') && !line.includes("sanctions_refresh_failed"))).toEqual([]);
  });

  it("is paused until swaps are switched on, and then needs only someone to write to", async () => {
    expect(() => boot({ env: { NODE_ENV: "production", DATA_DIR: dir, TRUST_PROXY_HOPS: "1", ONECLICK_API_KEY: KEY, SWAPS_PAUSED: "false" }, log: createLogger(() => undefined), fetchImpl: network, siteDir: dir })).toThrow(/SUPPORT_CONTACT/);
    const s = await site({ SWAPS_PAUSED: "false", SUPPORT_CONTACT: "help@example.org" });
    expect((await s.get("/api/status")).json.status).toBe("ok");
    const config = (await s.get("/api/config")).json;
    expect(config.paused).toBe(false);
    expect(config.tokenAddress).toBeNull();
    expect(config.reserveAddress).toBeNull();
  });

  it("has no coin, no pool, no links and no address of its own, anywhere", async () => {
    const s = await site();
    const config = (await s.get("/api/config")).json;
    expect(config.tokenAddress).toBeNull();
    expect(config.reserveAddress).toBeNull();
    expect(config.xUrl).toBeNull();
    expect(config.githubUrl).toBeNull();
    expect(s.started.solanaRpcSet).toBe(false);
    // The coin: no page, and no facts route.
    expect((await s.get("/token")).status).toBe(404);
    expect((await s.get("/api/token")).status).toBe(404);
    // The pool: the Rewards page still answers, with no pool in it.
    const rewards = (await s.get("/api/rewards")).json;
    expect(rewards.pool).toBeNull();
    // The page itself names no wallet and no address of its own.
    const page = (await s.get("/")).text;
    expect(page).not.toContain("data-rewards-wallet");
    expect(page).not.toContain('rel="canonical"');
    expect(page).not.toContain("og:url");
    // Drawn with those settings: no link icons at all, and no coin section on the home page.
    expect(drawnWith(config, "links")).toBe("");
    const home = drawnWith(config, "home");
    expect(home).not.toContain("sapling.cash");
    expect(home).not.toContain('href="/token"');
  });
});

describe("each block appears when its setting is given, and only then", () => {
  it("TOKEN_ADDRESS: the coin's page and its facts route", async () => {
    const s = await site({ TOKEN_ADDRESS: MINT });
    const config = (await s.get("/api/config")).json;
    expect(config.tokenAddress).toBe(MINT);
    expect(config.reserveAddress).toBeNull();
    expect((await s.get("/token")).status).toBe(200);
    expect((await s.get("/api/token")).status).not.toBe(404);
    expect(drawnWith(config, "home")).toContain(`https://sapling.cash/coin/${MINT}`);
    expect((await s.get("/")).text).not.toContain("data-rewards-wallet");
  });

  it("RESERVE_ADDRESS: the pool's wallet on the page", async () => {
    const s = await site({ RESERVE_ADDRESS: POOL });
    const config = (await s.get("/api/config")).json;
    expect(config.reserveAddress).toBe(POOL);
    expect(config.tokenAddress).toBeNull();
    expect((await s.get("/")).text).toContain(`data-rewards-wallet="${POOL}"`);
    expect((await s.get("/token")).status).toBe(404);
  });

  it("SOLANA_RPC_URL: said as set at start, and never written out", async () => {
    const s = await site({ SOLANA_RPC_URL: "https://node.example.org/key-of-the-node" });
    expect(s.started.solanaRpcSet).toBe(true);
    expect(lines.join("\n")).not.toContain("node.example.org");
    expect((await s.get("/api/config")).text).not.toContain("node.example.org");
  });

  it("SITE_URL: the page says which address is its own", async () => {
    const s = await site({ SITE_URL: "https://example.org" });
    const page = (await s.get("/")).text;
    expect(page).toContain('<link rel="canonical" href="https://example.org/" />');
    expect(page).toContain('<meta property="og:url" content="https://example.org/" />');
  });

  it("X_URL and GITHUB_URL: one icon each", async () => {
    const x = (await (await site({ X_URL: "https://x.com/example" })).get("/api/config")).json;
    expect(x.xUrl).toBe("https://x.com/example");
    expect(x.githubUrl).toBeNull();
    expect(drawnWith(x, "links").match(/<a /g)).toHaveLength(1);
    const g = (await (await site({ GITHUB_URL: "https://github.com/example/example" })).get("/api/config")).json;
    expect(g.githubUrl).toBe("https://github.com/example/example");
    expect(g.xUrl).toBeNull();
    expect(drawnWith(g, "links").match(/<a /g)).toHaveLength(1);
    const both = (await (await site({ X_URL: "https://x.com/example", GITHUB_URL: "https://github.com/example/example" })).get("/api/config")).json;
    expect(drawnWith(both, "links").match(/<a /g)).toHaveLength(2);
  });
});
