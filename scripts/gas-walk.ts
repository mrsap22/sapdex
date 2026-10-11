// "Add gas", walked in a real browser against a practice server that routes privately
// (PROVIDER_STUB=true PRIVACY_MODE=basic). Nothing real is sent anywhere: the orders are pretend
// orders, each paid by deposit address, and the practice server is told when a deposit "arrives".
// Used by scripts/review-shots.ts (walk name: gas; it needs --private=<url>).
//
// What the walk holds the site to:
//   - the card: no switch, and no question to the server about gas, until a valid receiving address
//     is on the card; then "Add gas", off, with its one line; none where the coin received is its
//     chain's own; after a reload off again, with nothing of gas kept in the browser;
//   - the review: the swap, then "Gas" (what is sent, about how much arrives, its fees, "The same
//     receiving address"), then "Total sent", which is the two amounts on the page added exactly;
//     SaplingDex's fee "None" on both; and the sentence that there are two payments;
//   - the order's page: the four steps and the gas line, a "Swap deposit" and a "Gas deposit" with
//     addresses of their own, QR codes of their own and amounts of their own, and the line that
//     they are two separate transfers. There is no other way to pay either: no wallet is offered;
//   - the two deposits in each order: the swap alone paid is delivered while the gas waits, and the
//     gas then paid is delivered; the gas alone paid is delivered while the swap waits; the gas
//     first and then the swap, paying with the chain's own coin; neither paid, both run out, and
//     the gas line says nothing was lost;
//   - in Ghost mode: both orders are Ghost orders; each record is deleted when that order is
//     delivered; the page still says how each ended; a fresh load shows the notice, with the gas
//     order beneath it while only the swap has finished; the Stats page has no row for either and
//     counts one swap more; the browser keeps the mode's flag and nothing else;
//   - when the gas order cannot be made: the swap is made, and its page says so in one line.
// Throughout: a clean console, no request to any address but the site's own, no sideways
// scrolling, and every accessibility rule on each screen photographed.
//
// How "cannot be made" is staged, with nothing faked: the server lets one visitor have ten unpaid
// orders open. Plain orders are made (through the API, as this visitor) until the server says there
// are too many; one is ended, which leaves room for exactly one more. The swap with gas made next
// is that one, and its gas order is the eleventh: refused by the server's own limit, alone.
//
// The walk makes about two dozen orders on the practice server, which allows one address thirty a
// day: start that server afresh (with an empty data folder) before a second run.
//
// It photographs the card with the switch on, the review (its top, and the Gas part with the
// total) and the order's page (as it opens, and with both deposit addresses shown), at three
// widths in both themes, and the endings it walks at the width they are walked at.

import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, ConsoleMessage, Locator, Page } from "playwright-core";
import { axeProblems } from "./axe.ts";
import { freshSol, orderPace, settle, testControl } from "./order-walk.ts";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

/** Made up from fixed text, so it is nobody's: the refund address of the orders paid by deposit address. */
const REFUND = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
/** The one key Ghost mode keeps in the tab. */
const FLAG = "ghost";
/** What the walk's swaps pay with, as the card opens: USDC on Base. One round pays with the chain's own coin instead. */
const USDC = { symbol: "USDC", decimals: 6, network: "Base", query: "?amount=25", amount: "25" } as const;
const ETH = { symbol: "ETH", decimals: 18, network: "Base", query: "?from=base:ETH&amount=0.01", amount: "0.01" } as const;

