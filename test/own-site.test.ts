// What makes this site its own, and true of itself: it says on every page that it is independent;
// it says that ZEC arrives shielded only once that has been shown; what it knows of its coin it
// reads from Sapling through its own server; and no page of it asks any other address for anything.

import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../server/http.ts";
import { loadConfig } from "../server/config.ts";
import { createSapling, feedsPool, feeSplit, SAPLING_API, SAPLING_KEEP_MS } from "../server/sapling.ts";
import { docSlugs, GAS_DOC_SLUG, GHOST_DOC_SLUG, PRIVATE_DOC_SLUG } from "../shared/pages.ts";
import { INDEPENDENCE } from "../shared/positioning.ts";
import { SHIELDED_CLAIMS, SHIELDED_DOCS, SHIELDED_FAQ, SHIELDED_HOME, UNIFIED_REFUND, UNIFIED_SHIELDED_PROVEN, UNIFIED_TRANSPARENT_PROVEN, UNIFIED_UNPROVEN, zcashNote, zecShieldedOf } from "../shared/shielded.ts";
import { AddressField } from "../web/src/components/AddressField.tsx";
import { Faq, questions } from "../web/src/components/Faq.tsx";
import { HomeSections, TokenSection } from "../web/src/components/Home.tsx";
import { Footer } from "../web/src/components/Shell.tsx";
import DocsPage from "../web/src/pages/DocsPage.tsx";
import { PrivacyPage, TermsPage } from "../web/src/pages/LegalPages.tsx";
import { useApp } from "../web/src/stores/app.ts";
import { harness, ZEC_MINT } from "./helpers.ts";

const root = path.resolve("web", "src");
const read = (...parts: string[]) => fs.readFileSync(path.resolve(...parts), "utf8");
const sources = (dir: string, kinds = /\.(tsx?|css|html)$/): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(dir, entry.name), kinds) : kinds.test(entry.name) ? [path.join(dir, entry.name)] : []));
const name = (file: string) => path.relative(path.resolve("."), file).split(path.sep).join("/");

/** A page as it is drawn with the given settings from the server. */
function drawnWith(config: object | null, page: () => ReactElement): string {
  const first = useApp.getInitialState() as { config: unknown };
  const before = first.config;
  first.config = config;
  try {
    return renderToStaticMarkup(page());
  } finally {
    first.config = before;
  }
}
const wordsOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// Made up for these tests: a coin's mint and a pool's wallet on Solana.
const MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const POOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const BASE = { supportContact: null, tokenAddress: null, reserveAddress: null, paused: false, privacyMode: "basic", statsPage: true };
const UNPROVEN = { ...BASE, zecShielded: "unproven" };
const PROVEN = { ...BASE, zecShielded: "proven" };
// Zcash's own example addresses (ZIP 316, ZIP 320): public, and nobody's to spend from.
const UNIFIED_SHIELDED = "u1ddnjsdcpm36r6aq79n3s68shjweksnmwtdltrh046s8m6xcws9ygyawalxx8n6hg6vegk0wh8zjnafxgh6msppjsljvyt0ynece3lvm0";
const UNIFIED_WITH_TRANSPARENT = "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf";
const TEX = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";
const TRANSPARENT = "t1KRqwQhktLV4BjbNLiuH6pb3AMoszZKcQB";

const docs = (slug: Parameters<typeof DocsPage>[0]["slug"]) => () => createElement(DocsPage, { slug });
const EVERY_DOC = [null, ...docSlugs(true)] as Parameters<typeof DocsPage>[0]["slug"][];

