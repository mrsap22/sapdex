import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { explorerAddressUrl, EXPLORER_HOSTS } from "../shared/chains.ts";
import { DOC_SLUGS, docSlugs, GHOST_DOC_SLUG, isDocSlug, PRIVATE_DOC_SLUG } from "../shared/pages.ts";
import { DOC_PAGES, docExists, docHref, docPages, GAS_DOC, headingId, headingInView, neighbours, PRIVATE_DOC } from "../web/src/lib/docs-logic.ts";
import { chainsOnList, features, isPrivateMode, listCounts, PRIVATE_MEANS, socialLinks } from "../web/src/lib/site-logic.ts";
import { findOrder, readTrackInput, TRACK_WORDS, type TrackOutcome } from "../web/src/lib/track-logic.ts";
import { matchRoute, NAV, navFor, navItems } from "../web/src/router.ts";

const ID = "oVWFWOKqE4uReqBK1gTFrZDSwnk";
const EVM = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
const SOL = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";

describe("what was pasted into Track order", () => {
  it("takes an order's link, in any form, as its ID", () => {
    for (const link of [`https://saplingdex.example/order/${ID}`, `http://localhost:8799/order/${ID}`, `/order/${ID}`, `  saplingdex.example/order/${ID}  `, `https://saplingdex.example/order/${ID}?x=1`, `https://saplingdex.example/order/${ID}#top`]) {
      expect(readTrackInput(link), link).toEqual({ id: ID, address: null });
    }
  });

  it("takes an address as an address, and text that could be either as both", () => {
    expect(readTrackInput(EVM)).toEqual({ id: null, address: EVM });
    expect(readTrackInput(` ${SOL}\n`)).toEqual({ id: null, address: SOL });
    // 27 letters and digits: an order ID, or a short Bitcoin address. Both are tried.
    expect(readTrackInput(ID)).toEqual({ id: ID, address: ID });
    // A Stellar address with its memo-less form, a Cardano address: long, still an address.
    expect(readTrackInput("GAQMXQJ2UFA5ECB2JJ3GUYQF46ROPVINVWAMN7KNR3OAMDHLQ46LFRBW").address).not.toBeNull();
    expect(readTrackInput(`addr1${"q".repeat(98)}`).address).not.toBeNull();
    // Every character the server accepts in a deposit address from the provider is accepted here too.
    expect(readTrackInput("EQDrjaLahLkMB+hMCmkzOyBuHJ139ZUYmPHu6RRBKnbdLIYI/a==").address).toBe("EQDrjaLahLkMB+hMCmkzOyBuHJ139ZUYmPHu6RRBKnbdLIYI/a==");
  });

  it("takes nothing else", () => {
    for (const bad of ["", "   ", "hello", "0x1234", "<script>alert(1)</script>", "x".repeat(400), `${EVM} ${EVM}`, "https://example.org/", `https://example.org/order/short`, `${ID}/../x`, "www.example.org/some/long/path", "/etc/passwd/and/more/of/it", "ftp://files.example.org/x"]) {
      expect(readTrackInput(bad), bad).toEqual({ id: null, address: null });
    }
  });
});

describe("looking for the order", () => {
  const found = (id: string): TrackOutcome => ({ kind: "found", id });
  const calls = (answers: { byId?: TrackOutcome; byAddress?: TrackOutcome }) => {
    const asked: string[] = [];
    return {
      asked,
      lookUp: {
        byId: (id: string) => {
          asked.push(`id:${id}`);
          return Promise.resolve(answers.byId ?? { kind: "none" as const });
        },
        byAddress: (address: string) => {
          asked.push(`address:${address}`);
          return Promise.resolve(answers.byAddress ?? { kind: "none" as const });
        },
      },
    };
  };

  it("asks nothing when there is nothing to ask about", async () => {
    const c = calls({});
    expect(await findOrder({ id: null, address: null }, c.lookUp)).toEqual({ kind: "none" });
    expect(c.asked).toEqual([]);
  });

  it("asks once for a link or an address", async () => {
    const byId = calls({ byId: found(ID) });
    expect(await findOrder({ id: ID, address: null }, byId.lookUp)).toEqual(found(ID));
    expect(byId.asked).toEqual([`id:${ID}`]);
    const byAddress = calls({ byAddress: found(ID) });
    expect(await findOrder({ id: null, address: EVM }, byAddress.lookUp)).toEqual(found(ID));
    expect(byAddress.asked).toEqual([`address:${EVM}`]);
  });

  it("tries text that could be either as an ID first, then as an address, and stops at the first answer that is not a plain miss", async () => {
    const both = calls({ byAddress: found("B".repeat(27)) });
    expect(await findOrder({ id: ID, address: ID }, both.lookUp)).toEqual(found("B".repeat(27)));
    expect(both.asked).toEqual([`id:${ID}`, `address:${ID}`]);
    const first = calls({ byId: found(ID) });
    await findOrder({ id: ID, address: ID }, first.lookUp);
    expect(first.asked).toEqual([`id:${ID}`]);
    // Told to wait, or offline: no second question.
    for (const kind of ["wait", "offline"] as const) {
      const stopped = calls({ byId: { kind } });
      expect(await findOrder({ id: ID, address: ID }, stopped.lookUp)).toEqual({ kind });
      expect(stopped.asked).toEqual([`id:${ID}`]);
    }
    const neither = calls({});
    expect(await findOrder({ id: ID, address: ID }, neither.lookUp)).toEqual({ kind: "none" });
  });
});

