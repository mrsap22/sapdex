import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BANNER_WORDS, PRACTICE_ORDER_LINE } from "../shared/banner.ts";
import { docSlugs, PRIVATE_DOC_SLUG } from "../shared/pages.ts";
import { HEADLINE_SUB, headlineWords, POSITIONING, shareImageAlt } from "../shared/positioning.ts";
import { Faq, questions } from "../web/src/components/Faq.tsx";
import { Headline, HomeSections } from "../web/src/components/Home.tsx";
import { features, PRIVATE_MEANS } from "../web/src/lib/site-logic.ts";
import DocsPage from "../web/src/pages/DocsPage.tsx";
import { PrivacyPage, TermsPage } from "../web/src/pages/LegalPages.tsx";
import TrackPage from "../web/src/pages/TrackPage.tsx";
import { useApp } from "../web/src/stores/app.ts";
import { NEVER } from "./words.ts";

// The site is finished. Nothing on it may say or imply
// that something is not ready, and practice mode is not shown as a feature of the site.

const root = path.resolve("web", "src");
const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(dir, entry.name)) : /\.(tsx?|html)$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
/** The files whose words can reach a visitor: every script and page of the site, the page it is served in, and the words the server shares with it. */
const FILES = [...sources(root), path.resolve("web", "index.html"), path.resolve("shared", "banner.ts"), path.resolve("shared", "positioning.ts")]
  // The page of component states is a tool for looking at parts of the site while building it. The live site answers its address with "not found".
  .filter((file) => !file.endsWith(path.join("pages", "StatesPage.tsx")));
const name = (file: string) => path.relative(path.resolve("."), file).split(path.sep).join("/");
/** A file's text without its comments: what is written for whoever reads the code is not shown to anyone. */
const shown = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1");