// The site's set words, written out here so that a change to any of them is seen.
const SWITCH_LINE = "About $3 of SOL arrives at the same address, so a new wallet can move straight away.";
const TWO_PAYMENTS = "There are two payments: one for the swap and one for the gas.";
const TWO_TRANSFERS = "These are two separate transfers. Send each to its own address; do not combine them.";
const NOT_ADDED = "Gas was not added. Your swap is unaffected.";
const RAN_OUT = "It ran out unpaid: nothing was sent to it and nothing is lost.";
const NEVER = [/untraceabl/i, /invisible/i, /hidden from authorities/i, /can(?:not|'t) be (?:traced|linked)/i, /\banonymous(?:ly)?\b/i, /\bmixer\b/i, /guarantee/i, /coming soon/i];

type Theme = "dark" | "light";

interface Coin {
  id: string;
  symbol: string;
  chain: string;
  decimals: number;
  contract: string | null;
}

/** An order as the server gives it out, as far as the walk reads it. */
interface Order {
  id: string;
  status: string;
  pay: string;
  ghost?: boolean;
  gasOrder?: boolean;
  from: Coin;
  to: Coin;
  amountIn: string;
  recipient: string;
  refundTo: string;
  routing?: string;
  fees: { appBps: number; providerBps: number };
  depositAddress: string | null;
  gas?: { made: boolean; order?: Order | null; ended?: string };
}

interface Tab {
  context: BrowserContext;
  page: Page;
  width: number;
  theme: Theme;
  /** What the page sent each time it asked the server about gas. */
  gasAsks: Record<string, unknown>[];
  /** Console complaints that are meant, each for its own reason. */
  forgiven: ((message: ConsoleMessage) => boolean)[];
}

/** A figure as the page writes it ("1,244.678486 USDT"), in the coin's smallest unit. Whole numbers only: nothing is rounded. */
function units(text: string, decimals: number): bigint {
  const figure = /\d[\d,]*(?:\.\d+)?/.exec(text)?.[0].replace(/,/g, "");
  if (figure === undefined) throw new Error(`no figure in "${text}"`);
  const [whole = "0", part = ""] = figure.split(".");
  if (part.length > decimals) throw new Error(`"${text}" has more decimal places than the coin has`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(part.padEnd(decimals, "0") || "0");
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const bare = (text: string) => text.replace(/\s/g, "");

export async function gasWalk(browser: Browser, options: { privateUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { privateUrl, out, visit } = options;
  const own = new URL(privateUrl);
  /** The orders a round has made, the gas orders among them: whatever is still open at the round's end is ended then. */
  const made: string[] = [];

  const config = (await (await fetch(new URL("/api/config", privateUrl))).json()) as { privacyMode?: string; practice?: boolean };
  if (config.privacyMode !== "basic" || config.practice !== true) return { complaints: [`gas: the walk needs a practice server that routes privately; this one says ${JSON.stringify({ privacyMode: config.privacyMode, practice: config.practice })}`], shots };

  /** The order as the server holds it, or the answer it gives in its place. */
  const orderOf = async (id: string): Promise<{ status: number; order: Order; error: { code?: string; detail?: { ended?: string }; gas?: Order["gas"] } }> => {
    const answer = await fetch(new URL(`/api/orders/${id}`, privateUrl));
    const body = (await answer.json().catch(() => ({}))) as Order & { error?: { code?: string; detail?: { ended?: string }; gas?: Order["gas"] } };
    return { status: answer.status, order: body, error: body.error ?? {} };
  };
  const stats = async () => (await (await fetch(new URL("/api/stats", privateUrl))).json()) as { totals?: { swaps?: number }; feed?: { coin?: { symbol?: string; chain?: string }; amount?: string }[] };

  /**
   * A browser of one width and theme. Whatever its console complains of, and any address it asks
   * for that is not this site's, is a fault. What it asks the server about gas is written down.
   */
  const open = async (label: string, width: number, theme: Theme): Promise<Tab> => {
    const mobile = width < 768;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    const page = await context.newPage();
    const tab: Tab = { context, page, width, theme, gasAsks: [], forgiven: [] };
    const note = (address: string) => {
      const url = new URL(address);
      if (!/^(https?|wss?):$/.test(url.protocol) || url.host === own.host) return;
      complaints.push(`${label}: the page asked another site for something: ${url.host}`);
    };
    page.on("request", (request) => {
      note(request.url());
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/gas") tab.gasAsks.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
    });
    page.on("websocket", (socket) => note(socket.url()));
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      if (tab.forgiven.some((meant) => meant(message))) return;
      complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 240)} (${message.location().url})`);
    });
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
    return tab;
  };

  /**
   * One photograph in each theme, the browser's own last, with every accessibility rule and the
   * page's width looked at in each. `whole` names what the photograph must hold to its end: the
   * swap card, or all an order's page says, either of which can be longer than a screen. The screen
   * is made that tall for the photograph, so that nothing is cut and what is pinned to the screen
   * stands clear of it, and is then put back.
   */
  const shoot = async (tab: Tab, label: string, name: string, whole?: "card" | "page") => {
    const { page, width } = tab;
    const screen = page.viewportSize() ?? { width, height: 900 };
    if (whole !== undefined) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const end = await page.evaluate((parts) => Math.ceil(Math.max(0, ...[...document.querySelectorAll(parts)].map((part) => part.getBoundingClientRect().bottom + window.scrollY))), whole === "card" ? ".card" : "main#main > *");
      await page.setViewportSize({ width, height: Math.max(screen.height, end + (whole === "card" ? 24 : 96)) });
    }
    for (const theme of [tab.theme === "dark" ? "light" : "dark", tab.theme] as const) {
      // The theme is changed by the site's own switch where the header has it, so that all that follows the theme does
      // (it is pressed from here, for a sheet may lie over the header); a phone keeps the switch in its menu, and there
      // the page's own mark of its theme is set.
      await page.evaluate((to) => {
        if (document.documentElement.dataset.theme === to) return;
        document.querySelector<HTMLButtonElement>("button.header-theme")?.click();
        if (document.documentElement.dataset.theme !== to) document.documentElement.dataset.theme = to;
      }, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(out, `gas-${name}-${width}-${theme}.png`) });
      shots += 1;
      for (const problem of await axeProblems(page)) complaints.push(`${label} ${name} ${theme}: ${problem}`);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) complaints.push(`${label} ${name}: the page scrolls sideways by ${overflow}px at ${width} px`);
    if (whole !== undefined) await page.setViewportSize(screen);
  };

  const gasSwitch = (page: Page) => page.getByRole("switch", { name: "Add gas" });
  const anySwitch = async (page: Page) => (await page.getByRole("switch").count()) + (await page.locator(".gas-switch").count());

  /** Waits for the switch that answers a valid receiving address, looks at it, and switches it on. */
  const switchOn = async (tab: Tab, say: (ok: boolean, what: string) => void): Promise<void> => {
    const control = gasSwitch(tab.page);
    await control.waitFor({ timeout: 20_000 });
    say((await control.getAttribute("aria-checked")) === "false", "the Add gas switch is not off when it first appears");
    say(flat(await control.locator(".gas-switch-line").innerText()) === SWITCH_LINE, `the switch's line reads "${flat(await control.locator(".gas-switch-line").innerText())}"`);
    await control.click();
    say((await control.getAttribute("aria-checked")) === "true", "pressing the Add gas switch did not switch it on");
    // The pointer is taken off the switch: what is photographed is the card at rest.
    await tab.page.mouse.move(0, 0);
  };

  /** Opens the review of the card as it stands and waits for its Gas part. */
  const openReview = async (page: Page): Promise<Locator> => {
    await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
    const review = page.getByRole("dialog", { name: "Review swap" });
    await review.waitFor({ timeout: 20_000 });
    await review.locator(".review-gas").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
    return review;
  };

  /** The rows of one part of the review, by their labels, as the eye is given them. */
  const rowsOf = async (rows: Locator): Promise<Record<string, string>> =>
    Object.fromEntries(await rows.evaluateAll((list) => list.map((row) => [(row.querySelector("dt")?.textContent ?? "").trim(), ((row.querySelector("dd") as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim()])));

  /**
   * Reads the review of a swap with gas and holds it to what it must say. Returns the two amounts
   * sent, in the paying coin's smallest unit, as the page itself gives them.
   */
  const readReview = async (review: Locator, paying: { symbol: string; decimals: number; network: string }, say: (ok: boolean, what: string) => void): Promise<{ swap: bigint; gas: bigint }> => {
    const swapRows = await rowsOf(review.locator(".review > dl.review-rows").first().locator(".review-row"));
    const gasRows = await rowsOf(review.locator(".review-gas .review-row"));
    const totalRows = await rowsOf(review.locator(".review > dl.review-rows").last().locator(".review-row"));
    const heading = flat(await review.locator(".review-gas .review-part").innerText());
    say(heading === "Gas · Solana", `the second part of the review is headed "${heading}"`);
    const sent = new RegExp(`^[\\d.,]+ ${paying.symbol} on ${paying.network}$`);
    say(sent.test(swapRows["You send"] ?? ""), `the swap's "You send" reads "${swapRows["You send"]}"`);
    say(sent.test(gasRows["You send"] ?? ""), `the gas part's "You send" reads "${gasRows["You send"]}"`);
    say(/^[\d.,]+ SOL on Solana$/.test(gasRows["You receive, about"] ?? ""), `the gas part's "You receive, about" reads "${gasRows["You receive, about"]}"`);
    say(gasRows.Routing === "Private", `the gas part's routing reads "${gasRows.Routing}"`);
    say(swapRows["SaplingDex fee"] === "None", `the swap's SaplingDex fee reads "${swapRows["SaplingDex fee"]}"`);
    say(gasRows["SaplingDex fee"] === "None", `the gas part's SaplingDex fee reads "${gasRows["SaplingDex fee"]}"`);
    say(new RegExp(`^[\\d.,]+ ${paying.symbol} \\d+\\.\\d\\d%$`).test(gasRows["Provider fee"] ?? ""), `the gas part's provider fee reads "${gasRows["Provider fee"]}"`);
    say(/SOL included above$|^Included above$/.test(gasRows["Solana network fee"] ?? ""), `the gas part's network fee reads "${gasRows["Solana network fee"]}"`);
    say(gasRows["Arrives at"] === "The same receiving address", `the gas part's "Arrives at" reads "${gasRows["Arrives at"]}"`);
    say(sent.test(totalRows["Total sent"] ?? ""), `"Total sent" reads "${totalRows["Total sent"]}"`);
    const swap = units(swapRows["You send"] ?? "", paying.decimals);
    const gas = units(gasRows["You send"] ?? "", paying.decimals);
    const total = units(totalRows["Total sent"] ?? "", paying.decimals);
    say(gas > 0n && swap > 0n && total === swap + gas, `"Total sent" is ${totalRows["Total sent"]}, which is not ${swapRows["You send"]} and ${gasRows["You send"]} added`);
    const said = flat(await review.innerText());
    say(said.includes(TWO_PAYMENTS), `the review does not say "${TWO_PAYMENTS}"`);
    for (const word of NEVER) say(!word.test(said), `the review uses a word it must never use (${String(word)})`);
    return { swap, gas };
  };

  /** Brings a part of the review into view: its top, the Gas part from its heading down, or the total at the foot. Says whether the total is in view. */
  const frameReview = (review: Locator, where: "top" | "gas" | "total") =>
    review.evaluate((dialog, to) => {
      const part = dialog.querySelector(".review-gas");
      const total = [...dialog.querySelectorAll(".review-row")].find((row) => (row.querySelector("dt")?.textContent ?? "").trim() === "Total sent");
      let scroller = part?.parentElement ?? null;
      while (scroller !== null && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      if (part === null || total === undefined || scroller === null) return true;
      const frame = scroller.getBoundingClientRect();
      if (to === "top") scroller.scrollTop = 0;
      else {
        if (to === "total") scroller.scrollTop += total.getBoundingClientRect().bottom - frame.bottom + 16;
        else scroller.scrollTop += part.getBoundingClientRect().top - frame.top - 16;
      }
      return total.getBoundingClientRect().bottom <= frame.bottom + 0.5 && total.getBoundingClientRect().top >= frame.top;
    }, where);

  /** The review, photographed: its top, and its Gas part with the total (in two pictures where one cannot hold both). */
  const shootReview = async (tab: Tab, label: string, review: Locator) => {
    await frameReview(review, "top");
    await shoot(tab, label, "review-top");
    const held = await frameReview(review, "gas");
    await shoot(tab, label, "review");
    if (!held) {
      await frameReview(review, "total");
      await shoot(tab, label, "review-total");
    }
  };

  /** Ticks the Terms, confirms, and lands on the order's page. Returns the swap as the server holds it. */
  const confirm = async (page: Page, review: Locator): Promise<Order> => {
    await review.getByRole("checkbox").check();
    await orderPace();
    await review.getByRole("button", { name: "Confirm swap" }).click();
    await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 40_000 });
    const id = new URL(page.url()).pathname.split("/").pop() ?? "";
    made.push(id);
    const { order } = await orderOf(id);
    if (order.gas?.order?.id !== undefined) made.push(order.gas.order.id);
    return order;
  };

  /** Holds the pair the server made to what was reviewed: the gas order is an order of its own, to the swap's own addresses, privately routed, with no fee of ours. */
  const holdPair = (swap: Order, reviewed: { swap: bigint; gas: bigint }, say: (ok: boolean, what: string) => void): Order | null => {
    const gas = swap.gas?.made === true ? (swap.gas.order ?? null) : null;
    say(gas !== null, `the swap the server holds has no gas order beside it (${JSON.stringify(swap.gas)})`);
    if (gas === null) return null;
    say(gas.gasOrder === true && gas.id !== swap.id, "the gas order is not marked as one, or is the swap itself");
    say(gas.recipient === swap.recipient, `the gas order delivers to ${gas.recipient}, not to the swap's receiving address`);
    say(gas.refundTo === swap.refundTo, `the gas order refunds to ${gas.refundTo}, not to the swap's refund address`);
    say(gas.from.id === swap.from.id && gas.to.symbol === "SOL" && gas.to.chain === "sol" && gas.to.contract === null, `the gas order is ${gas.from.symbol} to ${gas.to.symbol} on ${gas.to.chain}`);
    say(gas.routing === "confidential" && swap.routing === "confidential", `the pair is routed "${swap.routing}" and "${gas.routing}"`);
    say(swap.fees.appBps === 0 && gas.fees.appBps === 0, `a fee of ours is on the pair: ${swap.fees.appBps} and ${gas.fees.appBps} basis points`);
    say(BigInt(swap.amountIn) === reviewed.swap && BigInt(gas.amountIn) === reviewed.gas, `the orders are for ${swap.amountIn} and ${gas.amountIn}, the review showed ${reviewed.swap} and ${reviewed.gas}`);
    say(gas.depositAddress !== null && swap.depositAddress !== null && gas.depositAddress.toLowerCase() !== swap.depositAddress.toLowerCase(), "the two orders do not have a deposit address each");
    say(gas.pay === swap.pay && gas.ghost === swap.ghost, "the gas order is not paid the way the swap is, or is not a Ghost order with it");
    return gas;
  };

  /** The gas line of an order's page: how it is marked, its state in a word, and its sentence. */
  const gasLine = async (page: Page) => {
    const line = page.locator(".gas-line");
    if ((await line.count()) !== 1) return { mark: "", state: "", text: "", lines: await line.count() };
    return { mark: (await line.getAttribute("data-state")) ?? "", state: flat(await line.locator(".gas-line-state").innerText().catch(() => "")), text: flat(await line.locator(".step-text").innerText()), lines: 1 };
  };
  const gasLineIs = (page: Page, mark: string, state: string) => page.locator(`.gas-line[data-state="${mark}"] .gas-line-state`, { hasText: state });
  const ending = (page: Page, headline: string) => page.locator(".order-ending-headline", { hasText: headline });
  const swapDeposit = (page: Page) => page.locator('section.deposit[aria-labelledby="deposit-title"]');
  const gasDeposit = (page: Page) => page.locator('section.deposit[aria-labelledby="gas-deposit-title"]');

  // ---- 1. The card, the review, and the pair paid as two deposits: one round at each width, and one more with the chain's own coin ----
  for (const [width, theme, story, paying] of [
    [1280, "dark", "swap-then-gas", USDC],
    [360, "light", "gas-only", USDC],
    [768, "dark", "neither", USDC],
    [768, "light", "gas-then-swap", ETH],
  ] as const) {
    const label = `gas ${width} ${story}`;
    const say = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const tab = await open(label, width, theme);
    const { page } = tab;
    try {
      // -- The card. A token is received (ZEC on Solana), and no receiving address is on the card yet. --
      await visit(page, new URL(`/${paying.query}`, privateUrl).toString());
      await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      say((await anySwitch(page)) === 0, "the card shows the Add gas switch before any receiving address is entered");
      say(tab.gasAsks.length === 0, "the server was asked about gas before any receiving address was entered");
      // An address that is not one of the receiving chain: still nothing.
      await page.getByLabel(/Receiving address/).fill(REFUND);
      await page.getByRole("alert").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1200);
      say((await anySwitch(page)) === 0 && tab.gasAsks.length === 0, "an address that is not valid on the receiving chain brought the switch, or a question about gas");
      // A valid one brings the switch: "Add gas", with its line, off.
      const recipient = freshSol();
      await page.getByLabel(/Receiving address/).fill(recipient);
      const control = gasSwitch(page);
      await control.waitFor({ timeout: 20_000 }).catch(() => say(false, "a valid receiving address did not bring the Add gas switch"));
      say(tab.gasAsks.length >= 1, "the switch is on the card although the server was never asked about gas");
      for (const body of tab.gasAsks) say(Object.keys(body).every((key) => ["from", "to", "pay", "recipient", "refundTo"].includes(key)) && body.pay === "manual" && body.recipient === recipient, `the question about gas carried more than the swap's coins, way of paying and addresses: ${JSON.stringify(body)}`);
      await page.getByLabel(/Refund address/).fill(REFUND);
      await switchOn(tab, say);
      say(!/gas/i.test(page.url()), `the page's address says something of gas: ${page.url()}`);
      // The switch goes with the address it answered, at once, and comes back with it, off.
      await page.getByLabel(/Receiving address/).fill("");
      await page.waitForTimeout(150);
      say((await anySwitch(page)) === 0, "with the receiving address taken away, the switch is still on the card");
      await page.getByLabel(/Receiving address/).fill(recipient);
      await switchOn(tab, say);
      for (const word of NEVER) say(!word.test(await page.locator(".card").innerText()), `the card uses a word it must never use (${String(word)})`);
      await page.getByRole("button", { name: "Review swap" }).waitFor({ timeout: 40_000 });
      await page.waitForTimeout(400);
      await shoot(tab, label, "card", "card");

      // -- After a reload: off again, and nothing of gas kept in the browser. --
      await visit(page, page.url());
      await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1200);
      say((await page.getByLabel(/Receiving address/).inputValue()) === "" && (await anySwitch(page)) === 0, "after a reload the receiving address, or the switch, is still on the card");
      const kept = JSON.parse(String(await page.evaluate("JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])"))) as [string, string][][];
      const ofGas = kept.flat().filter(([key, value]) => /gas/i.test(key) || /"gas[A-Za-z]*"\s*:/.test(value) || value.includes(recipient));
      say(ofGas.length === 0, `after a reload the browser keeps something of gas, or of the receiving address, under ${ofGas.map(([key]) => key).join(", ")}`);
      await page.getByLabel(/Receiving address/).fill(recipient);
      await control.waitFor({ timeout: 20_000 }).catch(() => say(false, "after a reload a valid receiving address did not bring the switch back"));
      say((await control.getAttribute("aria-checked").catch(() => null)) === "false", "after a reload the switch is not off");

      // -- The chain's own coin received (SOL): no switch, and nothing asked. --
      const askedSoFar = tab.gasAsks.length;
      await visit(page, new URL(`/${paying.query}&to=sol:SOL`, privateUrl).toString());
      await page.getByLabel(/Receiving address/).fill(recipient);
      await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      say(/SOL/.test(await page.getByRole("button", { name: /^You receive: / }).innerText()), "the card did not take SOL as the coin received");
      say((await anySwitch(page)) === 0, "the card offers Add gas although the coin received is the chain's own");
      say(tab.gasAsks.length === askedSoFar, "the server was asked about gas for a swap that receives the chain's own coin");

      // -- The review of a swap with gas. --
      await visit(page, new URL(`/${paying.query}`, privateUrl).toString());
      await page.getByLabel(/Receiving address/).fill(recipient);
      await page.getByLabel(/Refund address/).fill(REFUND);
      await switchOn(tab, say);
      const review = await openReview(page);
      const reviewed = await readReview(review, paying, say);
      say(units(paying.amount, paying.decimals) === reviewed.swap, `the review's swap sends ${reviewed.swap}, the card held ${paying.amount} ${paying.symbol}`);
      say(bare(await review.innerText()).includes(recipient), "the review does not show the receiving address in full");
      await shootReview(tab, label, review);

      // -- The order's page: four steps and the gas line, two deposits, each with its own address and amount. --
      const before = await stats();
      const swap = await confirm(page, review);
      const gas = holdPair(swap, reviewed, say);
      if (gas === null) throw new Error("no gas order was made, so the rest of this round cannot be walked");
      // Asked for by its own ID, the gas order is an order like any other, said to be a gas order and told of no gas of its own.
      const alone = (await orderOf(gas.id)).order;
      say(alone.gasOrder === true && alone.gas === undefined && alone.depositAddress === gas.depositAddress && alone.status === "waiting", "asked for by its own ID, the gas order is not an order of its own");
      await page.getByRole("heading", { name: "Swap deposit" }).waitFor({ timeout: 15_000 });
      await page.getByRole("heading", { name: "Gas deposit" }).waitFor({ timeout: 15_000 });
      say((await page.getByText(TWO_TRANSFERS).count()) === 1, `the order's page does not say "${TWO_TRANSFERS}"`);
      const steps = await page.locator(".order ol.steps li").allInnerTexts();
      say(steps.length === 4 && ["Waiting for deposit", "Deposit seen", "Swapping", "Delivered"].every((title, i) => (steps[i] ?? "").includes(title)), `the swap's steps read ${JSON.stringify(steps.map((step) => step.split("\n")[0]))}`);
      const waiting = await gasLine(page);
      say(waiting.lines === 1 && waiting.mark === "current" && waiting.state === "Waiting" && waiting.text === "Waiting for its deposit.", `the gas line reads ${JSON.stringify(waiting)}`);
      say(/^Gas about [\d.,]+ SOL/.test(flat(await page.locator(".gas-line-head").innerText())), `the gas line's head reads "${flat(await page.locator(".gas-line-head").innerText())}"`);
      const [stepsEnd, lineStart] = [await page.locator("ol.steps").evaluate((el) => el.getBoundingClientRect().bottom), await page.locator(".gas-line").evaluate((el) => el.getBoundingClientRect().top)];
      say(lineStart >= stepsEnd, "the gas line is not beneath the swap's four steps");
      const [swapTop, gasTop] = [await swapDeposit(page).evaluate((el) => el.getBoundingClientRect().top), await gasDeposit(page).evaluate((el) => el.getBoundingClientRect().top)];
      say(gasTop > swapTop, "the gas deposit is not beneath the swap's");
      say(units(await swapDeposit(page).locator(".deposit-value").first().innerText(), paying.decimals) === reviewed.swap, `the swap deposit's amount reads "${flat(await swapDeposit(page).locator(".deposit-value").first().innerText())}"`);
      say(units(await gasDeposit(page).locator(".deposit-value").first().innerText(), paying.decimals) === reviewed.gas, `the gas deposit's amount reads "${flat(await gasDeposit(page).locator(".deposit-value").first().innerText())}"`);
      await shoot(tab, label, "order", "page");
      // Each address is shown once its own box is ticked, and they are two addresses.
      await swapDeposit(page).getByLabel("I'm sending on Base").check();
      await gasDeposit(page).getByLabel("I'm sending on Base").check();
      await page.locator(".qr").nth(1).waitFor({ timeout: 10_000 });
      const shown = [bare(await swapDeposit(page).locator(".review-address-value").innerText()), bare(await gasDeposit(page).locator(".review-address-value").innerText())];
      say(shown[0] === swap.depositAddress && shown[1] === gas.depositAddress && shown[0] !== shown[1], `the two deposit addresses on the page are ${shown[0]} and ${shown[1]}; the orders' are ${swap.depositAddress} and ${gas.depositAddress}`);
      // Each deposit has a QR code of its own, and that is all there is to pay with: no wallet is offered for either.
      say((await swapDeposit(page).locator(".qr").count()) === 1 && (await gasDeposit(page).locator(".qr").count()) === 1, "the two deposits do not have a QR code each");
      say(swap.pay === "manual" && gas.pay === "manual", `the pair is to be paid "${swap.pay}" and "${gas.pay}", not by deposit address`);
      const paid = flat(await page.locator("main#main").innerText());
      say(!/Connect|connected wallet|Confirm in wallet|1 of 2|2 of 2/i.test(paid) && (await page.getByRole("button", { name: /^(Connect|Send )/ }).count()) === 0, "the order's page offers to pay from a wallet");
      // The gas order's own details name the swap's receiving address, in full.
      await page.locator("details.order-fold", { hasText: "Gas order details" }).locator("summary").click();
      say(bare(await page.locator("details.order-fold", { hasText: "Gas order details" }).innerText()).includes(recipient), "the gas order's details do not show the swap's receiving address");
      await page.locator("details.order-fold", { hasText: "Gas order details" }).locator("summary").click();
      await shoot(tab, label, "order-addresses", "page");

      if (story === "swap-then-gas") {
        // Only the swap is paid: it is delivered, and the gas order still waits, with its deposit still on the page.
        await testControl(page, "Pay in full");
        await ending(page, "Delivered").waitFor({ timeout: 120_000 });
        const still = await gasLine(page);
        say(still.mark === "current" && still.state === "Waiting", `with the swap delivered and the gas unpaid, the gas line reads ${JSON.stringify(still)}`);
        say((await page.getByRole("heading", { name: "Gas deposit" }).count()) === 1 && (await page.getByRole("heading", { name: "Swap deposit" }).count()) === 0, "with the swap delivered, the page does not show the gas deposit alone");
        say((await orderOf(gas.id)).order.status === "waiting" && (await orderOf(swap.id)).order.status === "delivered", "the server does not hold the swap as delivered and the gas order as waiting");
        await shoot(tab, label, "order-swap-delivered", "page");
        // Then the gas: its line says delivered.
        await testControl(page, "Gas: pay in full");
        await gasLineIs(page, "done", "Delivered").waitFor({ timeout: 120_000 });
        const done = await gasLine(page);
        say(/^[\d.,]+ SOL sent to /.test(done.text), `the delivered gas line reads "${done.text}"`);
        say((await page.getByRole("heading", { name: "Gas deposit" }).count()) === 0, "the gas deposit is still on show after the gas was delivered");
        say((await ending(page, "Delivered").count()) === 1, "the swap's ending went away when the gas was delivered");
        await shoot(tab, label, "order-both-delivered", "page");
        // The Stats page: one swap more, one row for the swap, none for the gas order.
        const after = await stats();
        const had = new Set((before.feed ?? []).map((row) => JSON.stringify(row)));
        const fresh = (after.feed ?? []).filter((row) => !had.has(JSON.stringify(row)));
        const mine = fresh.filter((row) => row.coin?.symbol === paying.symbol && row.coin.chain === "base");
        say(mine.filter((row) => row.amount === swap.amountIn).length === 1, "the delivered swap has no row of its own among the recent swaps");
        // (The smallest made-up swap is of eight dollars: a row of the same coin worth less than two gas orders could only be the gas order's.)
        say(mine.every((row) => row.amount !== gas.amountIn && BigInt(row.amount ?? "0") >= 2n * BigInt(gas.amountIn)), "the delivered gas order has a row among the recent swaps");
        say((after.totals?.swaps ?? 0) - (before.totals?.swaps ?? 0) - (fresh.length - 1) === 1, `the totals count ${String(after.totals?.swaps)} swaps after the pair was delivered, from ${String(before.totals?.swaps)} before, with ${fresh.length - 1} made-up swap(s) added meanwhile`);
      } else if (story === "gas-then-swap") {
        // The gas first, then the swap: each is delivered in its turn, and at the end nothing is left to pay.
        await testControl(page, "Gas: pay in full");
        await gasLineIs(page, "done", "Delivered").waitFor({ timeout: 120_000 });
        say((await swapDeposit(page).count()) === 1 && (await page.locator(".order-ending-headline").count()) === 0, "with only the gas paid, the swap's deposit is no longer on the page, or the swap has an ending");
        await testControl(page, "Pay in full");
        await ending(page, "Delivered").waitFor({ timeout: 120_000 });
        await page.waitForTimeout(800);
        say((await gasLine(page)).state === "Delivered" && (await page.locator("section.deposit").count()) === 0, "with both delivered, a deposit is still on the page, or the gas line no longer says delivered");
        say((await orderOf(swap.id)).order.status === "delivered" && (await orderOf(gas.id)).order.status === "delivered", "the server does not hold both orders as delivered");
        await shoot(tab, label, "order-gas-then-swap", "page");
      } else if (story === "gas-only") {
        // Only the gas is paid: it is delivered, and the swap still waits.
        await testControl(page, "Gas: pay in full");
        await gasLineIs(page, "done", "Delivered").waitFor({ timeout: 120_000 });
        say((await page.locator('.step[data-state="current"]', { hasText: "Waiting for deposit" }).count()) === 1 && (await page.locator(".order-ending-headline").count()) === 0, "with only the gas paid, the swap is not still waiting for its deposit");
        say((await orderOf(swap.id)).order.status === "waiting" && (await orderOf(gas.id)).order.status === "delivered", "the server does not hold the gas order as delivered and the swap as waiting");
        say((await page.getByRole("heading", { name: "Gas deposit" }).count()) === 0 && (await page.getByText(TWO_TRANSFERS).count()) === 0, "with the gas delivered, its deposit, or the line about two transfers, is still on the page");
        say((await swapDeposit(page).count()) === 1, "with only the gas paid, the swap's deposit is no longer on the page");
        await shoot(tab, label, "order-gas-delivered", "page");
      } else {
        // The gas order's own page, from its own ID: it says what it is, and has its one deposit.
        const pair = page.url();
        await visit(page, new URL(`/order/${gas.id}`, privateUrl).toString());
        await page.getByRole("heading", { name: "Send your deposit" }).waitFor({ timeout: 15_000 });
        // (A title gives an amount only where it is short enough to give exactly: a gas order's seldom is.)
        say(new RegExp(`^Gas: ([\\d.,]+ )?${paying.symbol} to SOL$`).test(flat(await page.locator("#order-title").innerText())), `the gas order's own page is titled "${flat(await page.locator("#order-title").innerText())}"`);
        say((await page.locator(".gas-line").count()) === 0 && (await page.locator("section.deposit").count()) === 1 && flat(await page.locator(".order-foot").last().innerText()).startsWith(`Gas order ${gas.id}.`), "the gas order's own page shows a gas line of its own, or more than its one deposit, or does not name itself");
        await shoot(tab, label, "order-gas-own-page", "page");
        await visit(page, pair);
        await page.getByRole("heading", { name: "Gas deposit" }).waitFor({ timeout: 15_000 });
        // Neither is paid, and the practice clock is moved past the deadline: both ran out, and nothing was lost.
        await testControl(page, "Skip to expired");
        await ending(page, "Expired").waitFor({ timeout: 90_000 });
        await gasLineIs(page, "stopped", "Ran out").waitFor({ timeout: 90_000 });
        const out = await gasLine(page);
        say(out.text === RAN_OUT, `the gas line of a pair that ran out reads "${out.text}"`);
        say((await page.locator("section.deposit").count()) === 0, "a deposit is still on show after both orders ran out");
        say((await orderOf(swap.id)).order.status === "expired" && (await orderOf(gas.id)).order.status === "expired", "the server does not hold both orders as expired");
        await shoot(tab, label, "order-ran-out", "page");
      }
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(os.tmpdir(), "saplingdex-walk-stuck", `stuck-gas-${width}-${story}.png`) }).catch(() => undefined);
    } finally {
      for (const id of made.splice(0)) await settle(privateUrl, id);
      await tab.context.close();
      // The walk is one visitor to the server, held to a visitor's limits: a breath between its rounds.
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
  }

  // ---- 2. In Ghost mode: both are Ghost orders, and each record goes when that order is delivered ----
  {
    const width = 360;
    const label = `gas ghost ${width}`;
    const say = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const tab = await open(label, width, "dark");
    const { page } = tab;
    const keptNow = async (): Promise<[string[], string[]]> => JSON.parse(String(await page.evaluate("JSON.stringify([Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()])"))) as [string[], string[]];
    try {
      // The mode is switched on from the header (on a phone, from the menu), with what the browser already held cleared.
      await visit(page, new URL("/", privateUrl).toString());
      await page.locator(".card").waitFor({ timeout: 20_000 });
      const button = page.locator("button.ghost-switch");
      if (await button.isVisible().catch(() => false)) await button.click();
      else {
        await page.getByRole("button", { name: "Menu", exact: true }).click();
        await page.locator("button.menu-ghost").click();
      }
      const sheet = page.getByRole("dialog", { name: "Ghost mode" });
      await sheet.waitFor({ timeout: 10_000 });
      await sheet.getByRole("checkbox").check();
      await sheet.getByRole("button", { name: "Turn on", exact: true }).click();
      await page.locator("button.ghost-pill").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      say(JSON.stringify(await keptNow()) === JSON.stringify([[], [FLAG]]), `with the mode switched on the browser keeps ${JSON.stringify(await keptNow())}`);

      // The same swap with gas, paid as two deposits, as everywhere.
      await visit(page, new URL("/?amount=25", privateUrl).toString());
      say((await page.evaluate("document.documentElement.dataset.ghost")) === "on", "the page is not in the mode after it was loaded again");
      const recipient = freshSol();
      await page.getByLabel(/Receiving address/).fill(recipient);
      await page.getByLabel(/Refund address/).fill(REFUND);
      await switchOn(tab, say);
      await page.getByRole("button", { name: "Review swap" }).waitFor({ timeout: 40_000 });
      await shoot(tab, label, "ghost-card", "card");
      const review = await openReview(page);
      const reviewed = await readReview(review, USDC, say);
      say(flat(await review.innerText()).includes("This order is not listed on the Stats page, and its record is deleted from this site's server when it is delivered or refunded."), "the review of a Ghost order with gas does not say what is kept of it");
      const before = await stats();
      const swap = await confirm(page, review);
      const gas = holdPair(swap, reviewed, say);
      if (gas === null) throw new Error("no gas order was made, so the rest of this round cannot be walked");
      say(swap.ghost === true && gas.ghost === true, `the pair made in the mode is not a pair of Ghost orders (${String(swap.ghost)}, ${String(gas.ghost)})`);
      await page.getByText("This is the only way back to this order. It is not saved anywhere.").waitFor({ timeout: 15_000 });
      await page.getByRole("heading", { name: "Gas deposit" }).waitFor({ timeout: 15_000 });
      say((await page.getByRole("heading", { name: "Swap deposit" }).count()) === 1 && (await page.getByText(TWO_TRANSFERS).count()) === 1, "in the mode the order's page does not show the two deposits and the line about them");
      await shoot(tab, label, "ghost-order", "page");

      // The swap is delivered: its record is deleted, the page still says how it ended, and the gas order is still there.
      // (The browser notes every "gone" answer in its console: for these two orders, from here on, that answer is the point.)
      tab.forgiven.push((message) => /status of 410/.test(message.text()) && [`/api/orders/${swap.id}`, `/api/orders/${gas.id}`].includes(new URL(message.location().url).pathname));
      await testControl(page, "Pay in full");
      await page.getByText("This order has finished and its record has been deleted from the server.").waitFor({ timeout: 120_000 });
      // How it ended is still said: by the ending the page had already shown or, where the record went before the page saw the end, by the note itself.
      say((await ending(page, "Delivered").count()) === 1 || flat(await page.locator(".order-ghost").innerText()).includes("It was delivered: look for the delivery at your receiving address, in the order details below."), "once the swap's record was deleted, the page does not say that it was delivered");
      const half = await orderOf(swap.id);
      say(half.status === 410 && half.error.code === "order_deleted" && half.error.detail?.ended === "delivered", `after the swap's end the server answers ${half.status} ${JSON.stringify(half.error).slice(0, 160)}`);
      say(half.error.gas?.made === true && half.error.gas.order?.id === gas.id && half.error.gas.order.status === "waiting", "the answer for the deleted swap does not still lead to its gas order");
      say((await gasLine(page)).state === "Waiting" && (await page.getByRole("heading", { name: "Gas deposit" }).count()) === 1, "with the swap's record deleted, the page no longer shows the gas order waiting, with its deposit");
      await shoot(tab, label, "ghost-swap-finished", "page");
      // A fresh load of the link: the notice, and beneath it the gas order, which is still to be paid.
      await visit(page, page.url());
      await page.getByRole("heading", { name: "This order finished." }).waitFor({ timeout: 15_000 });
      await page.getByRole("heading", { name: "Gas order", exact: true }).waitFor({ timeout: 15_000 });
      const notice = flat(await page.locator("main#main").innerText());
      say(notice.includes("It was delivered. It was made in Ghost mode, so its record was deleted when it finished.") && notice.includes("Made with the swap above, and an order of its own. This page's link is the only way back to it."), `a fresh load of the link, with only the swap finished, reads "${notice.slice(0, 300)}"`);
      say((await page.getByRole("heading", { name: "Gas deposit" }).count()) === 1 && (await gasLine(page)).state === "Waiting", "a fresh load of the link does not show the gas order still waiting, with its deposit");
      say(!bare(notice).includes(swap.depositAddress ?? "-") && !/\bZEC\b|\b25 USDC\b/.test(notice), "a fresh load of the link still shows something of the finished swap");
      await shoot(tab, label, "ghost-gas-alone", "page");

      // The gas order is delivered: its record goes too, and the page still says how it ended.
      await testControl(page, "Gas: pay in full");
      await page.locator('.gas-line[data-state="done"] .step-text', { hasText: "It was delivered. It was made in Ghost mode, so its record was deleted when it finished." }).waitFor({ timeout: 120_000 });
      say((await gasLine(page)).state === "Delivered" && (await page.locator("section.deposit").count()) === 0, "once the gas order's record was deleted, the page does not say that it was delivered, or still shows its deposit");
      const [goneSwap, goneGas] = [await orderOf(swap.id), await orderOf(gas.id)];
      say(goneGas.status === 410 && goneGas.error.code === "order_deleted", `after its end the server answers ${goneGas.status} for the gas order`);
      say(goneSwap.status === 410 && (goneSwap.error.gas === undefined || (goneSwap.error.gas.made === true && (goneSwap.error.gas.order ?? null) === null && goneSwap.error.gas.ended === "delivered")), `with both finished the server says of the gas order: ${JSON.stringify(goneSwap.error.gas)}`);
      say(!/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{40,}|amount|depositAddress|recipient/.test(JSON.stringify([goneSwap.error, goneGas.error])), "the answers for the two deleted orders still hold something of them");
      await shoot(tab, label, "ghost-both-finished", "page");
      // A fresh load of the link: the notice, how each ended, and nothing else of either.
      await visit(page, page.url());
      await page.getByRole("heading", { name: "This order finished." }).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(600);
      const last = flat(await page.locator("main#main").innerText());
      say(last.includes("so its record was deleted when it finished") && !/0x[0-9a-fA-F]{6}|ETH|USDC|ZEC|SOL|\d+\.\d+/.test(last) && (await page.locator("section.deposit").count()) === 0, `with both finished, a fresh load of the link reads "${last.slice(0, 300)}"`);
      await shoot(tab, label, "ghost-deleted");

      // The Stats page: one swap more in the totals, and no row for the swap or for the gas order.
      const after = await stats();
      const had = new Set((before.feed ?? []).map((row) => JSON.stringify(row)));
      const fresh = (after.feed ?? []).filter((row) => !had.has(JSON.stringify(row)));
      say(!fresh.some((row) => row.coin?.symbol === USDC.symbol && row.coin.chain === "base" && (row.amount === swap.amountIn || row.amount === gas.amountIn)), "an order of the pair made in the mode has a row among the recent swaps");
      say((after.totals?.swaps ?? 0) - (before.totals?.swaps ?? 0) - fresh.length === 1, `the totals count ${String(after.totals?.swaps)} swaps after the pair, from ${String(before.totals?.swaps)} before, with ${fresh.length} made-up swap(s) added meanwhile`);
      // After all of it: the flag, and nothing else.
      say(JSON.stringify(await keptNow()) === JSON.stringify([[], [FLAG]]), `after a whole swap with gas in the mode the browser keeps ${JSON.stringify(await keptNow())}`);
      say((await tab.context.cookies()).length === 0, "the browser was given a cookie");
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(os.tmpdir(), "saplingdex-walk-stuck", "stuck-gas-ghost.png") }).catch(() => undefined);
    } finally {
      for (const id of made.splice(0)) await settle(privateUrl, id);
      await tab.context.close();
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
  }

  // ---- 3. When the gas order cannot be made: the swap is made, and its page says so ----
  {
    const width = 768;
    const label = `gas not added ${width}`;
    const say = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const tab = await open(label, width, "light");
    const { page } = tab;
    const fillers: string[] = [];
    try {
      // Plain orders, made as this visitor through the API, until the server says there are too many unpaid.
      const fresh = (await (await fetch(new URL("/api/config", privateUrl))).json()) as { session?: string; termsVersion?: string };
      const headers = { "content-type": "application/json", origin: own.origin, "x-session": fresh.session ?? "" };
      const coins = ((await (await fetch(new URL("/api/tokens", privateUrl))).json()) as { tokens: { id: string; symbol: string; chain: string }[] }).tokens;
      const [from, to] = [coins.find((coin) => coin.symbol === "USDC" && coin.chain === "base")?.id, coins.find((coin) => coin.symbol === "ZEC" && coin.chain === "sol")?.id];
      if (from === undefined || to === undefined) throw new Error("the coin list lacks USDC on Base or ZEC on Solana");
      let full = false;
      for (let n = 0; n < 12 && !full; n++) {
        const wanted = { from, to, amount: "25000000", pay: "manual", slippageBps: 100, recipient: freshSol(), refundTo: REFUND };
        const quote = (await (await fetch(new URL("/api/quote", privateUrl), { method: "POST", headers, body: JSON.stringify(wanted) })).json()) as { amountOut?: string; minAmountOut?: string; fees?: { appBps: number; providerBps: number }; routing?: string };
        if (quote.amountOut === undefined || quote.fees === undefined) throw new Error(`a preview for a plain order was refused: ${JSON.stringify(quote).slice(0, 160)}`);
        await orderPace();
        const answer = await fetch(new URL("/api/orders", privateUrl), { method: "POST", headers, body: JSON.stringify({ ...wanted, reviewed: { amountOut: quote.amountOut, minAmountOut: quote.minAmountOut, totalFeeBps: quote.fees.appBps + quote.fees.providerBps, routing: quote.routing }, termsVersion: fresh.termsVersion, termsAccepted: true }) });
        const body = (await answer.json()) as { id?: string; error?: { message?: string } };
        if (answer.status === 201 && body.id !== undefined) {
          fillers.push(body.id);
          made.push(body.id);
        } else if (answer.status === 429 && /unpaid orders/.test(body.error?.message ?? "")) full = true;
        else throw new Error(`a plain order was answered ${answer.status}: ${JSON.stringify(body).slice(0, 160)}`);
      }
      const last = fillers.at(-1);
      if (!full || last === undefined) throw new Error("the server never said that this visitor has too many unpaid orders, so the gas order cannot be made to fail by that limit");
      // One is ended: there is room for exactly one more order.
      await settle(privateUrl, last);
      for (let wait = 0; wait < 20 && (await orderOf(last)).order.status === "waiting"; wait++) await new Promise((resolve) => setTimeout(resolve, 500));

      await visit(page, new URL("/?amount=25", privateUrl).toString());
      const recipient = freshSol();
      await page.getByLabel(/Receiving address/).fill(recipient);
      await page.getByLabel(/Refund address/).fill(REFUND);
      await switchOn(tab, say);
      const review = await openReview(page);
      const reviewed = await readReview(review, USDC, say);
      const swap = await confirm(page, review);
      // The swap is made, whole; the gas order is not; and the page says so in its one line.
      say(swap.status === "waiting" && BigInt(swap.amountIn) === reviewed.swap && swap.recipient === recipient && swap.depositAddress !== null, `the swap was not made as reviewed: ${JSON.stringify({ status: swap.status, amountIn: swap.amountIn })}`);
      say(swap.gas?.made === false, `the server says of the gas: ${JSON.stringify(swap.gas)}`);
      await page.locator(".gas-line").waitFor({ timeout: 15_000 });
      const line = await gasLine(page);
      say(line.mark === "stopped" && line.text === NOT_ADDED, `the gas line reads ${JSON.stringify(line)}`);
      say((await page.getByRole("heading", { name: "Send your deposit" }).count()) === 1 && (await page.locator("section.deposit").count()) === 1, "the page does not show the swap's one deposit, and no other");
      say((await page.getByRole("heading", { name: /Gas deposit|Swap deposit/ }).count()) === 0 && (await page.getByText(TWO_TRANSFERS).count()) === 0 && (await page.locator("details.order-practice button", { hasText: /^Gas: / }).count()) === 0, "the page speaks of a gas deposit, or of two transfers, although no gas order was made");
      await shoot(tab, label, "order-not-added", "page");
      // The swap is unaffected in deed: paid, it is delivered, and the line stays as it was.
      await testControl(page, "Pay in full");
      await ending(page, "Delivered").waitFor({ timeout: 120_000 });
      say((await gasLine(page)).text === NOT_ADDED, "the line about the gas changed when the swap was delivered");
      // After a reload the page says the same.
      await visit(page, page.url());
      await ending(page, "Delivered").waitFor({ timeout: 15_000 });
      say((await gasLine(page)).text === NOT_ADDED, "after a reload the page no longer says that gas was not added");
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(os.tmpdir(), "saplingdex-walk-stuck", "stuck-gas-not-added.png") }).catch(() => undefined);
    } finally {
      for (const id of made.splice(0)) await settle(privateUrl, id);
      await tab.context.close();
    }
  }

  return { complaints, shots };
}