describe("what a miss says", () => {
  it("is one sentence for every kind of miss, and never says which kind", () => {
    expect(Object.keys(TRACK_WORDS).sort()).toEqual(["none", "offline", "wait"]);
    expect(TRACK_WORDS.none).not.toMatch(/\baddress\b|\border ID\b|\blink\b/i);
  });
});

describe("the header's pages", () => {
  it("are Swap, Track order, Stats and Docs, in that order, and without Stats where that page is switched off", () => {
    expect(NAV.map((item) => `${item.label} ${item.href}`)).toEqual(["Swap /", "Track order /track", "Stats /stats", "Docs /docs"]);
    expect(navItems(true)).toEqual(NAV);
    expect(navItems(false).map((item) => `${item.label} ${item.href}`)).toEqual(["Swap /", "Track order /track", "Docs /docs"]);
    for (const item of NAV) expect(matchRoute(item.href).page, item.href).not.toBe("not-found");
    expect(matchRoute("/track")).toEqual({ page: "track" });
    expect(matchRoute("/docs")).toEqual({ page: "docs", slug: null });
    for (const near of ["/track/", "/docs/", "/docs/nothing", "/docs/fees/", "/docs/Fees", "/rewards", "/Track", "/track?x", "/docs.html", "/docs/ghost", "/docs/ghost-", "/docs/-mode", "/docs/ghost--mode", "/docs/ghost-mode/", "/docs/Ghost-mode", "/docs/ghost_mode"]) expect(matchRoute(near).page, near).toBe("not-found");
  });

  it("the documentation is one page to a subject, each at its own address, all under Docs", () => {
    // (Two of them, the page on private routing and the page on Add gas, are pages only where swaps are routed privately. The next test holds that.)
    // The page on Ghost mode is a page everywhere: its address is two words joined by a hyphen, and the router reads it as one page.
    expect([...DOC_SLUGS]).toEqual(["fees", "chains", "refunds", "safety", "private", "ghost-mode", "add-gas", "faq"]);
    expect(GHOST_DOC_SLUG).toBe("ghost-mode");
    expect(matchRoute("/docs/ghost-mode")).toEqual({ page: "docs", slug: "ghost-mode" });
    for (const slug of DOC_SLUGS) {
      expect(matchRoute(`/docs/${slug}`)).toEqual({ page: "docs", slug });
      expect(navFor(`/docs/${slug}`)).toBe("/docs");
    }
    // Where swaps are routed in public, the contents are every page but those two, and the Terms and the Privacy Policy after them; nothing else.
    expect(DOC_PAGES.map((page) => page.href)).toEqual(["/docs", "/docs/fees", "/docs/chains", "/docs/refunds", "/docs/safety", "/docs/ghost-mode", "/docs/faq", "/terms", "/privacy"]);
    expect(DOC_PAGES.find((page) => page.href === "/docs/ghost-mode")).toEqual({ href: "/docs/ghost-mode", title: "Ghost mode", group: "Guide" });
    expect(DOC_PAGES.map((page) => page.href)).toEqual(["/docs", ...docSlugs(false).map((slug) => `/docs/${slug}`), "/terms", "/privacy"]);
    for (const page of DOC_PAGES) expect(matchRoute(page.href).page, page.href).not.toBe("not-found");
    // Previous and next follow the contents, and stop at either end.
    expect(neighbours("/docs")).toMatchObject({ previous: null, next: { href: "/docs/fees" } });
    expect(neighbours("/docs/faq")).toMatchObject({ previous: { href: "/docs/ghost-mode" }, next: { href: "/terms" } });
    expect(neighbours("/privacy")).toMatchObject({ previous: { href: "/terms" }, next: null });
    expect(neighbours("/nowhere")).toEqual({ previous: null, next: null });
  });

  it("the page on private routing is one of them only where swaps are routed privately", () => {
    expect(PRIVATE_DOC_SLUG).toBe("private");
    expect(isDocSlug(PRIVATE_DOC_SLUG)).toBe(true);
    expect(PRIVATE_DOC).toEqual({ href: "/docs/private", title: "Private routing", group: "Guide" });
    expect(docHref(PRIVATE_DOC_SLUG)).toBe(PRIVATE_DOC.href);

    // Routed in public: its address is not among the documentation's, it is not in the contents, and no page leads to it.
    expect([...docSlugs(false)]).toEqual(["fees", "chains", "refunds", "safety", "ghost-mode", "faq"]);
    expect(docPages(false)).toBe(DOC_PAGES);
    expect(DOC_PAGES.some((page) => page.href === PRIVATE_DOC.href || /private/i.test(page.title))).toBe(false);
    expect(neighbours("/docs/safety", docPages(false))).toMatchObject({ previous: { href: "/docs/refunds" }, next: { href: "/docs/ghost-mode" } });
    expect(neighbours("/docs/ghost-mode", docPages(false))).toMatchObject({ previous: { href: "/docs/safety" }, next: { href: "/docs/faq" } });
    expect(neighbours("/docs/faq", docPages(false))).toMatchObject({ previous: { href: "/docs/ghost-mode" }, next: { href: "/terms" } });
    expect(neighbours(PRIVATE_DOC.href, docPages(false))).toEqual({ previous: null, next: null });
    expect(docExists(PRIVATE_DOC_SLUG, false)).toBe(false);
    // Whatever asks without saying how swaps are routed is given the public answer, so the page cannot be listed by oversight.
    expect(neighbours("/docs/safety")).toEqual(neighbours("/docs/safety", docPages(false)));
    expect(neighbours(PRIVATE_DOC.href)).toEqual({ previous: null, next: null });

    // Routed privately: it follows "Staying safe", in the contents and in previous and next, and everything else keeps its place.
    // (The page on Add gas, the other page that exists only there, follows "Ghost mode"; test/gas-words.test.ts holds it.)
    expect([...docSlugs(true)]).toEqual([...DOC_SLUGS]);
    expect(docPages(true).map((page) => page.href)).toEqual(["/docs", "/docs/fees", "/docs/chains", "/docs/refunds", "/docs/safety", "/docs/private", "/docs/ghost-mode", "/docs/add-gas", "/docs/faq", "/terms", "/privacy"]);
    expect(docPages(true).map((page) => page.href)).toEqual(["/docs", ...docSlugs(true).map((slug) => `/docs/${slug}`), "/terms", "/privacy"]);
    expect(docPages(true).filter((page) => page.href !== PRIVATE_DOC.href && page.href !== GAS_DOC.href)).toEqual([...DOC_PAGES]);
    expect(neighbours("/docs/safety", docPages(true))).toMatchObject({ previous: { href: "/docs/refunds" }, next: { href: "/docs/private" } });
    expect(neighbours("/docs/private", docPages(true))).toMatchObject({ previous: { href: "/docs/safety" }, next: { href: "/docs/ghost-mode" } });
    expect(neighbours("/docs/ghost-mode", docPages(true))).toMatchObject({ previous: { href: "/docs/private" }, next: { href: "/docs/add-gas" } });
    expect(neighbours("/docs/faq", docPages(true))).toMatchObject({ previous: { href: "/docs/add-gas" }, next: { href: "/terms" } });
    expect(docExists(PRIVATE_DOC_SLUG, true)).toBe(true);

    // Every other page exists either way.
    for (const slug of [null, ...docSlugs(false)]) for (const privateRouting of [false, true]) expect(docExists(slug, privateRouting), String(slug)).toBe(true);
  });

  it("the site's own router shows that page only where it exists, and the ordinary 'Page not found.' anywhere else", () => {
    const app = fs.readFileSync(path.resolve("web", "src", "App.tsx"), "utf8");
    // The address is matched like any page of the documentation; whether it is a page is then asked of the server's settings.
    expect(matchRoute("/docs/private")).toEqual({ page: "docs", slug: "private" });
    expect(app).toMatch(/const privateOn = useApp\(\(state\) => isPrivateMode\(state\.config\)\);/);
    expect(app).toMatch(/const route: Route = matched\.page === "docs" && !docExists\(matched\.slug, privateOn\) && boot !== "loading" \? \{ page: "not-found" \} : matched;/);
    // Until the settings have arrived it is not known, and neither the page nor "not found" is shown.
    expect(app).toMatch(/\} else if \(route\.page === "docs" && !docExists\(route\.slug, privateOn\)\) \{\s*\/\/[^\n]*\n\s*page = <p className="muted">Loading…<\/p>;/);
    // That question is asked before the documentation's pages are drawn.
    expect(app.indexOf('route.page === "docs" && !docExists(route.slug, privateOn)')).toBeLessThan(app.indexOf("<DocsPage slug={route.slug} />"));
    expect(app.indexOf('route.page === "docs" && !docExists(route.slug, privateOn)')).toBeGreaterThan(-1);
  });

  it("gives each heading an address of its own, and knows which one is being read", () => {
    expect(headingId("3. How a swap works")).toBe("how-a-swap-works");
    expect(headingId("What may be lost")).toBe("what-may-be-lost");
    expect(headingId("11. Governing law")).toBe("governing-law");
    expect(headingId("???")).toBe("section");
    // The last heading to have passed the line under the header; the first until any has; the last at the very end of the page.
    expect(headingInView([300, 900, 1500], 120, false)).toBe(0);
    expect(headingInView([-400, 100, 700], 120, false)).toBe(1);
    expect(headingInView([-900, -300, 119], 120, false)).toBe(2);
    expect(headingInView([-900, -300, 400], 120, true)).toBe(2);
    expect(headingInView([], 120, false)).toBe(-1);
  });

  it("mark the page you are on, and an order's own page as part of Track order", () => {
    expect(navFor("/")).toBe("/");
    expect(navFor("/track")).toBe("/track");
    expect(navFor(`/order/${"A".repeat(27)}`)).toBe("/track");
    expect(navFor("/docs")).toBe("/docs");
    expect(navFor("/stats")).toBe("/stats");
    for (const outside of ["/terms", "/privacy", "/nowhere", "/rewards", "/states"]) expect(navFor(outside), outside).toBeNull();
  });
});