// ---- Private routing ----
// Three words the site otherwise never uses may each stand in one place, to say what private
// routing is not. They are written here as the exact sentences, so that nothing else slips through.
/** "Anonymity" stands only in the sentence that denies it. */
const NOT_ANONYMITY = /Private routing is not anonymity/g;
/** A promise is named only to say that there is none. */
const NO_PROMISE = /no route guarantees it/gi;
/** On the page of the documentation that explains private routing, in its section on the difference, and nowhere else. */
const NOT_A_MIXER = /How it differs from a mixer(?:" id="mixer")?|Private routing is not a mixer\./g;
const DOCS_PAGE = "web/src/pages/DocsPage.tsx";
/** The words that speak of private swaps. (Not "privacy": the Privacy Policy is about what is kept, and has always been there.) */
const PRIVATE_WORDS = /\b(?:private(?:ly)?|confidential(?:ity|ly)?)\b/i;

describe("nothing on the site says that something is not ready", () => {
  const NOT_YET = /coming soon|not yet|\bplanned\b|\bdraft\b|pending (legal )?review|starts when|does not exist yet|has not launched|not launched|launch(es|ing)? soon|when \$?SAPDEX launches|nothing is being recorded|nothing has been recorded|not ready|being built|not open yet|under construction|stay tuned|\bTBA\b|\bTBD\b|to be (announced|decided|determined)|\[placeholder|placeholder:|once one has been published|in the meantime|check back|watch this space|work in progress/i;

  it("finds the files", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.map(name)).toContain("web/src/pages/DocsPage.tsx");
    expect(FILES.map(name)).toContain("web/src/pages/LegalPages.tsx");
    expect(FILES.map(name)).toContain("web/index.html");
  });

  it.each(FILES.map((file) => [name(file), file] as const))("%s", (_name, file) => {
    const hits = shown(file)
      .split("\n")
      .flatMap((line, index) => (NOT_YET.test(line) ? [`${index + 1}: ${line.trim().slice(0, 100)}`] : []));
    expect(hits).toEqual([]);
  });

  it("is a check that can fail", () => {
    for (const sentence of ["Coming soon.", "The token does not exist yet.", "Draft, pending legal review.", "Stats: Planned", "The record starts when $SAPDEX launches.", "This page is not ready yet.", "[PLACEHOLDER: the governing law]"]) expect(NOT_YET.test(sentence), sentence).toBe(true);
    for (const sentence of ['placeholder="Solana address"', "<AddressFieldPlaceholder label=", "Sent. Waiting for it to be confirmed.", "Order tracking and automatic refunds"]) expect(NOT_YET.test(sentence), sentence).toBe(false);
  });

  it("lists what the site does without a tag of Live or of anything else", () => {
    for (const tokenSet of [false, true]) for (const item of features(tokenSet)) expect(Object.keys(item).sort()).toEqual(["key", "link", "text", "title"]);
    const stage = shown(path.join(root, "components", "Stage.tsx"));
    expect(stage).not.toMatch(/\b(Live|Paused|Soon|Beta|New)\b/);
    expect(stage).not.toMatch(/stage-tag|data-tag/);
  });

  it("the Terms and the Privacy Policy read as the site's terms: no label of being unfinished, and a version without one", () => {
    const legal = shown(path.join(root, "pages", "LegalPages.tsx"));
    expect(legal).not.toMatch(/draft|pending|placeholder|not legal advice yet/i);
    expect(fs.readFileSync(path.resolve("shared", "api.ts"), "utf8")).toMatch(/export const TERMS_VERSION = "\d{4}-\d{2}-\d{2}";/);
    // Every numbered section is there, in order, with none left out.
    for (const page of ["TermsPage", "PrivacyPage"]) {
      const body = legal.slice(legal.indexOf(`export function ${page}`));
      const end = body.indexOf("\nexport function ", 10);
      const numbers = [...(end === -1 ? body : body.slice(0, end)).matchAll(/<Section title="(\d+)\. /g)].map((match) => Number(match[1]));
      expect(numbers.length, page).toBeGreaterThanOrEqual(5);
      expect(numbers, page).toEqual(numbers.map((_, index) => index + 1));
    }
  });
});

describe("the site never reads the clipboard", () => {
  // The address fields have no Paste button:
  // an address reaches a field by being typed or pasted there by the person, or by their pressing
  // "Use connected wallet". Nothing on the site looks at the clipboard.
  it.each(sources(root).map((file) => [name(file), file] as const))("%s", (_name, file) => {
    const text = shown(file);
    expect(text).not.toMatch(/clipboard\s*\.\s*read|clipboardData|onPaste|addEventListener\(\s*["']paste/);
    expect(text).not.toMatch(/>\s*Paste\s*</);
  });

  it("is a check that can fail", () => {
    for (const sample of ["navigator.clipboard.readText()", "navigator.clipboard\n  .read()", "event.clipboardData", "<textarea onPaste={take} />", '>\n  Paste\n</button>']) expect(/clipboard\s*\.\s*read|clipboardData|onPaste|addEventListener\(\s*["']paste/.test(sample) || />\s*Paste\s*</.test(sample), sample).toBe(true);
    // Writing to the clipboard, which the Copy buttons do, is another matter.
    expect(/clipboard\s*\.\s*read|clipboardData|onPaste/.test("navigator.clipboard.writeText(text)")).toBe(false);
  });
});

describe("practice mode is not shown as a feature of the site", () => {
  it("has no banner, and one line by a practice order's deposit address", () => {
    expect(Object.keys(BANNER_WORDS).sort()).toEqual(["degraded", "paused"]);
    expect(PRACTICE_ORDER_LINE).toBe("Practice order. Do not send funds.");
    // The line is drawn by one component, beside the deposit address, and nowhere else.
    const users = FILES.filter((file) => /<PracticeLine \/>/.test(fs.readFileSync(file, "utf8"))).map(name).sort();
    expect(users).toEqual(["web/src/pages/OrderPage.tsx"]);
    for (const file of users) {
      const text = fs.readFileSync(path.resolve(file), "utf8");
      const at = text.indexOf("<PracticeLine />");
      expect(text.slice(Math.max(0, at - 400), at), file).toContain("Deposit address");
    }
  });

  it("says nothing else about practice anywhere a visitor could read it", () => {
    for (const file of FILES) {
      // The two files that hold the one line and the one component that draws it.
      if (name(file) === "shared/banner.ts" || name(file) === "web/src/components/PracticeLine.tsx") continue;
      const text = shown(file);
      // What is left is code: the setting's name, the control's route, the one component.
      const words = text.replace(/config\??\.practice|\.practice\b|practice:|practice &&|PracticeLine|PRACTICE_ORDER_LINE|order-practice|practice-line|api\.practice|\/api\/practice\/|const practice\b|\(practice\b|practice\)/g, "");
      expect(words, name(file)).not.toMatch(/\bpractice\b|\bpretend\b|sample order|test mode|\bdemo\b/i);
    }
  });
});

describe("nothing on the site promises money", () => {
  const WORDS_FILES = ["pages/DocsPage.tsx", "components/Faq.tsx", "pages/LegalPages.tsx", "lib/site-logic.ts", "components/Stage.tsx", "components/Home.tsx", "components/ReviewSheet.tsx", "components/QuotePanel.tsx", "pages/OrderPage.tsx", "pages/StatsPage.tsx"].map((file) => path.join(root, file));

  it("never a word that promises a gain, and none that would make anyone a party to the site", () => {
    const banned = /\b(earn(s|ed|ing)?|yield(s)?|returns|APR|APY|passive|profit(s)?|income|interest|invest(ment|ing)?|guarantee[sd]?|dividend(s)?|airdrop(s)?|free money|risk-free|partner(s|ed|ship)?|sponsor(s|ed|ship)?|backed by)\b/i;
    const hits = WORDS_FILES.flatMap((file) =>
      shown(file)
        // (A scroll listener's own setting is code, not a word on the page.)
        .replace(/\{ passive: true \}/g, "")
        // (Two of these files say what private routing is not: "no route guarantees it". That is said of
        // confidentiality, to deny a promise; any other use is still caught.)
        .replace(NO_PROMISE, "")
        .split("\n")
        .flatMap((line, index) => (banned.test(line) ? [`${name(file)}:${index + 1}: ${line.trim().slice(0, 60)}`] : [])),
    );
    expect(hits).toEqual([]);
    expect(banned.test("Private routing guarantees your delivery.".replace(NO_PROMISE, ""))).toBe(true);
    expect(banned.test("Private routing is not anonymity and no route guarantees it.".replace(NO_PROMISE, ""))).toBe(false);
    for (const sentence of ["NEAR is our partner.", "Swaps sponsored by Sapling.", "A site backed by Zcash.", "Earn as you swap.", "A 5% APR."]) expect(banned.test(sentence), sentence).toBe(true);
  });
});

describe("the words never used, of private routing or of anything else", () => {
  // Allowed: private, private swap, private routing, confidential routing. Never: anonymous,
  // untraceable, mixer, invisible, "hidden from authorities", guaranteed, and nothing that suggests
  // getting round the law or sanctions. Nor anything stronger than the provider itself says: its
  // Terms promise no complete confidentiality, so the site never says that a swap cannot be traced
  // or matched. Checked in every file the browser is sent and every file of words shared with it,
  // stylesheets and the page of component states included, whichever way swaps are routed.
  const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? all(path.join(dir, entry.name)) : /\.(tsx?|html|css)$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
  const SITE = [...all(root), ...all(path.resolve("shared")), path.resolve("web", "index.html")];
  /** What is read of a file: its words without its comments, and without the three sentences above where each may stand. */
  const read = (file: string, text: string) => {
    const kept = text.replace(NOT_ANONYMITY, "").replace(NO_PROMISE, "");
    return name(file) === DOCS_PAGE ? kept.replace(NOT_A_MIXER, "") : kept;
  };

  it("finds the files", () => {
    expect(SITE.length).toBeGreaterThan(70);
    for (const file of ["shared/positioning.ts", "shared/pages.ts", "shared/api.ts", "web/index.html", "web/src/pages/StatesPage.tsx", "web/src/styles/home.css", DOCS_PAGE]) expect(SITE.map(name)).toContain(file);
  });

  it.each(SITE.map((file) => [name(file), file] as const))("%s", (_name, file) => {
    const hits = read(file, shown(file))
      .split("\n")
      .flatMap((line, index) => (NEVER.test(line) ? [`${index + 1}: ${line.trim().slice(0, 100)}`] : []));
    expect(hits).toEqual([]);
  });

  it("is a check that can fail, and the three exceptions are as narrow as their sentences", () => {
    const docs = path.resolve(DOCS_PAGE);
    const home = path.resolve("web", "src", "components", "Home.tsx");
    for (const sentence of [
      "Anonymous swaps, across chains.",
      "Swap anonymously.",
      "Private routing gives you anonymity.",
      "An untraceable route.",
      "Works like a mixer.",
      "Invisible to everyone.",
      "Hidden from authorities.",
      "Guaranteed delivery.",
      "We guarantee it.",
      "Private routing guarantees that nobody can follow a swap.",
      "The two cannot be matched from public records.",
      "A swap that can't be traced.",
      "Nobody can see your swap.",
      "Completely private.",
      "Leaves no trace.",
      "A way to evade sanctions.",
      "Avoid the sanctions list.",
      "No KYC.",
      "No questions asked.",
    ])
      expect(NEVER.test(read(docs, sentence)), sentence).toBe(true);
    // The allowed words, and the sentences this site does say.
    for (const sentence of [
      "Private swaps, across chains. Built on NEAR Intents.",
      "A private swap",
      "How private routing works",
      "NEAR Intents' confidential routing",
      "the provider does not promise complete confidentiality",
      "Private routing is not anonymity and no route guarantees it: amounts and timing can still give hints.",
      "No route guarantees it, and the provider does not promise that confidentiality is complete or without interruption.",
      "It is not a way round screening.",
      "You must not use SaplingDex to conceal the proceeds of crime, or to get round sanctions or any law.",
      "You must not use a VPN or any other means to get around the block on these places.",
      "Blockchain transfers cannot be undone.",
      "Privacy Policy",
    ])
      expect(NEVER.test(read(docs, sentence)), sentence).toBe(false);
    // "Anonymity" and a promise stand only inside their own sentences.
    expect(NEVER.test(read(home, "Private routing is not anonymity."))).toBe(false);
    expect(NEVER.test(read(home, "Private routing is close to anonymity."))).toBe(true);
    expect(NEVER.test(read(home, "This route guarantees it."))).toBe(true);
    // The third stands on one page only, and only in those words.
    expect(NEVER.test(read(docs, "Private routing is not a mixer."))).toBe(false);
    expect(NEVER.test(read(docs, '<DocSection title="How it differs from a mixer" id="mixer">'))).toBe(false);
    expect(NEVER.test(read(home, "Private routing is not a mixer."))).toBe(true);
    expect(NEVER.test(read(docs, "Private routing is a better mixer."))).toBe(true);
  });

  it("each exception is used, and only by the files that say what private routing is not", () => {
    const using = (pattern: RegExp) => SITE.filter((file) => new RegExp(pattern.source, pattern.flags).test(shown(file))).map(name).sort();
    expect(using(NOT_ANONYMITY)).toEqual(["web/src/components/Faq.tsx", "web/src/lib/site-logic.ts", DOCS_PAGE, "web/src/pages/LegalPages.tsx"]);
    expect(using(NO_PROMISE)).toEqual(["web/src/lib/site-logic.ts", DOCS_PAGE]);
    expect(using(/\bmixers?\b/i)).toEqual([DOCS_PAGE]);
  });
});

/** The server's settings for a site with nothing else set: no token, no support contact, swaps on. */
const SETTINGS = { supportContact: null, tokenAddress: null, paused: false };
const ROUTED_PRIVATELY = { ...SETTINGS, privacyMode: "basic" };

/**
 * A page of the site as it is drawn with the given settings from the server (null: they have not
 * arrived). A page drawn here, outside a browser, reads the settings store's first state, so the
 * settings are put there for the length of one drawing and taken away again.
 */
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
/** The words of a drawn page, as they are read. */
const wordsOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const headline = () => createElement(Headline);
const home = () => createElement(HomeSections);
const faq = () => createElement(Faq);
const docs = (slug: Parameters<typeof DocsPage>[0]["slug"]) => () => createElement(DocsPage, { slug });
const terms = () => createElement(TermsPage);
const privacy = () => createElement(PrivacyPage);
const track = () => createElement(TrackPage);
/** Every page of the site whose words are written for both ways of routing: all but the swap card and an order's page, which have tests of their own. */
const PAGES: (readonly [string, () => ReactElement])[] = [["the headline", headline], ["the home page", home], ["the questions", faq], ["Track order", track], ["Docs, How it works", docs(null)], ...docSlugs(false).map((slug) => [`Docs, ${slug}`, docs(slug)] as const), ["the Terms", terms], ["the Privacy Policy", privacy]];
const PRIVATE_PAGE = ["Docs, private", docs(PRIVATE_DOC_SLUG)] as const;

/** The questions asked everywhere, in order. The one on Ghost mode follows the one on who can see a swap. */
const QUESTIONS = ["what-is-saplingdex", "cost", "time", "wallet", "failed", "wrong-amount", "exchange", "public", "ghost-mode", "find-order", "help"];

describe("private wording is shown only where swaps are routed privately", () => {
  // The rule: what the site says follows what the server
  // does. With swaps routed in public the site reads as it always has, and says nothing at all of
  // private swaps. One build holds both.

  describe("by file: whatever says the words first reads how swaps are routed", () => {
    /** The files that speak of private routing for the site as a whole, each with the place where it learns how this site routes swaps. */
    const BY_THE_SITE: Record<string, RegExp> = {
      // The two sets of first words, one to a way of routing.
      "shared/positioning.ts": /export const POSITIONING: Readonly<Record<SiteMode, Positioning>> = \{/,
      // The address of the page that explains it, which is among the documentation's only where swaps are routed privately.
      "shared/pages.ts": /export function docSlugs\(privateRouting: boolean\)/,
      "web/src/lib/docs-logic.ts": /export function docPages\(privateRouting: boolean\)/,
      "web/src/lib/site-logic.ts": /export function isPrivateMode\(config: \{ privacyMode\?: unknown \} \| null \| undefined\): boolean \{/,
      "web/src/components/Faq.tsx": /isPrivateMode\(state\.config\)/,
      "web/src/components/Home.tsx": /isPrivateMode\(state\.config\)/,
      [DOCS_PAGE]: /isPrivateMode\(state\.config\)/,
      "web/src/pages/LegalPages.tsx": /isPrivateMode\(state\.config\)/,
      // One sentence under the Track order page's title: a privately routed order is not found from its deposit address.
      "web/src/pages/TrackPage.tsx": /isPrivateMode\(state\.config\)/,
    };
    /** Where the two words for a routing are defined, as the server sends them with a quote and an order. */
    const DEFINED = "shared/api.ts";
    /**
     * Any other file that says them speaks of one swap: the small tag on the card, in the review
     * and on an order's page, and what the card says when a private quote cannot be had. Each of
     * those reads that quote's or order's own routing, or the server's setting, before it says anything.
     */
    const BY_THE_SWAP = /\b(?:routedPrivately|routingNote|cardRouting|routingChoice)\(|\bprivacyMode\b|\bwithoutPrivate\b/;
    const candidates = [...new Set([...FILES, ...sources(path.resolve("shared"))])];
    const speaking = candidates.filter((file) => PRIVATE_WORDS.test(shown(file))).map(name).sort();

    it("the files that speak of private routing for the site as a whole are these, and each reads the server's routing", () => {
      for (const [file, reads] of Object.entries(BY_THE_SITE)) {
        expect(speaking, file).toContain(file);
        expect(fs.readFileSync(path.resolve(file), "utf8"), file).toMatch(reads);
      }
      expect(speaking).toContain(DEFINED);
    });

    it("every other file that says the words reads the routing of the one swap it speaks of", () => {
      const others = speaking.filter((file) => !(file in BY_THE_SITE) && file !== DEFINED);
      const unread = others.filter((file) => !BY_THE_SWAP.test(fs.readFileSync(path.resolve(file), "utf8")));
      expect(unread).toEqual([]);
      // The page itself, as it is written and as it is served where swaps are routed in public, is not among any of them.
      expect(speaking).not.toContain("web/index.html");
      expect(fs.readFileSync(path.resolve("web", "index.html"), "utf8")).not.toMatch(PRIVATE_WORDS);
    });

    it("is a check that can fail", () => {
      // A file that said the words with no reading of the routing in it would be caught by the rule above.
      expect(PRIVATE_WORDS.test("Private swaps, across chains.")).toBe(true);
      expect(PRIVATE_WORDS.test("routed privately")).toBe(true);
      expect(PRIVATE_WORDS.test("NEAR Intents' confidential routing")).toBe(true);
      expect(PRIVATE_WORDS.test("does not promise complete confidentiality")).toBe(true);
      expect(BY_THE_SWAP.test('<span className="chip">Private</span>')).toBe(false);
      // The Privacy Policy is not one of the words, and neither are the names the code gives things.
      for (const other of ["Privacy Policy", "this is not a privacy tool", "PRIVATE_UNAVAILABLE", "withoutPrivate", "privateOn"]) expect(PRIVATE_WORDS.test(other), other).toBe(false);
    });
  });

  describe.each([
    ["before the server's settings have arrived", null],
    ["with swaps routed in public", { ...SETTINGS, privacyMode: "public" }],
    ["with a server that says nothing of routing", SETTINGS],
  ] as const)("as drawn %s", (_when, config) => {
    it.each(PAGES)("%s says nothing of private swaps, and leads to no page about them", (_name, page) => {
      const markup = drawnWith(config, page);
      expect(wordsOf(markup).length).toBeGreaterThan(30);
      expect(wordsOf(markup)).not.toMatch(PRIVATE_WORDS);
      expect(markup).not.toMatch(/\/docs\/private|private-routing|data-count/);
    });

    it("the site reads as a plain swap site, and says nothing of routing", () => {
      expect(wordsOf(drawnWith(config, headline))).toBe(`Any coin, in and out of ZEC. Powered by NEAR Intents. ${HEADLINE_SUB}`);
      // The home page: four statements, the fourth of them that swaps are public; item 01 is cross-chain swaps.
      const homeMarkup = drawnWith(config, home);
      expect(homeMarkup.match(/<li class="statement"/g)).toHaveLength(4);
      expect(wordsOf(homeMarkup)).toContain("Swaps are public on-chain: this is not a privacy tool. Anyone can see the transactions on the chains involved.");
      expect(wordsOf(homeMarkup)).not.toContain("What private means here");
      expect(wordsOf(homeMarkup)).toContain(features(false)[0]?.text);
      // The questions: the thirteen that are asked everywhere, and the plain answer to who can see a swap.
      expect(questions(false).map((item) => item.id)).toEqual(QUESTIONS);
      const faqMarkup = drawnWith(config, faq);
      expect(faqMarkup.match(/<details class="faq-item"/g)).toHaveLength(QUESTIONS.length);
      expect(wordsOf(faqMarkup)).toContain("Can other people see my swap? Yes. Every transfer is recorded on its blockchain, where anyone can see the addresses and the amounts.");
      expect(wordsOf(drawnWith(config, docs("faq")))).toContain("Yes. Every transfer is recorded on its blockchain, where anyone can see the addresses and the amounts.");
      // The documentation, the Terms and the Privacy Policy.
      expect(wordsOf(drawnWith(config, docs("safety")))).toContain("Swaps are public on-chain. Anyone can see the transactions on the chains involved.");
      expect(wordsOf(drawnWith(config, docs("safety")))).toContain("Keep the order's link. It is the way back to the order, and anyone who has it can see the order. What SaplingDex never does");
      expect(wordsOf(drawnWith(config, privacy))).toContain("Swaps themselves are public. Every transfer is recorded on its blockchain, where anyone can see the addresses and the amounts. SaplingDex cannot change that.");
      const sections = [...drawnWith(config, terms).matchAll(/<h2 id="[^"]+" data-title="([^"]+)"/g)].map((match) => match[1]);
      expect(sections).toHaveLength(12);
      expect(sections.at(-1)).toBe("12. Changes and contact");
    });
  });

  describe("as drawn with swaps routed privately", () => {
    const config = ROUTED_PRIVATELY;

    it("the headline is the private one, from the same place the page's first words come from", () => {
      expect(wordsOf(drawnWith(config, headline))).toBe(`Private swaps, in and out of ZEC. Powered by NEAR Intents. ${HEADLINE_SUB}`);
    });

    it("the home page says what private means here, in three rows, in place of the statement that swaps are public", () => {
      const markup = drawnWith(config, home);
      const text = wordsOf(markup);
      // The other three statements stay; the fourth is gone, since it is not true here as it stands.
      expect(markup.match(/<li class="statement"/g)).toHaveLength(3);
      for (const kept of ["We never hold your funds.", "The fee is shown before you commit.", "If a swap fails, the provider refunds you."]) expect(text).toContain(kept);
      expect(text).not.toMatch(/Swaps are public on-chain|this is not a privacy tool/);
      // The section follows them: its heading, the three rows word for word, and the way to the page that explains the rest.
      expect(text).toContain(`Private routing What private means here ${PRIVATE_MEANS.map((row) => `${row.label} ${row.text}`).join(" ")} How private routing works`);
      expect(text.indexOf("What we do, and what we don't")).toBeLessThan(text.indexOf("What private means here"));
      expect(markup).toMatch(/<h2 id="means-title" class="section-title">What private means here<\/h2>/);
      expect(markup.match(/<div class="means-row">/g)).toHaveLength(3);
      expect(markup).toMatch(/<a href="\/docs\/private" class="stage-link draw means-more">How private routing works/);
    });

    it("the questions have two more, one before the one on who can see a swap and one, on Add gas, after the one on Ghost mode, and three answers say what private routing changes", () => {
      expect(questions(true).map((item) => item.id)).toEqual(QUESTIONS.flatMap((id) => (id === "public" ? ["private-routing", id] : id === "ghost-mode" ? [id, "add-gas"] : [id])));
      expect(questions(true).filter((item) => item.privateOnly).map((item) => item.question)).toEqual(["What is private routing?", "What is Add gas?"]);
      for (const page of [faq, docs("faq")]) {
        const markup = drawnWith(config, page);
        const text = wordsOf(markup);
        expect(text).toContain("A way of routing a swap so that what you send and what you receive are not tied to each other in public records. NEAR Intents runs it, and calls it confidential routing. Swaps on this site use it. Your deposit and your delivery are still ordinary public transfers. Private routing is not anonymity. How private routing works");
        expect(markup).toMatch(/<a href="\/docs\/private">How private routing works<\/a>/);
        // Who can see a swap: both ends are public, the link between them is not in public records, and it is not anonymity.
        expect(text).toContain("In part. Your deposit and your delivery are each recorded on a blockchain, where anyone can see the addresses and the amounts. The link between the two is not in public records. Amounts and timing can still give hints, and the provider's confidential system can see the swap, as can SaplingDex for what is needed to run your order. Private routing is not anonymity.");
        // A swap made without private routing is an ordinary public one, and the answer says so.
        expect(text).toContain("A swap made without private routing is an ordinary public swap: its deposit and its delivery can be matched to each other.");
        expect(text).not.toContain("Yes. Every transfer is recorded on its blockchain");
        // What a private swap costs: the same fees shown the same way.
        expect(text).toContain("SaplingDex takes no fee. The only fee is the provider's 0.20%.");
        expect(text).toContain("A privately routed swap shows the same fees, each on its own line.");
      }
      expect(wordsOf(drawnWith(config, faq)).indexOf("What is private routing?")).toBeLessThan(wordsOf(drawnWith(config, faq)).indexOf("Can other people see my swap?"));
    });

    it("the documentation has a page on private routing: what it is, what it is not, and how it differs from a mixer and from shielded coins", () => {
      const markup = drawnWith(config, PRIVATE_PAGE[1]);
      const text = wordsOf(markup);
      expect(markup).toMatch(/<h1>Private routing<\/h1>/);
      expect([...markup.matchAll(/<h2 id="([^"]+)" data-title="([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`)).toEqual([
        "what: What it is",
        "public: What stays public",
        "not-public: What is not public",
        "who: Who can still see a swap",
        "not: What it is not",
        "mixer: How it differs from a mixer",
        "shielded: How it differs from shielded coins",
        "cost: What it costs",
        "unavailable: When it is not available",
      ]);
      for (const sentence of [
        // Who runs it: the provider, on a network of its own. SaplingDex asks for it.
        "NEAR Intents, the provider, runs it and calls it confidential routing.",
        "SaplingDex asks for this routing. It does not run it.",
        // Both ends are public; the link between them is what is not in public records.
        "Each is an ordinary transfer on its own blockchain, where anyone can see the addresses and the amounts.",
        "so the two are not tied to each other in public records.",
        // Who can still see it.
        "It processes the swap and knows both ends of it.",
        // What it is not.
        "Private routing is not anonymity. No route guarantees it, and the provider does not promise that confidentiality is complete or without interruption.",
        "Addresses are screened against the sanctions list, by SaplingDex and by the provider, on a privately routed swap as on any other.",
        "Amounts and timing can give hints.",
        "Private routing is not a mixer. There is no pool of other people's coins that yours are mixed with, and no waiting for a crowd.",
        "Only the link between them is kept out of public records.",
        // What it costs.
        "SaplingDex takes no fee. The only fee is the provider's 0.20%. A privately routed swap costs what any swap does, and its quote shows it before you confirm",
        // When it cannot be had: the choice is the person's, and a swap made without it is an ordinary public one.
        'the card says so and offers "Swap without private routing". That is an ordinary public swap: its deposit and its delivery can be matched to each other in public records.',
        "Nothing is switched without your choosing it.",
      ])
        expect(text, sentence).toContain(sentence);
    });

    it("the Track order page and the guide say that a privately routed order opens from its link or ID, never from its deposit address", () => {
      expect(wordsOf(drawnWith(config, track))).toContain("Paste the order's link or ID, or the deposit address you sent to. It opens that order's page. A privately routed order opens from its link or ID only.");
      expect(wordsOf(drawnWith(config, docs(null)))).toContain("A privately routed order is found from its link or ID only, never from its deposit address: the address is public, and the order's page shows both ends of the swap.");
    });

    it("the other pages of the documentation each say what it changes for them", () => {
      expect(wordsOf(drawnWith(config, docs(null)))).toContain("Swaps are routed with NEAR Intents' confidential routing, so your deposit and your delivery are not tied to each other in public records. Both are still public transfers. Private routing is not anonymity. How private routing works");
      expect(wordsOf(drawnWith(config, docs("fees")))).toContain("A privately routed swap has the same three fees, and its quote shows them the same way.");
      const safety = wordsOf(drawnWith(config, docs("safety")));
      expect(safety).toContain("Your deposit and your delivery are public on-chain: anyone can see those two transfers on the chains involved. With private routing the link between them is not in public records. Private routing is not anonymity.");
      expect(safety).not.toContain("Swaps are public on-chain.");
      expect(safety).toContain("On a privately routed swap the order's page shows both ends of it: share the link only with someone you would show both to.");
      // Nothing drawn on a private site says that a private swap pays SaplingDex no fee of its own: no swap pays one.
      for (const page of [faq, docs(null), docs("fees"), docs("private"), docs("safety")]) expect(wordsOf(drawnWith(config, page))).not.toMatch(/takes no fee of its own|pays SaplingDex no fee/);
      // Two pages have nothing to say of it, and say nothing of their own: the one mention on them is the name
      // of the page on private routing, in the list of the documentation's pages that every page carries.
      for (const slug of ["chains", "refunds"] as const) {
        const words = wordsOf(drawnWith(config, docs(slug)));
        expect(words, slug).toContain("Private routing");
        expect(words.replaceAll("Private routing", ""), slug).not.toMatch(PRIVATE_WORDS);
      }
    });

    it("the Terms have a section on it, and the Privacy Policy says what it changes about what is public", () => {
      const markup = drawnWith(config, terms);
      const sections = [...markup.matchAll(/<h2 id="([^"]+)" data-title="([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`);
      expect(sections).toHaveLength(13);
      expect(sections.at(-1)).toBe("private-routing: 13. Private routing");
      // The twelve before it are the ones there have always been, with the same numbers.
      expect(sections.slice(0, 12)).toEqual([...drawnWith(SETTINGS, terms).matchAll(/<h2 id="([^"]+)" data-title="([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`));
      const text = wordsOf(markup);
      for (const sentence of [
        "Private routing is not anonymity.",
        "Addresses are screened against the sanctions list, by SaplingDex and by the swap service, on a privately routed swap as on any other.",
        "You must not use SaplingDex to conceal the proceeds of crime, or to get round sanctions or any law.",
        "The swap service does not promise that confidentiality is complete, and it may be required to disclose what it holds. SaplingDex does not promise it either.",
        "When private routing cannot be had for a swap, the swap is not made unless you choose public routing for it.",
      ])
        expect(text, sentence).toContain(sentence);

      const policy = wordsOf(drawnWith(config, privacy));
      expect(policy).toContain("Your deposit and your delivery are public. Each is a transfer recorded on its blockchain, where anyone can see the addresses and the amounts. SaplingDex cannot change that. With private routing, the link between the two is not in public records. The provider's confidential system, which processes the swap, knows both ends of it. SaplingDex keeps the order as set out below, both addresses included, and the order's record also says how it was routed. Private routing is not anonymity.");
      expect(policy).not.toContain("Swaps themselves are public.");
    });

    it("wherever a page says that the two ends are not tied in public records, the same page says that this is not anonymity", () => {
      const claims = /not tied to each other in public records|not in public records|kept out of public records/;
      const saying = [...PAGES, PRIVATE_PAGE].map(([label, page]) => [label, wordsOf(drawnWith(config, page))] as const).filter(([, text]) => claims.test(text));
      expect(saying.map(([label]) => label)).toEqual(["the home page", "the questions", "Docs, How it works", "Docs, safety", "Docs, faq", "the Terms", "the Privacy Policy", "Docs, private"]);
      for (const [label, text] of saying) expect(text, label).toContain("Private routing is not anonymity");
    });

    it("no page says more of it than the provider does", () => {
      // The provider's Terms give no warranty of confidentiality and forbid saying otherwise. So: "not tied to each other
      // in public records", never "cannot be matched"; and never a word that promises it complete.
      const stronger = /can(?:not|'t| not) be (?:traced|tracked|matched|linked|followed|identified|seen)|\b(?:untrac\w*|anonymous\w*|invisib\w*|guaranteed)\b|(?:fully|completely|totally|always|truly) (?:private|confidential|hidden)|(?:no one|nobody) can (?:see|know|tell)|\bhides? your\b|\bsecret\b/i;
      for (const [label, page] of [...PAGES, PRIVATE_PAGE]) expect(wordsOf(drawnWith(config, page)).replace(NOT_ANONYMITY, ""), label).not.toMatch(stronger);
      for (const item of features(true, true)) expect(`${item.title} ${item.text}`, item.key).not.toMatch(stronger);
      for (const mode of ["public", "private"] as const) expect(JSON.stringify(POSITIONING[mode]), mode).not.toMatch(stronger);
    });
  });
});

describe("what the Stats page lists of a swap is said where a person would look for it, wherever the site has that page", () => {
  const PRIVACY = "Every delivered swap, except one made in Ghost mode, is listed on the Stats page for as long as its order's record is kept, which is 30 days after it finishes, with the coin sent, the amount sent, the time and a link to its deposit transaction. The deposit transaction shows the address that sent it, as any transaction on a public chain does. Which swap was delivered where is not listed or kept for that page: no row names the coin received, its amount, the receiving address or the delivery transaction.";
  const DOCS = "The Stats page lists the deposit transaction of every delivered swap, privately routed or not, except one made in Ghost mode: the coin, the amount, the time and a link to it. Totals of the coins received are shown there too; which swap was delivered where is not.";
  const withStats = (config: object, statsPage: boolean) => ({ ...config, statsPage });

  it("the Privacy Policy says that every delivered swap's deposit is listed, but for one made in Ghost mode, that the deposit shows who sent it, and that nothing of the delivery is listed or kept; where the site has no Stats page it says what is kept and that it is shown nowhere", () => {
    for (const config of [{ ...SETTINGS, privacyMode: "public" }, ROUTED_PRIVATELY]) {
      const on = wordsOf(drawnWith(withStats(config, true), privacy));
      expect(on).toContain(`Stats. ${PRIVACY} Beside those rows the server keeps running totals: how many swaps there were, their value in US dollars by coin sent, by chain and by hour, and the value in US dollars of each coin received, as a total by coin.`);
      expect(drawnWith(withStats(config, true), privacy)).toContain('<a href="/stats">Stats page</a>');
      const off = wordsOf(drawnWith(withStats(config, false), privacy));
      expect(off).not.toMatch(/listed on the Stats page|Stats page/);
      expect(off).toContain("Stats. The server keeps running totals of what delivered swaps sent (how many there were, and their value in US dollars by coin, by chain and by hour) and, for as long as its order's record is kept, which is 30 days after it finishes, one row for each delivered swap, except one made in Ghost mode: the coin sent, the amount sent, the time and the hash of its deposit transaction. Beside them it keeps the value in US dollars of each coin received, as a total by coin. Which swap was delivered where is not kept, and no page of this site shows any of this.");
      // What used to be said of this page is said no longer, by either.
      for (const text of [on, off]) expect(text).not.toMatch(/no transaction hash|no exact amount|no exact time|rounded row|size band|quarter of an hour/);
    }
  });

  it("the page on private routing counts the Stats page among who can still see a swap: the deposit of every delivered swap but one made in Ghost mode, and not the delivery", () => {
    const section = (markup: string) => wordsOf(/<h2 id="who"[\s\S]*?(?=<h2 id="not")/.exec(markup)?.[0] ?? "");
    const on = section(drawnWith(withStats(ROUTED_PRIVATELY, true), PRIVATE_PAGE[1]));
    expect(on).toContain("Who can still see a swap");
    expect(on).toContain(`Anyone, for the deposit alone. ${DOCS}`);
    // The last of the list, after the provider, SaplingDex and whoever has the order's link.
    expect(on.indexOf("Anyone who has the order's link.")).toBeLessThan(on.indexOf("Anyone, for the deposit alone."));
    const off = section(drawnWith(withStats(ROUTED_PRIVATELY, false), PRIVATE_PAGE[1]));
    expect(off).toContain("Anyone who has the order's link.");
    expect(off).not.toMatch(/Stats page|deposit alone|is not listed there/);
  });

  it("none of it says more than is so", () => {
    const more = /\b(?:anonymous\w*|untrac\w*|invisib\w*|guaranteed?)\b|can(?:not|'t| not) be (?:traced|tracked|matched|linked|followed|identified|seen)|(?:no one|nobody) can (?:see|know|tell)/i;
    for (const sentence of [PRIVACY, DOCS, "This swap's deposit transaction will be listed on the Stats page. Which swap was delivered where is not shown.", "Each row links to the deposit on its own chain. Which swap was delivered where is never shown."]) expect(sentence).not.toMatch(more);
    for (const sentence of ["A swap listed here cannot be traced.", "The delivery is invisible.", "Nobody can see where it went."]) expect(more.test(sentence), sentence).toBe(true);
  });
});

describe("what the site says a swap costs", () => {
  const LINE = "SaplingDex takes no fee. The only fee is the provider's 0.20%.";

  it.each([
    ["with swaps routed in public", { ...SETTINGS, privacyMode: "public" }],
    ["with swaps routed privately", ROUTED_PRIVATELY],
  ] as const)("is the one line, on the home page, in the answer on cost, on the Fees page and in the Terms, %s", (_when, config) => {
    for (const [label, page] of [["the home page", home], ["the questions", faq], ["Docs, fees", docs("fees")], ["Docs, faq", docs("faq")], ["the Terms", terms]] as const) expect(wordsOf(drawnWith(config, page)), label).toContain(LINE);
    // The Fees page keeps it true in detail: whose fee it is, and the two network fees beside it.
    const fees = wordsOf(drawnWith(config, docs("fees")));
    expect(fees).toContain("NEAR Intents, which carries out the swap, takes 0.20% of the amount you pay, and less on a swap between two dollar coins.");
    expect(fees).toContain("The network fee of the chain you receive on.");
    expect(fees).toContain("The network fee of the chain you pay on.");
  });

  it("is said by no page as a fee of SaplingDex's own", () => {
    // Nothing a visitor can read says that SaplingDex takes a share of a swap. (The quote's own row, "SaplingDex fee", says "None".)
    const charging = /SaplingDex(?:'s)? fee, a percentage|lists SaplingDex's fee|shows the SaplingDex fee|SaplingDex's part of it|our fee|we (?:charge|take|keep)/i;
    for (const config of [{ ...SETTINGS, privacyMode: "public" }, ROUTED_PRIVATELY]) {
      for (const [label, page] of [...PAGES, PRIVATE_PAGE]) expect(wordsOf(drawnWith(config, page)), label).not.toMatch(charging);
    }
    for (const sentence of ["The SaplingDex fee, a percentage of what you send.", "Every quote lists SaplingDex's fee, the provider's fee and the network fee.", "Each quote shows SaplingDex's part of it."]) expect(charging.test(sentence), sentence).toBe(true);
  });
});

describe("the first words of the site, one set for each way of routing (shared/positioning.ts)", () => {
  it("are these, word for word", () => {
    expect(Object.keys(POSITIONING).sort()).toEqual(["private", "public"]);
    // Routed in public: any coin, in and out of ZEC.
    expect(POSITIONING.public).toEqual({ title: "SaplingDex", description: "Swap any coin on any chain to ZEC on Solana, and back.", headline: { plain: "Any coin, in and out of ZEC.", accent: "Powered by NEAR Intents." }, shareImage: "/share.png" });
    // Routed privately: "Private swaps, in and out of ZEC. Powered by NEAR Intents."
    expect(POSITIONING.private).toEqual({ title: "SaplingDex: private swaps, in and out of ZEC", description: "Private swaps across chains, in and out of ZEC on Solana. Powered by NEAR Intents.", headline: { plain: "Private swaps, in and out of ZEC.", accent: "Powered by NEAR Intents." }, shareImage: "/share-private.png" });
    // The sentence under the headline is the same in both.
    expect(HEADLINE_SUB).toBe("Bring any coin from any chain and arrive on Solana with ZEC, or take ZEC out to any coin. Every fee is shown before you confirm.");
    expect(shareImageAlt("public")).toBe("SaplingDex. Swap any coin on any chain to ZEC on Solana, and back.");
    expect(shareImageAlt("private")).toBe("SaplingDex. Private swaps across chains, in and out of ZEC on Solana. Powered by NEAR Intents.");
  });

  it("the public set says nothing of private swaps, and neither set claims more than that the site is powered by NEAR Intents", () => {
    expect(`${JSON.stringify(POSITIONING.public)} ${HEADLINE_SUB} ${shareImageAlt("public")}`).not.toMatch(PRIVATE_WORDS);
    // "Powered by NEAR Intents" names the technology, in those words and no others. Nothing says or suggests a partnership
    // or an endorsement, of NEAR's or of anyone's: not Sapling's, not Zcash's.
    for (const mode of ["public", "private"] as const) {
      const words = `${JSON.stringify(POSITIONING[mode])} ${shareImageAlt(mode)}`;
      expect(words, mode).toContain("Powered by NEAR Intents.");
      expect(words.replaceAll("Powered by NEAR Intents.", ""), mode).not.toMatch(/partner|official|endors|approved|backed|certified|powered by|by NEAR\b|with NEAR\b|by Sapling|with Sapling|Sapling's|by Zcash/i);
    }
  });

  it("the headline comes up word by word, however many words it has, with the second half in the accent colour", () => {
    expect(headlineWords("public").map((word) => `${word.accent ? "*" : ""}${word.text}`)).toEqual(["Any", "coin,", "in", "and", "out", "of", "ZEC.", "*Powered", "*by", "*NEAR", "*Intents."]);
    expect(headlineWords("private").map((word) => `${word.accent ? "*" : ""}${word.text}`)).toEqual(["Private", "swaps,", "in", "and", "out", "of", "ZEC.", "*Powered", "*by", "*NEAR", "*Intents."]);
    // As drawn: one span to a word, each with its own place in the order (--i, which sets the moment it comes up), and a space between them.
    for (const [mode, config] of [["public", SETTINGS], ["public", null], ["private", ROUTED_PRIVATELY]] as const) {
      const markup = drawnWith(config, headline);
      const title = /<p class="headline-title">(.*?)<\/p>/.exec(markup)?.[1] ?? "";
      // Two lines, the plain words and then the accented ones, each word with its place in the order they come up.
      const numbered = headlineWords(mode).map((word, index) => ({ ...word, index }));
      const line = (accent: boolean) => `<span class="headline-line">${numbered.filter((word) => word.accent === accent).map((word) => `<span class="${word.accent ? "headline-word headline-accent" : "headline-word"}" style="--i:${word.index}">${word.text}</span>`).join(" ")}</span>`;
      expect(title, mode).toBe(`${line(false)} ${line(true)}`);
      expect(markup, mode).toContain(`<p class="headline-sub muted">${HEADLINE_SUB}</p>`);
    }
  });
});

describe("the site does not say that it blocks places", () => {
  // Refusing visitors by country or region is a switch on the server, off unless it is set. What the
  // pages say follows it: off, nothing says that the site blocks a place or works out a country.
  const BLOCKING = /\bblock(?:s|ed|ing)?\b[^.]{0,60}\b(?:region|countr|place|jurisdiction)|\b(?:region|countr|place)[^.]{0,40}\bblock(?:s|ed|ing)?\b|not available in your region|a place where it is not available|work out your country|country and region|\bVPN\b|DB-IP|geolocation/i;
  const everyPage: (readonly [string, () => ReactElement])[] = [...PAGES, PRIVATE_PAGE, ["Terms", terms], ["Privacy", privacy]];

  it.each([
    ["a server told nothing of regions", { ...SETTINGS, privacyMode: "basic" }],
    ["a server with the block switched off", { ...SETTINGS, privacyMode: "basic", regionBlock: false }],
    ["a server that routes in public", { ...SETTINGS, privacyMode: "public", regionBlock: false }],
  ] as const)("on %s, no page says so", (_when, config) => {
    for (const [name, page] of everyPage) expect(wordsOf(drawnWith(config, page)), name).not.toMatch(BLOCKING);
  });

  it("the Terms keep who may use the site as a condition on the person, and claim no block", () => {
    const text = wordsOf(drawnWith({ ...SETTINGS, regionBlock: false }, terms));
    expect(text).toContain("You are not in, and not a resident of, a country or territory that is under sanctions. SaplingDex is not for people or places under sanctions.");
    expect(text).toContain("You are not on a sanctions list, and you are not acting for anyone who is.");
    expect(text).toContain("Using it is lawful where you are. You must not use it where that would be unlawful.");
    expect(text).toContain("These are conditions on you. It is for you to know whether you meet them.");
    expect(text).toContain("Use the site from a place under sanctions, or where using it is unlawful.");
    // The same words whether the block is on or off: the Terms never describe one.
    expect(wordsOf(drawnWith({ ...SETTINGS, regionBlock: true }, terms))).toBe(text);
  });

  it("the Privacy Policy says a country is worked out only where the block is switched on, and names the database it then uses", () => {
    const off = wordsOf(drawnWith({ ...SETTINGS, regionBlock: false }, privacy));
    expect(off).toContain("It is used in memory to apply rate limits. Only the shortened form is written down.");
    expect(off).toContain("a shortened network address (not the full one), a one-way fingerprint of the order ID");
    // Screening of addresses against the sanctions list is said either way: it does not depend on a country.
    expect(off).toContain("Addresses are checked against the sanctions list published by the United States Treasury.");
    const on = wordsOf(drawnWith({ ...SETTINGS, regionBlock: true }, privacy));
    expect(on).toContain("It is used in memory to apply rate limits, and to work out your country and region. Only the shortened form is written down.");
    expect(on).toContain("a shortened network address (not the full one), the country, a one-way fingerprint of the order ID");
    expect(on).toContain("Your country and region are worked out on the server from a database it holds. IP geolocation by DB-IP .");
    expect(on).toContain("Addresses are checked against the sanctions list published by the United States Treasury.");
  });

  it("is a check that can fail", () => {
    for (const sentence of ["The server blocks these countries.", "Prohibited regions and persons are blocked.", "Not available in your region.", "You must not use a VPN.", "It is used to work out your country and region.", "IP geolocation by DB-IP"]) expect(BLOCKING.test(sentence), sentence).toBe(true);
    for (const sentence of ["A listed address is blocked before an order is made.", "This swap can't be processed.", "SaplingDex is not for people or places under sanctions.", "Use the site from a place under sanctions, or where using it is unlawful."]) expect(BLOCKING.test(sentence), sentence).toBe(false);
  });
});