describe("the site says that it is its own", () => {
  it("in these words, which name whom it is not: Sapling, the Zcash Foundation, Electric Coin Co. and NEAR", () => {
    expect(INDEPENDENCE).toBe("SaplingDex is an independent project and is not affiliated with or endorsed by Sapling, the Zcash Foundation, Electric Coin Co. or NEAR.");
  });

  it("in the footer of every page: there is one footer, the app draws it under every page, and it carries the line", () => {
    expect(wordsOf(drawnWith(BASE, () => createElement(Footer)))).toContain(INDEPENDENCE);
    expect(wordsOf(drawnWith(null, () => createElement(Footer)))).toContain(INDEPENDENCE);
    // Also where the site cannot be used from, and before the server has answered.
    const shell = read("web", "src", "components", "Shell.tsx");
    const footer = shell.slice(shell.indexOf("export function Footer()"), shell.indexOf("export function Toast()"));
    expect(footer).toContain('<p className="footer-own muted">{INDEPENDENCE}</p>');
    // The line is outside everything that is drawn only sometimes.
    expect(footer.slice(0, footer.indexOf("footer-own"))).not.toMatch(/\? \(\s*$/);
    // The app draws it in two places, and they are the only two ways a page of the live site is drawn: the page
    // itself, and the notice that stands in when a page could not be loaded at all.
    const app = read("web", "src", "App.tsx");
    expect(app.match(/<Footer \/>/g)).toHaveLength(2);
    const frame = app.slice(app.lastIndexOf("\n  return ("));
    expect(frame).toMatch(/<Header \/>[\s\S]*\{page\}[\s\S]*<Footer \/>/);
    // No page draws a footer of its own, with or without the line.
    for (const file of sources(root, /\.tsx$/).filter((one) => !one.endsWith("Shell.tsx") && !one.endsWith("App.tsx"))) expect(read(file), name(file)).not.toMatch(/<footer\b|<Footer\b/);
  });

  it("on the token's page and in the home page's token section", () => {
    for (const ownPage of [true, false]) expect(wordsOf(drawnWith({ ...BASE, tokenAddress: MINT, reserveAddress: POOL }, () => createElement(TokenSection, { ownPage })))).toContain(INDEPENDENCE);
  });

  it("in the first paragraph of the Docs, and in the Terms", () => {
    const first = drawnWith(BASE, docs(null));
    const lead = /<p class="[^"]*lead[^"]*">(.*?)<\/p>/.exec(first)?.[1] ?? "";
    expect(wordsOf(lead)).toContain(INDEPENDENCE);
    // It is the page's opening paragraph: it stands under the title and before the first section.
    const words = wordsOf(first);
    expect(words.indexOf(INDEPENDENCE)).toBeGreaterThan(words.lastIndexOf("How it works", words.indexOf(INDEPENDENCE)));
    expect(words.indexOf(INDEPENDENCE)).toBeLessThan(words.indexOf("Sapling is a launchpad on Solana"));
    expect(words.indexOf(INDEPENDENCE)).toBeLessThan(words.indexOf("Choose the coin you pay"));
    expect(wordsOf(drawnWith(BASE, () => createElement(TermsPage)))).toContain(INDEPENDENCE);
    expect(wordsOf(drawnWith(BASE, () => createElement(Faq)))).toContain(INDEPENDENCE);
  });

  it("and never presents itself as Sapling's, or anyone as a partner", () => {
    const pages: (() => ReactElement)[] = [...EVERY_DOC.map((slug) => docs(slug)), () => createElement(HomeSections), () => createElement(Faq), () => createElement(TermsPage), () => createElement(PrivacyPage), () => createElement(TokenSection, { ownPage: true }), () => createElement(Footer)];
    for (const page of pages) {
      const words = wordsOf(drawnWith({ ...PROVEN, tokenAddress: MINT, reserveAddress: POOL }, page)).replaceAll(INDEPENDENCE, "");
      expect(words).not.toMatch(/\bpartner(s|ed|ship)?\b|official(ly)?\b|endorsed|sponsored|made by Sapling|by the Sapling team|Sapling's own (site|swap|dex)|a Sapling (product|site|service)/i);
      // What swaps run on is named in these words and no stronger ones.
      for (const said of words.match(/[^.]*NEAR Intents[^.]*\./g) ?? []) expect(said).not.toMatch(/partner|together with|in cooperation|backed/i);
    }
    // The wordmark is the one word, in the site's own upright type: never "Sapling" with a smaller "Dex" beside it.
    const brand = read("web", "src", "components", "Brand.tsx");
    expect(brand).toContain('<span className="wordmark-text">SaplingDex</span>');
    expect(brand).not.toMatch(/>Sapling<|<small|<sup|<sub/);
    const wordmark = /\.wordmark \{[^}]*\}/.exec(read("web", "src", "styles", "shell.css"))?.[0] ?? "";
    expect(wordmark).not.toMatch(/font-style: italic|font-family: var\(--font-display\)/);
  });

  it("uses nothing of Sapling's: no file of theirs, no address of theirs for a picture, a font or a stylesheet", () => {
    for (const file of [...sources(root), path.resolve("web", "index.html")]) {
      const text = read(file);
      // The one address of Sapling's the pages hold is the link to the coin's own page there.
      for (const match of text.matchAll(/[a-z.]*sapling\.cash[^\s"'`)]*/g)) expect(match[0], name(file)).toMatch(/^sapling\.cash\/coin\/\$\{mint\}$/);
      expect(text, name(file)).not.toMatch(/IM Fell|Schibsted|Spline Sans/i);
    }
    for (const file of sources(path.resolve("web", "public"), /./)) expect(path.basename(file), name(file)).not.toMatch(/sapling(?!dex)/i);
  });
});

describe("what is said of ZEC arriving shielded follows the server's setting, and nothing is claimed until it is proven", () => {
  it("the setting is unproven unless it is set to proven, and anything else stops the start", () => {
    const production = (extra: Record<string, string> = {}) => ({ NODE_ENV: "production", DATA_DIR: "/data", TRUST_PROXY_HOPS: "1", ...extra });
    expect(loadConfig(production()).zecShielded).toBe("unproven");
    expect(loadConfig(production({ ZEC_SHIELDED: " " })).zecShielded).toBe("unproven");
    expect(loadConfig(production({ ZEC_SHIELDED: "unproven" })).zecShielded).toBe("unproven");
    expect(loadConfig(production({ ZEC_SHIELDED: "proven" })).zecShielded).toBe("proven");
    for (const wrong of ["yes", "true", "on", "Proven", "PROVEN", "1"]) expect(() => loadConfig(production({ ZEC_SHIELDED: wrong })), wrong).toThrow(/^ZEC_SHIELDED: must be "unproven" or "proven"$/);
    // The page takes anything but the one word as unproven: a server that says nothing claims nothing.
    for (const told of [null, undefined, {}, { zecShielded: "unproven" }, { zecShielded: true }, { zecShielded: "Proven" }]) expect(zecShieldedOf(told as never)).toBe("unproven");
    expect(zecShieldedOf({ zecShielded: "proven" })).toBe("proven");
  });

  it("beside a unified address: unproven, only that the provider delivers to it; proven, that it is shielded, and only for one with no transparent part", () => {
    expect(zcashNote("unified-shielded", "receive", "unproven")).toBe(UNIFIED_UNPROVEN);
    expect(zcashNote("unified-transparent", "receive", "unproven")).toBe(UNIFIED_UNPROVEN);
    expect(zcashNote("unified-shielded", "receive", "proven")).toBe(UNIFIED_SHIELDED_PROVEN);
    expect(zcashNote("unified-transparent", "receive", "proven")).toBe(UNIFIED_TRANSPARENT_PROVEN);
    // A refund: what was verified is that the provider accepts the address, and nothing more is said, whatever the setting.
    for (const state of ["unproven", "proven"] as const) for (const kind of ["unified-shielded", "unified-transparent"] as const) expect(zcashNote(kind, "refund", state)).toBe(UNIFIED_REFUND);
    // A transparent or a TEX address is public on Zcash as it always was: nothing new is said of it.
    for (const state of ["unproven", "proven"] as const) for (const kind of ["transparent", "tex", null] as const) for (const use of ["receive", "refund"] as const) expect(zcashNote(kind, use, state)).toBeNull();
    expect(UNIFIED_UNPROVEN).toBe("Delivered to this address. Not confirmed as shielded.");
    expect(UNIFIED_UNPROVEN).not.toMatch(/arrives shielded|is shielded|privately|in a shielded pool/i);
    expect(UNIFIED_REFUND).not.toMatch(/shielded/i);
    // Each fits the one line under an address field.
    for (const line of [UNIFIED_UNPROVEN, UNIFIED_SHIELDED_PROVEN, UNIFIED_TRANSPARENT_PROVEN, UNIFIED_REFUND]) expect(line.length, line).toBeLessThanOrEqual(60);
  });

  it("as the address field draws it, for each kind of Zcash address and each setting", () => {
    const field = (value: string, use: "receive" | "refund", config: object) => wordsOf(drawnWith(config, () => createElement(AddressField, { label: "Receiving address", hint: "Your ZEC is sent here. Use a wallet you control.", chain: "zec", value, onChange: () => undefined, use })));
    expect(field(UNIFIED_SHIELDED, "receive", UNPROVEN)).toContain(UNIFIED_UNPROVEN);
    expect(field(UNIFIED_WITH_TRANSPARENT, "receive", UNPROVEN)).toContain(UNIFIED_UNPROVEN);
    expect(field(UNIFIED_SHIELDED, "receive", PROVEN)).toContain(UNIFIED_SHIELDED_PROVEN);
    expect(field(UNIFIED_WITH_TRANSPARENT, "receive", PROVEN)).toContain(UNIFIED_TRANSPARENT_PROVEN);
    expect(field(UNIFIED_WITH_TRANSPARENT, "receive", PROVEN)).not.toContain(UNIFIED_SHIELDED_PROVEN);
    expect(field(UNIFIED_SHIELDED, "refund", PROVEN)).toContain(UNIFIED_REFUND);
    for (const config of [UNPROVEN, PROVEN, null, BASE]) {
      for (const address of [TRANSPARENT, TEX]) expect(field(address, "receive", config as object)).toContain("Your ZEC is sent here. Use a wallet you control.");
      // Before the settings arrive, and from a server that says nothing, the claim is not made.
      if (config !== PROVEN) for (const address of [UNIFIED_SHIELDED, UNIFIED_WITH_TRANSPARENT, TRANSPARENT, TEX]) for (const claim of SHIELDED_CLAIMS) expect(field(address, "receive", config as object)).not.toContain(claim);
    }
    // The older shielded kind is refused, with the sentence that says what to use.
    expect(field("zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly", "receive", PROVEN)).toContain("zs1 addresses are not supported. Use a unified one (u1).");
    // On any other chain the field says nothing of Zcash at all.
    const solana = wordsOf(drawnWith(PROVEN, () => createElement(AddressField, { label: "Receiving address", hint: "Your ZEC is sent here.", chain: "sol", value: POOL, onChange: () => undefined })));
    expect(solana).not.toMatch(/shielded|unified/i);
  });

  const PAGES: (readonly [string, () => ReactElement])[] = [["the home page", () => createElement(HomeSections)], ["the questions", () => createElement(Faq)], ...EVERY_DOC.map((slug) => [`Docs, ${slug ?? "how it works"}`, docs(slug)] as const), ["the Terms", () => createElement(TermsPage)], ["the Privacy Policy", () => createElement(PrivacyPage)], ["the token's page", () => createElement(TokenSection, { ownPage: true })], ["the footer", () => createElement(Footer)]];

  it("draws every page it is about", () => {
    expect(PAGES.length).toBeGreaterThan(12);
    expect(EVERY_DOC).toEqual(expect.arrayContaining([null, "chains", "faq", PRIVATE_DOC_SLUG, GHOST_DOC_SLUG, GAS_DOC_SLUG]));
    expect(SHIELDED_CLAIMS).toEqual([UNIFIED_SHIELDED_PROVEN, SHIELDED_HOME, ...SHIELDED_DOCS, SHIELDED_FAQ.question, SHIELDED_FAQ.answer]);
    for (const claim of SHIELDED_CLAIMS) expect(claim, claim).toMatch(/shield/i);
  });

  it.each<readonly [string, object | null]>([["while the setting is unproven", UNPROVEN], ["from a server that says nothing of it", BASE], ["before the server's settings have arrived", null], ["with the coin and the pool set, unproven", { ...UNPROVEN, tokenAddress: MINT, reserveAddress: POOL }]])("%s, no page holds any sentence that says ZEC arrives shielded", (_when, config) => {
    for (const [label, page] of PAGES) {
      const drawn = wordsOf(drawnWith(config, page));
      for (const claim of SHIELDED_CLAIMS) expect(drawn, `${label}: ${claim.slice(0, 40)}`).not.toContain(claim);
      // Nor in any other words: nothing says that ZEC is, arrives or is delivered shielded, or to a shielded address or pool.
      // (The one sentence that says it is NOT confirmed is set aside; so is the page on private routing, which says how
      // private routing differs from shielded coins and claims nothing of this site's deliveries.)
      const words = drawn.replace("It is not confirmed whether the ZEC arrives there shielded, so this site does not say that it does.", "").replace(/How it differs from shielded coins/g, "").replace(/Shielded coins hide amounts and addresses on their own chain, by cryptography\./g, "");
      expect(words, label).not.toMatch(/(?:arrives?|delivered|received?|sent|is|are) (?:there )?(?:in a |to a |at a )?shielded|shielded (?:delivery|ZEC|swap)|to a shielded|at a shielded|in a shielded pool/i);
    }
    expect(questions(true, zecShieldedOf(config)).map((item) => item.id)).not.toContain("shielded-zec");
  });

  it("while it is unproven the Docs say what is known and no more: the address kinds, and that shielded arrival is not confirmed", () => {
    const words = wordsOf(drawnWith(UNPROVEN, docs("chains")));
    expect(words).toContain("ZEC on Zcash can be received at a transparent address (it starts with t1 or t3), a TEX address (tex1) or a unified address (u1). Addresses that start with zs1 are not supported.");
    expect(words).toContain("The provider delivers to a unified address. It is not confirmed whether the ZEC arrives there shielded, so this site does not say that it does.");
    expect(words).toContain("The provider accepts it; how a refund to one arrives is not confirmed.");
  });

  it("once it is proven, each sentence is where it belongs: the home page, the Docs, the questions; and the unproven one is gone", () => {
    expect(wordsOf(drawnWith(PROVEN, () => createElement(HomeSections)))).toContain(`ZEC can arrive at a shielded address. ${SHIELDED_HOME}`);
    const chains = wordsOf(drawnWith(PROVEN, docs("chains")));
    for (const sentence of SHIELDED_DOCS) expect(chains).toContain(sentence);
    expect(chains).not.toContain("It is not confirmed whether the ZEC arrives there shielded");
    for (const page of [() => createElement(Faq), docs("faq")]) {
      const words = wordsOf(drawnWith(PROVEN, page));
      expect(words).toContain(SHIELDED_FAQ.question);
      expect(words).toContain(SHIELDED_FAQ.answer);
    }
    expect(questions(true, "proven").map((item) => item.id)).toContain("shielded-zec");
    expect(questions(false, "proven").map((item) => item.id)).toContain("shielded-zec");
    // What is proven is delivery by the provider to the address given. The site never says that it shields anything itself.
    for (const claim of SHIELDED_CLAIMS) expect(claim).not.toMatch(/we shield|SaplingDex shields|shielded by SaplingDex|for you/i);
    expect(SHIELDED_DOCS.join(" ")).toContain("SaplingDex never receives your ZEC to shield it: the provider delivers to the address you gave.");
  });

  it("every sentence that makes the claim is written in one file, and no page writes one of its own", () => {
    for (const file of sources(root, /\.tsx?$/).filter((one) => !one.endsWith("StatesPage.tsx"))) {
      const text = read(file).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1");
      // A page may say the word in two places only: the home page's title for the sentence it is given, and the Docs' sentence that says it is NOT confirmed.
      const said = [...text.matchAll(/[^\n]*shielded[^\n]*/gi)].map((match) => match[0].trim()).filter((line) => !/import |zecShieldedOf|shieldedOnly|SHIELDED_|shielded === "proven"|shielded !== "proven"|const shielded|shielded: ZecShielded|, shielded\)|shielded-zec/.test(line));
      for (const line of said) expect(/title="ZEC can arrive at a shielded address\."|It is not confirmed whether the ZEC arrives there shielded|How it differs from shielded coins|Shielded coins hide amounts and addresses on their own chain/.test(line), `${name(file)}: ${line.slice(0, 90)}`).toBe(true);
    }
  });

  it("the site never holds anyone's ZEC to shield it: nothing in it receives or forwards a coin", () => {
    // No code of the server signs or sends a transaction on any chain, and none holds a key that could.
    for (const file of [...sources(path.resolve("server"), /\.ts$/), ...sources(path.resolve("shared"), /\.ts$/), ...sources(path.resolve("scripts"), /\.ts$/).filter((one) => /rewards-(export|record)\.ts$/.test(one))]) {
      expect(read(file), name(file)).not.toMatch(/sendTransaction|sendRawTransaction|signTransaction|eth_sendRawTransaction|PRIVATE_KEY|SEED_PHRASE|MNEMONIC|createPrivateKey|secretKey|Keypair/);
    }
  });
});

describe("what the site says of its coin is read from Sapling by its own server", () => {
  const PARAMS = { creatorFeeBps: 200, split: { lp: 2500, rootstock: 2500, treasury: 1000, deployer: 4000 }, zecMint: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS" };
  const coin = (payee: unknown, mint = MINT) => ({ mint, name: "SaplingDex", symbol: "SAPDEX", payee });

  it("the fee and its four parts come from Sapling's own settings, in hundredths of a percent of a trade", () => {
    expect(feeSplit(PARAMS)).toEqual({ totalBps: 200, liquidityBps: 50, burnBps: 50, saplingBps: 20, planterBps: 80 });
    // If Sapling changes its numbers, theirs are used.
    expect(feeSplit({ creatorFeeBps: 100, split: { lp: 5000, rootstock: 2000, treasury: 2000, deployer: 1000 } })).toEqual({ totalBps: 100, liquidityBps: 50, burnBps: 20, saplingBps: 20, planterBps: 10 });
  });

  it("settings that do not add up, or cannot be read, give no figures at all: none is rounded into being", () => {
    for (const wrong of [null, undefined, "200", [], {}, { creatorFeeBps: 200 }, { split: PARAMS.split }, { ...PARAMS, creatorFeeBps: "200" }, { ...PARAMS, creatorFeeBps: 0 }, { ...PARAMS, creatorFeeBps: -200 }, { ...PARAMS, creatorFeeBps: 2.5 }, { ...PARAMS, creatorFeeBps: 5000 }, { ...PARAMS, split: { ...PARAMS.split, deployer: 3999 } }, { ...PARAMS, split: { ...PARAMS.split, lp: "2500" } }, { ...PARAMS, split: { lp: 2500, rootstock: 2500, treasury: 1000 } }, { ...PARAMS, split: { lp: 3333, rootstock: 3333, treasury: 3334, deployer: 0 } }, { ...PARAMS, split: { lp: -1000, rootstock: 5000, treasury: 2000, deployer: 4000 } }]) {
      expect(feeSplit(wrong), JSON.stringify(wrong)?.slice(0, 80)).toBeNull();
    }
  });

  it("the coin feeds the pool only when Sapling says its planter's share goes to the pool's own wallet, letter for letter", () => {
    expect(feedsPool(coin({ mode: "wallet", address: POOL, isPlanter: false }), MINT, POOL)).toBe(true);
    expect(feedsPool(coin({ mode: "wallet", address: MINT }), MINT, POOL)).toBe(false);
    expect(feedsPool(coin({ mode: "wallet", address: POOL.toLowerCase() }), MINT, POOL)).toBe(false);
    expect(feedsPool(coin({ mode: "holders", address: null }), MINT, POOL)).toBe(false);
    expect(feedsPool(coin({ mode: "zcash-foundation", address: null }), MINT, POOL)).toBe(false);
    // An answer about another coin, or one that cannot be read, says nothing either way.
    expect(feedsPool(coin({ mode: "wallet", address: POOL }, POOL), MINT, POOL)).toBeNull();
    for (const unreadable of [null, undefined, "coin", {}, coin(null), coin({}), coin({ mode: 5 }), coin({ mode: "wallet" }), coin({ mode: "wallet", address: 7 })]) expect(feedsPool(unreadable, MINT, POOL), JSON.stringify(unreadable)).toBeNull();
  });

  /** A pretend Sapling: what it was asked, and what it answers. */
  function pretendSapling(answers: { params?: unknown; coin?: unknown; status?: number; fail?: boolean }) {
    const asked: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, method: init?.method ?? "GET", body: init?.body ?? null, headers: (init?.headers ?? {}) as Record<string, string> });
      if (answers.fail === true) throw new Error("network down");
      const body = url.endsWith("/params") ? answers.params : answers.coin;
      return new Response(JSON.stringify(body ?? { error: { code: "not_found" } }), { status: body === undefined ? 404 : (answers.status ?? 200), headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { asked, fetchImpl, answers };
  }

  it("asks Sapling two plain questions, sends nothing but the coin's own address, and keeps the answer for a few minutes", async () => {
    const clock = { t: 1_000_000 };
    const there = pretendSapling({ params: PARAMS, coin: coin({ mode: "wallet", address: POOL }) });
    const sapling = createSapling({ mint: MINT, poolWallet: POOL, now: () => clock.t, fetchImpl: there.fetchImpl });
    expect(await sapling.facts()).toEqual({ fee: { totalBps: 200, liquidityBps: 50, burnBps: 50, saplingBps: 20, planterBps: 80 }, feedsPool: true });
    expect(there.asked.map((one) => one.url).sort()).toEqual([`${SAPLING_API}/coins/${MINT}`, `${SAPLING_API}/params`]);
    expect(SAPLING_API).toBe("https://api.sapling.cash/v1");
    for (const one of there.asked) {
      expect(one.method).toBe("GET");
      expect(one.body).toBeNull();
      // No key, no cookie, nothing that says who is looking at the site.
      expect(Object.keys(one.headers).map((key) => key.toLowerCase())).toEqual(["accept"]);
    }
    // Asked again within the few minutes, by however many visitors: Sapling is not asked again.
    clock.t += SAPLING_KEEP_MS - 1;
    await Promise.all([sapling.facts(), sapling.facts(), sapling.facts()]);
    expect(there.asked).toHaveLength(2);
    clock.t += 2;
    await sapling.facts();
    expect(there.asked).toHaveLength(4);
  });

  it("visitors arriving together share one asking", async () => {
    const there = pretendSapling({ params: PARAMS, coin: coin({ mode: "wallet", address: POOL }) });
    const sapling = createSapling({ mint: MINT, poolWallet: POOL, now: () => 5, fetchImpl: there.fetchImpl });
    const all = await Promise.all(Array.from({ length: 20 }, () => sapling.facts()));
    expect(there.asked).toHaveLength(2);
    for (const facts of all) expect(facts.feedsPool).toBe(true);
  });

  it("when Sapling cannot be read, nothing is made up: no figures until a read has worked, and old ones are dropped once they are old", async () => {
    const clock = { t: 0 };
    const there = pretendSapling({ fail: true });
    const sapling = createSapling({ mint: MINT, poolWallet: POOL, now: () => clock.t, fetchImpl: there.fetchImpl });
    expect(await sapling.facts()).toEqual({ fee: null, feedsPool: null });
    // A failed asking is left alone for a minute, then tried again.
    clock.t += 30_000;
    await sapling.facts();
    expect(there.asked).toHaveLength(2);
    clock.t += 31_000;
    there.answers.fail = false;
    there.answers.params = PARAMS;
    there.answers.coin = coin({ mode: "wallet", address: POOL });
    expect(await sapling.facts()).toEqual({ fee: { totalBps: 200, liquidityBps: 50, burnBps: 50, saplingBps: 20, planterBps: 80 }, feedsPool: true });
    // Sapling goes away again: what was read stands for a while, with nothing changed.
    there.answers.fail = true;
    clock.t += SAPLING_KEEP_MS + 1;
    expect((await sapling.facts()).feedsPool).toBe(true);
    // And is no longer said once it has not been confirmed for half an hour.
    clock.t += 6 * SAPLING_KEEP_MS;
    expect(await sapling.facts()).toEqual({ fee: null, feedsPool: null });
  });

  it("an answer of the wrong shape, an error page or a coin Sapling does not know says nothing", async () => {
    for (const answers of [{ params: "<html>error</html>", coin: [] }, { params: PARAMS, coin: coin({ mode: "wallet", address: POOL }), status: 500 }, { params: { ...PARAMS, split: {} }, coin: undefined }]) {
      const there = pretendSapling(answers);
      expect(await createSapling({ mint: MINT, poolWallet: POOL, now: () => 1, fetchImpl: there.fetchImpl }).facts(), JSON.stringify(answers).slice(0, 60)).toEqual({ fee: null, feedsPool: null });
    }
    // With no pool wallet set there is nothing for the coin to feed: the split is still read, and the coin is not said to feed anything.
    const there = pretendSapling({ params: PARAMS, coin: coin({ mode: "wallet", address: POOL }) });
    expect(await createSapling({ mint: MINT, poolWallet: null, now: () => 1, fetchImpl: there.fetchImpl }).facts()).toEqual({ fee: { totalBps: 200, liquidityBps: 50, burnBps: 50, saplingBps: 20, planterBps: 80 }, feedsPool: null });
    // An address that is not a plain Solana address is never written into a web address.
    const odd = pretendSapling({ params: PARAMS });
    await createSapling({ mint: "../../admin?x=", poolWallet: POOL, now: () => 1, fetchImpl: odd.fetchImpl }).facts();
    expect(odd.asked.map((one) => one.url)).toEqual([`${SAPLING_API}/params`]);
  });

  it("the token's page shows the coin's facts and no price: its address with a copy button and a link, its chain, what it trades against, and where it was planted", () => {
    const markup = drawnWith({ ...BASE, tokenAddress: MINT, reserveAddress: POOL }, () => createElement(TokenSection, { ownPage: true }));
    const words = wordsOf(markup);
    expect(words).toContain("The $SAPDEX coin");
    expect(words).toMatch(/Address .*Copy/);
    expect(words).toContain("Chain Solana");
    expect(words).toContain("Trades against ZEC");
    expect(words).toContain("Planted on Sapling");
    expect(markup).toContain(`href="https://solscan.io/token/${MINT}"`);
    expect(markup).toContain(`href="https://sapling.cash/coin/${MINT}"`);
    // The whole address is on the page, letter for letter.
    expect(markup.replace(/<[^>]+>/g, "")).toContain(MINT);
    // No price, no market value, no chart, and nothing that promises money.
    expect(words).not.toMatch(/\$\d|price|market cap|mcap|chart|volume|holders|\bATH\b|up \d|down \d|\bearn|\byield|\bAPR\b|\breturns\b|guarantee/i);
    expect(markup).not.toMatch(/<canvas|<svg[^>]*class="chart|<img/);
    // With no coin set there is no section at all.
    expect(drawnWith(BASE, () => createElement(TokenSection, { ownPage: true }))).toBe("");
  });

  it("how the coin feeds the pool is said only from what the server read: nothing of it is drawn before the answer, and the page itself never asks Sapling", () => {
    // As first drawn, before the site's own server has answered: the facts, and no sentence about the fee or the pool.
    const words = wordsOf(drawnWith({ ...BASE, tokenAddress: MINT, reserveAddress: POOL }, () => createElement(TokenSection, { ownPage: true })));
    expect(words).not.toMatch(/2\.00%|0\.80%|of every trade|the pool's wallet/);
    const home = read("web", "src", "components", "Home.tsx");
    // The figures are the answer's own, written out by the page: none is typed into it.
    const section = home.slice(home.indexOf("export function TokenSection"), home.indexOf("function Outbound("));
    expect(section).not.toMatch(/\d\.\d\d ?%|\d+ ?%/);
    expect(section).toMatch(/percentOf\(fee\.totalBps\)/);
    expect(home).toMatch(/facts\?\.feedsPool === true \? <> For this coin that is the pool's wallet/);
    // It is asked of this site's own address, and of no other.
    expect(read("web", "src", "api.ts")).toMatch(/tokenFacts: \(\) => send<TokenFacts>\("GET", "\/api\/token"/);
    for (const file of sources(root, /\.tsx?$/)) expect(read(file), name(file)).not.toMatch(/api\.sapling\.cash/);
    // The words are the site's own: none of Sapling's vocabulary but the plain fact that the coin was planted.
    expect(section).not.toMatch(/\b(roots?|seed(ling)?s?|orchard|harvest|grove|grow(s|n|ing)?|bloom|sprout)\b/i);
  });
});

describe("no page asks any other address for anything", () => {
  it("the policy every page is served with names this site alone: for scripts, styles, pictures, fonts and every request a page can make", () => {
    const policy = securityHeaders({ scriptHashes: [] })["Content-Security-Policy"] ?? "";
    const rules = Object.fromEntries(policy.split("; ").map((rule) => [rule.split(" ")[0], rule.split(" ").slice(1).join(" ")]));
    expect(rules).toEqual({
      "default-src": "'none'",
      "script-src": "'self'",
      "style-src": "'self' 'unsafe-inline'",
      "img-src": "'self' data:",
      "font-src": "'self'",
      "connect-src": "'self'",
      "frame-src": "'none'",
      "worker-src": "'none'",
      "manifest-src": "'self'",
      "base-uri": "'none'",
      "form-action": "'none'",
      "frame-ancestors": "'none'",
      "object-src": "'none'",
    });
    // No address of any other site is in it, for anything: not a font, not Sapling, not a chain, not a wallet service.
    expect(policy).not.toMatch(/https?:|wss?:|\*/);
  });

  it("the policy is the same on every route: the pages, the data routes and what is not found", () => {
    const http = read("server", "http.ts");
    // One function makes the headers, with nothing in it that depends on the address asked for.
    expect(http.match(/"Content-Security-Policy"/g)).toHaveLength(1);
    const made = http.slice(http.indexOf("export function securityHeaders"), http.indexOf("export function sendJson")).replace(/\/\/[^\n]*/g, "");
    expect(made).not.toMatch(/pathname|route|url\b|req\b/);
    // Nothing else in the server writes that header, or adds an address to it.
    for (const file of sources(path.resolve("server"), /\.ts$/).filter((one) => !one.endsWith("http.ts"))) expect(read(file).replace(/\/\*[\s\S]*?\*\//g, ""), name(file)).not.toMatch(/Content-Security-Policy|connect-src|font-src|img-src/);
  });

  it("the page itself, and every file it is built from, fetches from this site only", () => {
    const page = read("web", "index.html");
    // Nothing in the page's head or body is at another address: no font, script, stylesheet or picture.
    for (const match of page.matchAll(/(?:href|src|content|action)="([a-z][a-z0-9+.-]*:)?\/\/[^"]*"/gi)) expect(match[0]).toBe("");
    expect(page).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr|cdnjs/i);
    for (const file of sources(root, /\.(tsx?|css)$/)) {
      const text = read(file);
      // No request is ever made to an address written out in full: every one is a path of this site.
      for (const call of text.matchAll(/\b(?:fetch|EventSource|WebSocket|sendBeacon|importScripts)\(\s*[`"']([^`"']*)/g)) expect(call[1]!.startsWith("/") || call[1] === "", `${name(file)}: ${call[0]}`).toBe(true);
      expect(text, name(file)).not.toMatch(/new WebSocket|new EventSource|navigator\.sendBeacon|XMLHttpRequest|<iframe|<script\b[^>]*src=/);
      // A stylesheet fetches only what is beside it, its own fonts and pictures, and the site's own emblem.
      if (file.endsWith(".css")) for (const url of text.matchAll(/url\(\s*["']?([^"')]+)/g)) expect(url[1]!.startsWith("../assets/") || url[1]!.startsWith("data:") || url[1] === "/brand/emblem.svg", `${name(file)}: ${url[1]}`).toBe(true);
      expect(text, name(file)).not.toMatch(/@import\s+(?:url\()?["']https?:/);
    }
    // The fonts are the site's own files, named by the page so that they come with it.
    const preloads = [...page.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(preloads).toEqual(["/src/assets/fonts/figtree-latin.woff2", "/src/assets/fonts/instrument-serif-italic-latin.woff2", "/src/assets/fonts/dm-mono-latin-400.woff2"]);
    for (const font of preloads) expect(fs.existsSync(path.resolve("web", font!.slice(1)))).toBe(true);
  });

  it("the addresses of other sites that the pages do hold are links a person may follow, and no more: explorers, the coin's page on Sapling, and what the operator set", () => {
    const allowed = /^https:\/\/(?:sapling\.cash\/coin\/\$\{mint\}|github\.com\/example|x\.com\/example|basescan\.org\/tx\/|example\.org|db-ip\.com$)/;
    for (const file of sources(root, /\.tsx?$/).filter((one) => !one.endsWith("StatesPage.tsx"))) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1");
      for (const match of code.matchAll(/https?:\/\/[^\s"'`<>)]+/g)) expect(allowed.test(match[0]), `${name(file)}: ${match[0]}`).toBe(true);
    }
  });
});

describe("the pool is what its wallet holds in ZEC on Solana, and nothing is made up when Solana cannot be read", () => {
  const pool = async (h: Awaited<ReturnType<typeof harness>>) => (await h.get("/api/rewards")).body.pool as { address: string; amount: string | null; decimals: number; usdMicro: string | null; readAt: string | null } | null;

  it("with no pool wallet set there is no pool at all", async () => {
    const h = await harness();
    try {
      expect(await pool(h)).toBeNull();
      expect(h.rpc.solCalls).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("shows the wallet's ZEC, added up over its accounts, and no other coin it holds", async () => {
    const h = await harness({ env: { RESERVE_ADDRESS: POOL } });
    try {
      h.rpc.solHeld.set(`${ZEC_MINT}:${POOL}`, [150_000_000n, 25_000_000n]);
      // Another coin in the same wallet, in a far larger amount: no part of the pool.
      h.rpc.solHeld.set(`${MINT}:${POOL}`, [999_999_999_999n]);
      expect(await pool(h)).toMatchObject({ address: POOL, amount: "175000000", decimals: 8 });
      // Solana was asked about that wallet and that mint, of blocks that cannot be undone, and about nothing else.
      const asked = h.rpc.solCalls.filter((call) => call.method === "getTokenAccountsByOwner");
      expect(asked.length).toBeGreaterThan(0);
      for (const call of asked) expect(call.params).toEqual([POOL, { mint: ZEC_MINT }, { encoding: "jsonParsed", commitment: "finalized" }]);
      // The answer names no address but the wallet's own.
      expect(JSON.stringify((await h.get("/api/rewards")).body).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)?.filter((found) => found !== POOL) ?? []).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("a wallet with no ZEC account holds none: the pool is nothing, not unknown", async () => {
    const h = await harness({ env: { RESERVE_ADDRESS: POOL } });
    try {
      expect(await pool(h)).toMatchObject({ amount: "0", decimals: 8 });
    } finally {
      await h.close();
    }
  });

  it("before any read has worked there is no figure: not nought, not a guess", async () => {
    const h = await harness({ env: { RESERVE_ADDRESS: POOL } });
    try {
      h.rpc.solDown = true;
      expect(await pool(h)).toEqual({ address: POOL, amount: null, decimals: 8, usdMicro: null, readAt: null });
    } finally {
      await h.close();
    }
  });

  it("an answer that is not plainly that wallet's accounts of that coin is not believed", async () => {
    const h = await harness({ env: { RESERVE_ADDRESS: POOL } });
    try {
      h.rpc.solHeld.set(`${ZEC_MINT}:${POOL}`, [500_000_000n]);
      // The node answers with accounts of another coin.
      h.rpc.solWrongMint = MINT;
      expect((await pool(h))?.amount).toBeNull();
      // Or says the coin has other decimals than the eight it is known to have.
      h.rpc.solWrongMint = null;
      h.rpc.solDecimals.set(ZEC_MINT, 6);
      h.clock.t += 61_000;
      expect((await pool(h))?.amount).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("when Solana goes away the last good figure stands, with the time it was read, for ten minutes; after that there is none", async () => {
    const h = await harness({ env: { RESERVE_ADDRESS: POOL } });
    try {
      h.rpc.solHeld.set(`${ZEC_MINT}:${POOL}`, [200_000_000n]);
      const read = await pool(h);
      expect(read).toMatchObject({ amount: "200000000" });
      h.rpc.solDown = true;
      // Five minutes on, and still not readable: the figure is the one that was read, and says when.
      h.clock.t += 5 * 60_000;
      expect(await pool(h)).toEqual(read);
      // Eleven minutes after the read: it is no longer said to be the pool.
      h.clock.t += 6 * 60_000;
      expect(await pool(h)).toEqual({ address: POOL, amount: null, decimals: 8, usdMicro: null, readAt: null });
      // It never turns into another number meanwhile, and comes back as soon as Solana does.
      h.rpc.solDown = false;
      h.rpc.solHeld.set(`${ZEC_MINT}:${POOL}`, [210_000_000n]);
      h.clock.t += 61_000;
      expect(await pool(h)).toMatchObject({ amount: "210000000" });
    } finally {
      await h.close();
    }
  });

  it("the page says so in plain words, and draws no figure in its place", () => {
    const page = read("web", "src", "pages", "RewardsPage.tsx");
    expect(page).toContain("The pool cannot be read right now. Its wallet is linked below, and can be checked on Solana itself.");
    // Where there is no amount the figure's place holds that sentence: no nought, no dash, no last-known number.
    expect(page).toMatch(/pool !== null && pool\.amount === null \? \(\s*<p className="muted">The pool cannot be read right now\./);
    const home = read("web", "src", "components", "Home.tsx");
    // On the home page the pool's number is simply absent.
    expect(home).toMatch(/pool !== null && pool\.amount !== null \? \(\s*<Figure label="Pool this week"/);
  });
});