describe("the right of the header: the icon links, the theme, Ghost mode", () => {
  const read = (file: string) => fs.readFileSync(path.resolve("web", "src", file), "utf8");
  /** One function of a component file, from its declaration to the next one at the same depth. */
  const part = (source: string, start: string) => {
    const from = source.indexOf(start);
    if (from === -1) throw new Error(`"${start}" is not in the file`);
    const next = source.slice(from + start.length).search(/\n(?:export )?(?:function|const) /);
    return next === -1 ? source.slice(from) : source.slice(from, from + start.length + next);
  };
  const shell = read("components/Shell.tsx");
  const social = read("components/Social.tsx");

  it("are GitHub and X, in that order, each with its own name read aloud", () => {
    expect(socialLinks({ githubUrl: "https://github.com/example", xUrl: "https://x.com/example" }).map((link) => `${link.key}: ${link.label}`)).toEqual(["github: SaplingDex on GitHub", "x: SaplingDex on X"]);
  });

  it("an icon whose address is set leads there; one whose address is not set is not there at all", () => {
    const all = { githubUrl: "https://github.com/example", xUrl: "https://x.com/example" };
    expect(socialLinks(all).map((link) => link.href)).toEqual(["https://github.com/example", "https://x.com/example"]);
    expect(socialLinks({ ...all, githubUrl: null }).map((link) => link.href)).toEqual(["https://x.com/example"]);
    expect(socialLinks({})).toEqual([]);
    expect(socialLinks(null)).toEqual([]);
    // Whatever the server were to send, only an https link is ever put behind an icon.
    for (const bad of ["http://x.com/example", "javascript:alert(1)", "//x.com/example", "https://x.com/a b", 'https://x.com/"onmouseover="', "", "x.com/example"]) expect(socialLinks({ xUrl: bad }), bad).toEqual([]);
  });

  it("a set icon opens in a new tab and tells the other site nothing; with none set there is no row", () => {
    const links = part(social, "export function SocialLinks");
    // It is drawn as every link out of the site is, by the one component that draws them: a new tab, no hold on this window, no referrer.
    expect(links).toMatch(/<OutboundLink className="social-link" href=\{link\.href\} aria-label=\{link\.label\}/);
    expect(read("components/OutboundLink.tsx")).toMatch(/<a \{\.\.\.rest\} href=\{href\} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"/);
    // Nothing is drawn for an address that is not set: no icon that leads nowhere, and no empty row.
    expect(links).toMatch(/if \(links\.length === 0\) return null;/);
    expect(links).not.toMatch(/aria-disabled|<a /);
    expect(social).not.toMatch(/href="#"|javascript:/);
    // Every mark is drawn in the colour of the text around it, by the page itself: nothing is fetched for it.
    expect(social).not.toMatch(/<img|https?:\/\/|url\(/);
    expect(social.match(/fill="currentColor"/g)).toHaveLength(2);
  });

  it("the header has no clock, no status dot and nothing to connect: the icons, the theme and Ghost mode stand there", () => {
    const header = part(shell, "export function Header");
    expect(header).toMatch(/<SocialLinks where="header" \/>[\s\S]*<ThemeToggle \/>[\s\S]*<GhostDock \/>/);
    // The site connects to no wallet: the header has no button for one, and marks nothing on the page about one.
    expect(shell).not.toMatch(/WalletButton|data-wallet|dataset\.wallet|stores\/wallet|>\s*Connect\b/);
    expect(header).not.toMatch(/Recent|History|StatusDot|ServiceStatus|className="status/);
    expect(shell).not.toMatch(/RecentButton|StatusDot|from "lucide-react";[\s\S]*\bHistory\b/);
    expect(shell.split("\n").find((line) => line.includes('from "lucide-react"'))).not.toMatch(/History|Clock/);
  });

  it("the icons are in the footer too, and in the phone's menu; the footer has no status line and no dot", () => {
    const footer = part(shell, "export function Footer");
    expect(footer).toMatch(/<SocialLinks where="footer" \/>/);
    expect(read("components/MenuSheet.tsx")).toMatch(/<SocialLinks where="menu" \/>/);
    // The footer has no status line ("Service is running", with its dot), and neither has the header.
    expect(footer).not.toMatch(/ServiceStatus|status-dot|className="status|health/);
    expect(shell).not.toMatch(/ServiceStatus|HEALTH_WORDS|Service is running|status-dot/);
    expect(read("styles/shell.css")).not.toMatch(/\.status\b|\.status-dot/);
    const files = (fs.readdirSync(path.resolve("web", "src"), { recursive: true }) as string[]).filter((file) => /\.(tsx?|css)$/.test(file));
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) expect(fs.readFileSync(path.resolve("web", "src", file), "utf8"), file).not.toMatch(/Service is running/);
    // What a visitor must know is still said, at the top of the page: that swaps are paused, or that the service is slow.
    const banner = part(shell, "export function Banner");
    expect(banner).toMatch(/health === "paused" \? <p>\{BANNER_WORDS\.paused\}<\/p> : null/);
    expect(banner).toMatch(/health === "degraded" \? <p>\{BANNER_WORDS\.degraded\}<\/p> : null/);
  });

  it("the orders made in this browser are listed on the Track order page, with Clear history, and nowhere behind a button", () => {
    const track = read("pages/TrackPage.tsx");
    expect(track).toMatch(/orders\.length > 0 \? \(\s*<section className="track-recent"[\s\S]*<RecentList orders=\{orders\} onClear=\{clear\} onOpen=/);
    expect(read("components/RecentList.tsx")).toMatch(/<SecondaryButton onClick=\{onClear\}[^>]*>\s*Clear history/);
    expect(read("components/MenuSheet.tsx")).not.toMatch(/Recent orders|"recent"/);
    expect(read("stores/sheet.ts")).not.toMatch(/"recent"/);
    expect(fs.existsSync(path.resolve("web", "src", "components", "RecentSheet.tsx"))).toBe(false);
  });
});

describe("what the wider pages state as fact", () => {
  const list = [{ chain: "sol" }, { chain: "base" }, { chain: "btc" }, { chain: "base" }, { chain: "zzz" }, { chain: "bsc" }];

  it("counts coins and chains from the list, and gives no number for an empty list", () => {
    expect(listCounts(list)).toEqual({ coins: 6, chains: 5 });
    expect(listCounts([])).toBeNull();
  });

  it("lists the chains in the picker's order, each with its number of coins, unknown chains last", () => {
    expect(chainsOnList(list).map((chain) => `${chain.name} ${chain.coins}${chain.slow ? " slow" : ""}`)).toEqual(["Solana 1", "Base 2", "Bitcoin 1 slow", "BNB Chain 1", "ZZZ 1"]);
    expect(chainsOnList([])).toEqual([]);
    // The whole order: Solana, Ethereum, Base, Bitcoin, Zcash, Arbitrum, BNB Chain, Optimism, Polygon, Avalanche, Tron, TON, and then every other chain by name.
    const every = ["zec", "ton", "near", "avax", "eth", "tron", "pol", "op", "arb", "base", "btc", "sol", "bsc", "aptos", "doge", "xrp"].map((chain) => ({ chain }));
    expect(chainsOnList(every).map((chain) => chain.name)).toEqual(["Solana", "Ethereum", "Base", "Bitcoin", "Zcash", "Arbitrum", "BNB Chain", "Optimism", "Polygon", "Avalanche", "Tron", "TON", "Aptos", "Dogecoin", "NEAR", "XRP Ledger"]);
  });

  it("lists what the site does, each a working feature, with the coin among them only once its address is set", () => {
    expect(features(false).map((item) => item.title)).toEqual(["Swaps in and out of ZEC", "Order tracking and automatic refunds", "Ghost mode"]);
    expect(features(true).map((item) => item.title)).toEqual(["Swaps in and out of ZEC", "Order tracking and automatic refunds", "Ghost mode", "The $SAPDEX coin"]);
    for (const tokenSet of [false, true]) {
      for (const privateRouting of [false, true]) {
        for (const item of features(tokenSet, privateRouting)) {
          // Nothing on the list is a plan, and nothing said of it is a promise of money.
          expect(`${item.title} ${item.text} ${item.link.label}`, item.key).not.toMatch(/planned|soon|not yet|will be|launch|coming|\bearn|yield|profit|returns|guarantee|%/i);
          // Each leads to a page of this site. (Some of them to a page of the documentation: an address in two parts, the second of which may be two words joined by a hyphen.)
          expect(item.link.href, item.key).toMatch(/^\/[a-z]*(\/[a-z]+(-[a-z]+)?)?$/);
          expect(matchRoute(item.link.href).page, item.key).not.toBe("not-found");
        }
      }
    }
    // What is said of the coin: where its facts are shown. It leads to the coin's own page.
    expect(features(true).at(-1)).toEqual({ key: "token", title: "The $SAPDEX coin", text: "The coin's address, its chain, what it trades against and where it was planted are shown on this site.", link: { href: "/token", label: "The coin's facts" } });
    expect(features(false).some((item) => item.key === "token")).toBe(false);
  });

  it("where swaps are routed privately the first of them is private swaps in and out of ZEC; where they are not, nothing on the list speaks of private swaps", () => {
    // Routed in public, or asked without saying how swaps are routed: this list, word for word, and nothing of private swaps in it.
    const today = [
      { key: "swaps", title: "Swaps in and out of ZEC", text: "Pay with any coin on any chain and arrive on Solana with ZEC, the coin every Sapling coin trades in; or take ZEC out to any coin. Quotes, orders and delivery are powered by NEAR Intents, and every fee is shown before you confirm.", link: { href: "/docs", label: "How a swap works" } },
      { key: "tracking", title: "Order tracking and automatic refunds", text: "Every order has its own page, which follows the deposit, the swap and the delivery. If a swap fails, the provider sends your coins back to your refund address.", link: { href: "/track", label: "Track an order" } },
      // Ghost mode: what it does, in one sentence, and then the first thing it does not.
      { key: "ghost", title: "Ghost mode", text: "One switch in the header. While it is on, the site keeps nothing in your browser but the switch itself, and deletes your order's record once it is delivered or refunded. Your deposit and your delivery are still public on-chain.", link: { href: "/docs/ghost-mode", label: "How Ghost mode works" } },
    ];
    expect(features(false)).toEqual(today);
    expect(features(false, false)).toEqual(today);
    expect(features(true, false).slice(0, 3)).toEqual(today);
    for (const tokenSet of [false, true]) expect(JSON.stringify(features(tokenSet, false))).not.toMatch(/privat|confidential|\/docs\/private/i);

    // Routed privately: item 01 says what it is, in the provider's own terms and no stronger, and leads to the page that explains it.
    const [swaps, tracking, ghost, gas, token] = features(true, true);
    expect(swaps).toEqual({
      key: "swaps",
      title: "Private swaps, in and out of ZEC",
      text: "Pay with any coin on any chain and arrive on Solana with ZEC, the coin every Sapling coin trades in; or take ZEC out to any coin. Swaps are routed with NEAR Intents' confidential routing, so what you send and what you receive are not tied to each other in public records. Every fee is shown before you confirm.",
      link: { href: "/docs/private", label: "How private routing works" },
    });
    // Add gas, which is offered only beside a privately routed swap, is on the list only here, after Ghost mode (test/gas-words.test.ts holds its words).
    expect(features(false, true).map((item) => item.title)).toEqual(["Private swaps, in and out of ZEC", "Order tracking and automatic refunds", "Ghost mode", "Add gas"]);
    expect(features(true, true).map((item) => item.key)).toEqual(["swaps", "tracking", "ghost", "gas", "token"]);
    expect(gas?.title).toBe("Add gas");
    // Tracking, Ghost mode and the coin are the same either way.
    expect(tracking).toEqual(today[1]);
    expect(ghost).toEqual(today[2]);
    expect(token).toEqual(features(true, false)[3]);
  });

  it("says what private means in three rows, and claims no more than the provider does", () => {
    expect(PRIVATE_MEANS.map((row) => row.label)).toEqual(["Still public", "Not public", "Who can see it"]);
    const [still, not, who] = PRIVATE_MEANS.map((row) => row.text);
    // Both ends of a swap are public, and the row says which.
    expect(still).toBe("Your deposit on the chain you send from, its amount and the wallet it came from; the delivery on the chain you receive on.");
    // What is not public is the link between them, and it is said as "not tied to each other in public records": never that it cannot be matched.
    expect(not).toBe("The link between your deposit and your delivery. The swap is processed with NEAR Intents' confidential routing, so the two are not tied to each other in public records.");
    // Who can still see it, the holder of the order's link among them; that it is not anonymity; that hints remain; that the provider does not promise it complete.
    expect(who).toBe("The provider's confidential system, us for what is needed to run your order, and anyone who has the order's link: its page shows both ends. Private routing is not anonymity and no route guarantees it: amounts and timing can still give hints, and the provider does not promise complete confidentiality.");
    for (const row of PRIVATE_MEANS) {
      expect(row.text, row.label).not.toMatch(/can(?:not|'t| not) be (?:matched|traced|tracked|linked|seen|followed)|impossible|never be|no one can|nobody can|complete(?:ly)? (?:private|hidden)|fully/i);
      // One or two sentences, as plain rows are.
      expect(row.text.split(/(?<=[.])\s+/).length, row.label).toBeLessThanOrEqual(2);
    }
  });

  describe("how swaps are routed, as the page knows it", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("is what the server's settings say: private for \"basic\", and public for anything else or nothing", () => {
      expect(isPrivateMode({ privacyMode: "basic" })).toBe(true);
      expect(isPrivateMode({ privacyMode: "public" })).toBe(false);
      // An answer from a server that says nothing of routing, or says something unknown, reads as public.
      for (const other of [{}, { privacyMode: undefined }, { privacyMode: null }, { privacyMode: "" }, { privacyMode: "advanced" }, { privacyMode: "BASIC" }, { privacyMode: "private" }, { privacyMode: true }, { privacyMode: 1 }]) expect(isPrivateMode(other), JSON.stringify(other)).toBe(false);
    });

    it("until the settings arrive, is what the server marked on the page it served; once they have arrived, the settings alone", () => {
      // No settings and no page at all (as in these tests): public.
      expect(isPrivateMode(null)).toBe(false);
      expect(isPrivateMode(undefined)).toBe(false);
      // A page served where swaps are routed in public carries no mark.
      vi.stubGlobal("document", { documentElement: { dataset: {} } });
      expect(isPrivateMode(null)).toBe(false);
      vi.stubGlobal("document", { documentElement: { dataset: { routing: "public" } } });
      expect(isPrivateMode(null)).toBe(false);
      // A page served where they are routed privately is marked (server/static.ts), so its first words are the right ones from the start.
      vi.stubGlobal("document", { documentElement: { dataset: { routing: "private" } } });
      expect(isPrivateMode(null)).toBe(true);
      expect(isPrivateMode(undefined)).toBe(true);
      // The mark is a first reading only. The settings decide.
      expect(isPrivateMode({ privacyMode: "public" })).toBe(false);
      expect(isPrivateMode({})).toBe(false);
      expect(isPrivateMode({ privacyMode: "basic" })).toBe(true);
    });
  });

  it("links a token or a pair only to the chain's own explorer, and only for a real address", () => {
    const address = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
    expect(explorerAddressUrl("bsc", address, "token")).toBe(`https://bscscan.com/token/${address}`);
    expect(explorerAddressUrl("bsc", address)).toBe(`https://bscscan.com/address/${address}`);
    expect(explorerAddressUrl("base", address)).toBe(`https://basescan.org/address/${address}`);
    for (const chain of ["bsc", "eth", "base", "arb"]) expect(EXPLORER_HOSTS.has(new URL(explorerAddressUrl(chain, address) ?? "https://x.invalid").host), chain).toBe(true);
    for (const bad of ["0x1234", `${address}/../x`, `${address}?a=b`, "javascript:alert(1)", ""]) expect(explorerAddressUrl("bsc", bad), bad).toBeNull();
    for (const chain of ["sol", "btc", "nowhere"]) expect(explorerAddressUrl(chain, address), chain).toBeNull();
    // On Solana an address is an account and a coin is a token, on that chain's own explorer; the letters are kept exactly as they are.
    expect(explorerAddressUrl("sol", SOL)).toBe(`https://solscan.io/account/${SOL}`);
    expect(explorerAddressUrl("sol", SOL, "token")).toBe(`https://solscan.io/token/${SOL}`);
    expect(EXPLORER_HOSTS.has("solscan.io")).toBe(true);
    for (const bad of [SOL.slice(0, 31), `${SOL}0`, `${SOL}/../x`, `${SOL}?a=b`, SOL.replace("D", "O"), "javascript:alert(1)", ""]) expect(explorerAddressUrl("sol", bad), bad).toBeNull();
    // A Solana address is no address on a chain of the other kind, and none on a chain the site has no address page for.
    for (const chain of ["bsc", "base", "btc", "near", "nowhere"]) expect(explorerAddressUrl(chain, SOL), chain).toBeNull();
  });

  it("never uses, on these pages, the words ruled out for them", () => {
    // On these pages "dark" joins the list. (The theme's own label lives elsewhere.)
    // One word is not on it: "private". Where that word may be written, and that
    // it is shown only where swaps are routed privately, is held by test/wording.test.ts. One page of the documentation explains
    // how private routing differs from a mixer: in that section's title and in the sentence that says it is not one, and nowhere else,
    // the word stands.
    const pages = ["web/src/components/Home.tsx", "web/src/components/MenuSheet.tsx", "web/src/components/Faq.tsx", "web/src/pages/DocsPage.tsx", "web/src/pages/TrackPage.tsx", "web/src/lib/site-logic.ts", "web/src/lib/track-logic.ts"];
    const banned = /\b(anonymous|untraceable|dark|mixer|guaranteed?|earn|yield|apr|partner(ship)?)\b/i;
    const NOT_A_MIXER = /How it differs from a mixer(?:" id="mixer")?|Private routing is not a mixer\./g;
    const read = (file: string, line: string) => (file === "web/src/pages/DocsPage.tsx" ? line.replace(NOT_A_MIXER, "") : line);
    const hits = pages.flatMap((file) =>
      fs
        .readFileSync(path.resolve(file), "utf8")
        .split("\n")
        .flatMap((line, index) => (banned.test(read(file, line)) ? [`${file}:${index + 1}: ${line.trim().slice(0, 80)}`] : [])),
    );
    expect(hits).toEqual([]);
    // The exception is that narrow: the word in any other sentence, or those sentences on any other page, are still caught.
    expect(banned.test(read("web/src/pages/DocsPage.tsx", "Private routing works like a mixer."))).toBe(true);
    expect(banned.test(read("web/src/components/Home.tsx", "Private routing is not a mixer."))).toBe(true);
    expect(banned.test(read("web/src/pages/DocsPage.tsx", "Private routing is not a mixer."))).toBe(false);
  });
});

