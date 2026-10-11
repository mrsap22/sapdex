// Draws the picture a link to the site shows when it is shared: 1200 by 630, the site's name, its
// headline and the swap card as it really looks. Run it again when the look or the card changes.
//
//   npx tsx scripts/make-share.ts <address of the running site> [--private]
//
// With --private it draws the picture for a site that routes swaps privately (give it the address
// of a site that is running that way): the words are the private ones and it goes to share-private.png.
//
// Nothing of the look is written down here. The words are the site's own (shared/positioning.ts).
// The colours are read from the running page, in the theme a visit opens in: its ground, its text,
// its quiet text, its lines and the colour of the headline's last words. The typefaces are the
// site's own files, found through its own list of them (web/src/styles/fonts.css), and used for
// what the page uses them for. The name is the one word, in text, as in the site's header.
//
// The card is photographed from the running site in its resting state, before any amount is
// typed, so the picture holds no rate and no number that could go stale. It is taller than the
// picture, so it runs off the bottom edge. Uses the Chrome already installed on this machine.
// Output goes to web/public/share.png.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { POSITIONING } from "../shared/positioning.ts";

const site = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
/** Which picture: the one for a site that routes privately, or the usual one. */
const privately = process.argv.includes("--private");
if (site === undefined) {
  console.error("make-share: give the address of the running site, for example http://127.0.0.1:8799");
  process.exit(1);
}

const WIDTH = 1200;
const HEIGHT = 630;
const PAD = 64;
/** The card's width in the picture. Its height follows; what does not fit runs off the bottom. */
const CARD_WIDTH = 440;

/** The site's typefaces, as its own stylesheet lists them: each with its file written into the picture's page. */
function ownFaces(): string {
  const sheet = path.resolve("web", "src", "styles", "fonts.css");
  const blocks = fs.readFileSync(sheet, "utf8").match(/@font-face\s*\{[^}]*\}/g) ?? [];
  if (blocks.length === 0) throw new Error("the site's list of typefaces (web/src/styles/fonts.css) names none");
  return blocks
    .map((block) =>
      block.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (_all, file: string) => {
        const found = path.resolve(path.dirname(sheet), file);
        return `url(data:font/woff2;base64,${fs.readFileSync(found).toString("base64")})`;
      }),
    )
    .join("\n");
}

const browser = await chromium.launch({ channel: "chrome", headless: true });

// 1. The card and the look, from the site itself, as a first visit finds it (nothing kept, nothing chosen).
const shop = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
const live = await shop.newPage();
await live.goto(site, { waitUntil: "networkidle" });
const card = live.locator(".card");
await card.waitFor();
await live.locator(".coin-button").first().waitFor();
// Icons are images of their own: wait until every one in the card has been drawn.
await live.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".card img")].every((img) => img.complete && img.naturalWidth > 0));
await live.evaluate(() => document.fonts.ready);
// The card as it rests, not as it looks with the keyboard in its first field.
await live.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
await live.mouse.move(0, 0);
await live.waitForTimeout(1500);
// (Written without a helper of its own: the page knows nothing of this script's tooling.)
const look = await live.evaluate(() => {
  const probe = document.createElement("span");
  probe.className = "muted";
  document.body.append(probe);
  const muted = getComputedStyle(probe).color;
  probe.remove();
  const body = getComputedStyle(document.body);
  const headlineEl = document.querySelector(".headline-title");
  const accentEl = document.querySelector(".headline-accent");
  const cardEl = document.querySelector(".card");
  const headline = headlineEl === null ? null : getComputedStyle(headlineEl);
  return {
    ground: body.backgroundColor,
    ink: body.color,
    muted,
    line: cardEl === null ? muted : getComputedStyle(cardEl).borderTopColor,
    accent: accentEl === null ? body.color : getComputedStyle(accentEl).color,
    text: body.fontFamily,
    display: headline?.fontFamily ?? body.fontFamily,
    displayStyle: headline?.fontStyle ?? "normal",
    displayWeight: headline?.fontWeight ?? "400",
  };
});
const box = await card.boundingBox();
if (box === null) throw new Error("the card is not on the page");
const photo = await card.screenshot({ type: "png" });
await shop.close();

// 2. The picture: the name top-left, the headline, under a thin line the one sentence a link preview gives, and the card on the right.
const said = POSITIONING[privately ? "private" : "public"];
const words = said.headline;
const safe = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const scale = CARD_WIDTH / box.width;
const cardWidth = CARD_WIDTH;
const cardHeight = Math.round(box.height * scale);
const html = `<!doctype html><html><head><style>
${ownFaces()}
* { margin: 0; box-sizing: border-box; }
body { position: relative; overflow: hidden; width: ${WIDTH}px; height: ${HEIGHT}px; background: ${look.ground}; color: ${look.ink}; font-family: ${look.text}; display: grid; grid-template-columns: minmax(0, 1fr) ${cardWidth}px; gap: ${PAD}px; padding: ${PAD}px ${PAD}px 0; }
.words { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; padding-bottom: ${PAD - 8}px; }
.wordmark { font-size: 28px; line-height: 34px; font-weight: 600; letter-spacing: -0.02em; }
.line { align-self: center; font-family: ${look.display}; font-style: ${look.displayStyle}; font-weight: ${look.displayWeight}; font-size: 68px; line-height: 70px; letter-spacing: -0.01em; }
.line span { display: block; color: ${look.accent}; }
.sub { border-top: 1px solid ${look.line}; padding-top: 20px; font-size: 20px; line-height: 30px; color: ${look.muted}; }
img { width: ${cardWidth}px; height: ${cardHeight}px; display: block; }
</style></head><body>
<div class="words">
<div class="wordmark">SaplingDex</div>
<p class="line">${safe(words.plain)}<span>${safe(words.accent)}</span></p>
<p class="sub">${safe(said.description)}</p>
</div>
<img alt="" src="data:image/png;base64,${photo.toString("base64")}">
</body></html>`;

const frame = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
const sheet = await frame.newPage();
await sheet.setContent(html, { waitUntil: "load" });
await sheet.evaluate(() => document.fonts.ready);
// Every typeface the picture asks for is one of the site's own, and has loaded: a missing one would be drawn in whatever the machine has.
const missing = await sheet.evaluate(() => {
  const loaded = [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/["']/g, ""));
  return [".wordmark", ".line"].map((selector) => getComputedStyle(document.querySelector(selector)!).fontFamily.split(",")[0]!.replace(/["']/g, "").trim()).filter((family) => !loaded.includes(family));
});
if (missing.length > 0) throw new Error(`the picture asks for a typeface the site does not have: ${missing.join(", ")}`);
const out = path.resolve("web", "public", privately ? "share-private.png" : "share.png");
await sheet.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
await browser.close();
console.log(`make-share: wrote ${path.basename(out)} (${WIDTH} x ${HEIGHT}, ${(fs.statSync(out).size / 1024).toFixed(0)} KB), card ${cardWidth} x ${cardHeight}`);
