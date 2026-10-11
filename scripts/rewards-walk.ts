// Signing in on the Rewards page, walked in a real browser with a stand-in Solana wallet (see
// scripts/solana-wallet.ts). The stand-in's key is a real one made from fixed text, so it is
// nobody's; it signs the one plain message it is handed and writes down everything it is asked.
// The server is the practice server, which gives whoever signs in sample points to look at.
//
// The sign-in is the only code on the site that speaks to a wallet. The walk fails if:
//   - any wallet code is fetched, or the stand-in is asked anything, before "Sign in" is pressed;
//   - the wallet is asked for anything but to connect and to sign one message: never a
//     transaction, never the wallet's own "sign in", nothing else it offers;
//   - the bytes it is asked to sign are not exactly the server's message, which begins "Sign in to
//     SaplingDex at <host>.", names the wallet's own address and says it is not a transaction;
//   - a refusal in the wallet signs anyone in, or leaves anything but the one sentence that says so;
//   - the page, or the server's answers, name any address but the signed-in one and the pool's;
//   - the sign-in is kept anywhere in the browser, or outlives a reload;
//   - with two wallets the page does not offer both by name and sign in with the one pressed;
//   - with no wallet the page does not say that none was found;
//   - in Ghost mode the sign-in button is there, the wallet code is fetched, or the stand-in is asked anything.
// Signed in, the sample points, swaps and the pool (ZEC on Solana) are on show.
//
// It photographs the page signed in at 360, 768 and 1280 px in both themes, a refusal, the choice
// of wallets, the page with no wallet, and the page in Ghost mode.
//
// Used by scripts/review-shots.ts (walk name: rewards).

import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { axeProblems } from "./axe.ts";
import { seeAll } from "./order-walk.ts";
import { addStandIns, ALLOWED_ASKS, answerWith, asked, signedBy, standIn, walletCodeAmong, type StandIn } from "./solana-wallet.ts";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

// Made up from fixed text: keys that hold nothing and are nobody's.
const WALLET = standIn("Stand-in Wallet", "saplingdex rewards walk wallet");
const SECOND = standIn("Second Stand-in", "saplingdex rewards walk second wallet");

// The site's set words, written out here so that a change to any of them is seen.
const ASKS_WHAT = "Signing in asks your Solana wallet to sign one plain message, to show that an address is yours. It is not a transaction: it moves nothing, approves nothing and costs no network fee.";
const SIGN_IN = "Sign in with a Solana wallet";
const REFUSED = "Nothing was signed, so you are not signed in.";
const NO_WALLET = "No Solana wallet was found in this browser. Install one, or open this page in your wallet's own browser.";
const OFF_IN_GHOST = "Sign-in is off in Ghost mode. Turn it off to see your points.";
const NOT_A_TRANSACTION = "This is not a transaction. It moves nothing, approves nothing and costs no network fee.";

/** A Solana address is 32 to 44 characters of this alphabet. (A transaction's signature, which is twice as long, is not one.) */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

type Theme = "dark" | "light";

/** One browser on the Rewards page, with what it fetched and what the server answered it written down. */
interface Tab {
  context: BrowserContext;
  page: Page;
  /** Every script of the site's own that the page has asked for since it was last loaded. */
  scripts: string[];
  /** The server's answers on its rewards routes, in the order they came. */
  answers: { path: string; status: number; body: string }[];
  /** What the page sent to those routes. */
  sent: { path: string; body: string }[];
}

export async function rewardsWalk(browser: Browser, options: { practiceUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { practiceUrl, out, visit } = options;
  const host = new URL(practiceUrl).host;

  const open = async (label: string, width: number, theme: Theme, wallets: readonly StandIn[], ghost = false): Promise<Tab> => {
    const mobile = width < 768;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : width < 1024 ? 1024 : 900 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    // A page loaded in Ghost mode: the mode's flag is there before the page's first byte is read.
    if (ghost) await context.addInitScript(`try { sessionStorage.setItem("ghost", "on"); } catch {}`);
    if (wallets.length > 0) await addStandIns(context, wallets);
    const page = await context.newPage();
    const tab: Tab = { context, page, scripts: [], answers: [], sent: [] };
    page.on("request", (request) => {
      const url = new URL(request.url());
      // A fresh load of the page starts the list of what it fetched afresh. (Moving between the site's pages without a load does not.)
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) tab.scripts.length = 0;
      if (/\/assets\/[^/]+\.js$/.test(url.pathname)) tab.scripts.push(request.url());
      if (url.pathname.startsWith("/api/rewards") && request.method() === "POST") tab.sent.push({ path: url.pathname, body: request.postData() ?? "" });
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/rewards")) void response.text().then((body) => tab.answers.push({ path: url.pathname, status: response.status(), body })).catch(() => undefined);
    });
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 300)} (${message.location().url})`);
    });
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
    return tab;
  };

  /** Loads the Rewards page and waits for the week and its countdown. */
  const arrive = async (tab: Tab) => {
    await visit(tab.page, new URL("/rewards", practiceUrl).toString());
    await tab.page.getByRole("heading", { name: "Points and weekly rewards", level: 1 }).waitFor({ timeout: 20_000 });
    await tab.page.locator(".rewards-count").waitFor({ timeout: 20_000 });
    await tab.page.waitForTimeout(1200);
  };

  /** Nothing of a wallet has happened on this page: no wallet code fetched, and the stand-in asked nothing. Says what has, or null. */
  const untouched = async (tab: Tab): Promise<string | null> => {
    const fetched = await walletCodeAmong(tab.scripts);
    if (fetched.length > 0) return `wallet code was fetched (${fetched.join(", ")})`;
    const log = await asked(tab.page);
    return log.length === 0 ? null : `the wallet was asked: ${log.map((ask) => ask.ask).join(", ")}`;
  };

  /** One photograph of the whole page, with every accessibility rule and the page's width looked at. */
  const shoot = async (tab: Tab, label: string, name: string, width: number, theme: Theme) => {
    const { page } = tab;
    await seeAll(page);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(out, `rewards-${name}-${width}-${theme}.png`), fullPage: true });
    shots += 1;
    for (const problem of await axeProblems(page)) complaints.push(`${label} ${name} ${theme}: ${problem}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // When it does, the complaint names what reaches past the screen's edge (the innermost such things).
    const past = overflow <= 0 ? [] : await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => el.closest(".table-frame table") === null && el.getBoundingClientRect().right > window.innerWidth + 0.5 && ![...el.children].some((child) => child.closest(".table-frame table") === null && child.getBoundingClientRect().right > window.innerWidth + 0.5)).map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 30)}"`).slice(0, 4));
    if (overflow > 0) complaints.push(`${label} ${name}: the page scrolls sideways by ${overflow}px (${past.join("; ")})`);
  };

  /** Both themes, one after the other, the browser's own last. */
  const shootBoth = async (tab: Tab, label: string, name: string, width: number, own: Theme) => {
    for (const theme of [own === "dark" ? "light" : "dark", own] as const) {
      await tab.page.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
      await tab.page.waitForTimeout(200);
      await shoot(tab, label, name, width, theme);
    }
  };

  /** Every Solana address written on the page: in its text, in full, and in the links it carries. */
  const addressesOn = (page: Page) =>
    page.locator("main#main").evaluate((main) => {
      const whole = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      const found = new Set<string>();
      // In the text an address stands as one word, or (where it is drawn in parts) as the whole text of its own element.
      for (const word of ((main as HTMLElement).innerText ?? "").split(/\s+/)) if (whole.test(word) && /\d/.test(word)) found.add(word);
      for (const el of main.querySelectorAll(".address, .token-address, .mono")) {
        const text = (el.textContent ?? "").replace(/\s+/g, "");
        if (whole.test(text) && /\d/.test(text)) found.add(text);
      }
      for (const link of main.querySelectorAll("a[href]")) for (const part of (link.getAttribute("href") ?? "").split(/[/?#=&]/)) if (whole.test(part) && /\d/.test(part)) found.add(part);
      // And in short: the first and last characters around an ellipsis.
      const shorts = [...((main as HTMLElement).innerText ?? "").matchAll(/[1-9A-HJ-NP-Za-km-z]{4,8}…[1-9A-HJ-NP-Za-km-z]{4,8}/g)].map((match) => match[0]);
      return { full: [...found], shorts: [...new Set(shorts)] };
    });

  // ---- 1. One wallet: a refusal, a sign-in, what is shown, and what is kept ----
  for (const [width, theme] of [[1280, "dark"], [360, "light"], [768, "dark"]] as const) {
    const label = `rewards ${width} ${theme}`;
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const tab = await open(label, width, theme, [WALLET]);
    const { page } = tab;
    const signIn = page.getByRole("button", { name: SIGN_IN, exact: true });
    const said = async () => flat(await page.locator(".rewards-message").innerText());
    const pool = async () => (JSON.parse(tab.answers.findLast((answer) => answer.path === "/api/rewards" && answer.status === 200)?.body ?? "{}") as { pool?: { address?: string } | null }).pool?.address ?? "";
    try {
      // The swap page first, with the wallet in the browser: nothing there has anything to do with it.
      if (width === 1280) {
        await visit(page, new URL("/?amount=25", practiceUrl).toString());
        await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(800);
        const touched = await untouched(tab);
        expectThat(touched === null, `on the swap page ${touched}`);
      }

      // Before a sign-in: the way in, what it will ask, and nobody's points. Nothing of the wallet has been touched.
      await arrive(tab);
      expectThat((await page.locator(".rewards-points").count()) === 0, "points are shown before anyone has signed in");
      expectThat(await page.getByText(ASKS_WHAT, { exact: true }).isVisible(), "the page does not say, before the wallet opens, what the wallet will be asked");
      expectThat(await signIn.isVisible(), `there is no "${SIGN_IN}" button`);
      const early = await untouched(tab);
      expectThat(early === null, `before "Sign in" was pressed ${early}`);
      expectThat(tab.scripts.length > 0, "the page fetched no scripts at all, so nothing was checked");

      // Refused in the wallet: nobody is signed in, and the page says so in its one sentence.
      await answerWith(page, "reject");
      await signIn.click();
      await page.getByText(REFUSED, { exact: true }).waitFor({ timeout: 20_000 });
      expectThat((await said()) === REFUSED, `after a refusal the page says "${await said()}"`);
      expectThat((await page.locator(".rewards-points").count()) === 0 && (await page.getByText(/Signed in as/).count()) === 0, "a refusal in the wallet signed someone in");
      expectThat(!tab.sent.some((request) => request.path === "/api/rewards/session"), "after a refusal the page still sent a signature to the server");
      await signIn.waitFor({ timeout: 5000 });
      // Only now has the wallet code been fetched: if it never is, the checks above prove nothing.
      expectThat((await walletCodeAmong(tab.scripts)).length === 1, `pressing "Sign in" fetched ${(await walletCodeAmong(tab.scripts)).length} files of wallet code, not the one`);
      if (width === 1280) await shoot(tab, label, "refused", width, theme);

      // Signed: the points of this address.
      await answerWith(page, "accept");
      await signIn.click();
      await page.locator(".rewards-points").waitFor({ timeout: 30_000 });
      expectThat(flat(await page.locator(".rewards-who").innerText()).startsWith(`Signed in as ${short(WALLET.address)}`), `the page does not say which address is signed in: "${flat(await page.locator(".rewards-who").innerText())}"`);

      // What the wallet was asked, all of it: found, connected and one message, twice over (once refused).
      const log = await asked(page);
      const strangers = [...new Set(log.map((ask) => ask.ask).filter((ask) => !ALLOWED_ASKS.has(ask)))];
      expectThat(strangers.length === 0, `the wallet was asked for something else: ${strangers.join(", ")}`);
      const connects = log.filter((ask) => ask.ask === "standard:connect");
      const signings = log.filter((ask) => ask.ask === "solana:signMessage");
      expectThat(connects.length === 2 && connects.every((ask) => ask.inputs === 0), `for one refusal and one sign-in the wallet was asked to connect ${connects.length} times (with ${connects.map((ask) => ask.inputs).join(", ")} inputs)`);
      expectThat(signings.length === 2 && signings.every((ask) => ask.inputs === 1), `for one refusal and one sign-in the wallet was asked to sign ${signings.length} messages`);
      // Each message is, byte for byte, the one the server made for that asking, and says what it must.
      const codes = tab.answers.filter((answer) => answer.path === "/api/rewards/code").map((answer) => JSON.parse(answer.body) as { message?: string; nonce?: string });
      expectThat(codes.length === signings.length, `the server was asked for ${codes.length} messages and the wallet for ${signings.length} signatures`);
      for (const [index, signing] of signings.entries()) {
        const bytes = Buffer.from(signing.message ?? "", "hex");
        const message = bytes.toString("utf8");
        const lines = message.split("\n");
        expectThat(bytes.equals(Buffer.from(codes[index]?.message ?? "\u0000", "utf8")), `the bytes the wallet was asked to sign are not the server's message: "${message.slice(0, 120)}"`);
        expectThat(lines[0] === `Sign in to SaplingDex at ${host}.`, `the message to sign begins "${lines[0]}"`);
        expectThat(lines[1] === `Address: ${WALLET.address}` && signing.account === WALLET.address, `the message to sign names "${lines[1]}", and was to be signed with ${signing.account}`);
        expectThat(message.includes(NOT_A_TRANSACTION), "the message to sign does not say that it is not a transaction");
        expectThat(/^Code: [0-9a-f]{32}$/m.test(message) && /^Good until: \d{4}-\d\d-\d\dT/m.test(message) && lines.length === 6, "the message to sign carries no one-time code, or no time at which it runs out, or a line more than the server's six");
      }
      // One was signed, with the stand-in's own key, and that signature and nothing else of the wallet went to the server.
      const signedOnes = signings.filter((ask) => ask.signature !== undefined);
      expectThat(signedOnes.length === 1 && signedBy(WALLET, Buffer.from(signedOnes[0]?.message ?? "", "hex"), Buffer.from(signedOnes[0]?.signature ?? "", "hex")), `${signedOnes.length} messages were signed for one sign-in, or the signature is not the wallet's own`);
      const sessions = tab.sent.filter((request) => request.path === "/api/rewards/session").map((request) => JSON.parse(request.body) as Record<string, unknown>);
      expectThat(sessions.length === 1 && JSON.stringify(Object.keys(sessions[0] ?? {}).sort()) === JSON.stringify(["nonce", "signature"]) && sessions[0]?.nonce === codes[1]?.nonce && sessions[0]?.signature === Buffer.from(signedOnes[0]?.signature ?? "", "hex").toString("base64"), `the page sent the server ${sessions.length} sign-in(s), or something other than the code and the signature: ${JSON.stringify(sessions.map((body) => Object.keys(body)))}`);

      // Signed in: this week and all time, the swaps behind them, the pool.
      const points = (await page.locator(".rewards-points").innerText()).trim();
      expectThat(/^[\d,]+\.\d\d$/.test(points) && Number(points.replace(/,/g, "")) > 0, `this week's sample points read "${points}"`);
      await page.getByRole("heading", { name: "The swaps behind them" }).waitFor({ timeout: 10_000 });
      const swaps = await page.getByRole("region", { name: "Your swaps and their points" }).locator("tbody tr").count();
      expectThat(swaps >= 3, `the signed-in address is shown ${swaps} sample swaps`);
      // Payouts, where the samples have any: each is sent on Solana, and links to Solana's explorer.
      const payoutLinks = await page.locator("section[aria-labelledby='rewards-payouts'] a[href], section[aria-labelledby='rewards-paid'] a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
      expectThat(payoutLinks.every((href) => href.startsWith("https://solscan.io/tx/")), `a payout links somewhere other than solscan.io: ${payoutLinks.filter((href) => !href.startsWith("https://solscan.io/tx/")).join(", ")}`);
      await page.getByRole("heading", { name: "Current pool" }).waitFor({ timeout: 10_000 });
      const pooled = flat(await page.locator(".rewards-pool-total").innerText());
      // The pool is ZEC on Solana: the sample holds 12.5. (The exact figure follows the short one, for a screen reader.)
      expectThat(/^12\.50? ZEC/.test(pooled) && !/\$|NEAR|BNB/.test(pooled), `the sample pool reads "${pooled}"`);
      const reserve = await pool();
      const wallet = page.getByRole("link", { name: /View the wallet on Solscan/ });
      expectThat(ADDRESS.test(reserve) && (await wallet.getAttribute("href")) === `https://solscan.io/account/${reserve}`, `the pool's wallet links to ${await wallet.getAttribute("href")}`);
      // Beside the address's own points: its share of the week's total, and what that share of the pool comes to.
      const part = flat(await page.locator(".rewards-mine").innerText());
      expectThat(/Your share [\d.]+% Estimated reward [\d,.]+ ZEC .*An estimate\. /i.test(part), `the signed-in address's share reads "${part}"`);

      // No address on the page but this one and the pool's, in full or in short.
      const shown = await addressesOn(page);
      expectThat(shown.full.every((address) => address === reserve || address === WALLET.address), `the page shows an address that is neither the signed-in one nor the pool's: ${shown.full.join(", ")}`);
      expectThat(shown.shorts.every((text) => text === short(WALLET.address) || text === short(reserve)), `the page shows, in short, an address that is neither the signed-in one nor the pool's: ${shown.shorts.join(", ")}`);
      // And what the server answered names no other address either.
      const mine = tab.answers.find((answer) => answer.path === "/api/rewards/me")?.body ?? "";
      // (The one-time code is 32 figures of hex, which is no address.)
      const named = (body: string) => [...new Set([...body.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((match) => match[1] ?? "").filter((value) => /\d/.test(value) && !/^[0-9a-f]{32}$/.test(value)))];
      expectThat(mine !== "" && JSON.stringify(named(mine)) === JSON.stringify([WALLET.address]), `the answer with the signed-in address's points names ${JSON.stringify(named(mine))}`);
      for (const answer of tab.answers.filter((one) => one.path !== "/api/rewards/me")) expectThat(named(answer.body).every((address) => address === WALLET.address || address === reserve), `the server's answer at ${answer.path} names ${JSON.stringify(named(answer.body))}`);
      await shootBoth(tab, label, "signed-in", width, theme);

      // The sign-in is in the page's memory only: nothing of it is kept by the browser.
      const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
      const token = (JSON.parse(tab.answers.find((answer) => answer.path === "/api/rewards/session")?.body ?? "{}") as { token?: string }).token ?? "";
      expectThat(token !== "" && !kept.includes(token) && !kept.includes(WALLET.address) && (await tab.context.cookies()).length === 0, "the sign-in, or the address, is kept in the browser's storage");

      // Signing out takes the points off the screen.
      await page.getByRole("button", { name: "Sign out" }).click();
      await signIn.waitFor({ timeout: 10_000 });
      expectThat((await page.locator(".rewards-points").count()) === 0 && (await page.getByRole("heading", { name: "The swaps behind them" }).count()) === 0, "points or swaps are still shown after signing out");

      if (width === 1280) {
        // Sign in again, then load the page afresh: not signed in, no wallet code fetched, and the wallet not asked anything.
        await signIn.click();
        await page.locator(".rewards-points").waitFor({ timeout: 30_000 });
        await arrive(tab);
        await page.waitForTimeout(1500);
        expectThat((await page.locator(".rewards-points").count()) === 0 && (await page.getByText(/Signed in as/).count()) === 0 && (await signIn.isVisible()), "the sign-in outlived a reload of the page");
        const again = await untouched(tab);
        expectThat(again === null, `after a reload, with nothing pressed, ${again}`);
        // And at the end of it all the wallet was never asked for anything but the three things.
        expectThat((await asked(page)).every((ask) => ALLOWED_ASKS.has(ask.ask)), "the wallet was asked for something it must never be asked");
      }
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await tab.context.close();
  }

  // ---- 2. Two wallets: both offered by name, and the one pressed is the one asked ----
  {
    const label = "rewards two wallets";
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const tab = await open(label, 360, "dark", [WALLET, SECOND]);
    const { page } = tab;
    try {
      await arrive(tab);
      const early = await untouched(tab);
      expectThat(early === null, `before "Sign in" was pressed ${early}`);
      await page.getByRole("button", { name: SIGN_IN, exact: true }).click();
      const choice = page.getByRole("list", { name: "Choose a wallet to sign in with" });
      await choice.waitFor({ timeout: 20_000 });
      const names = (await choice.getByRole("button").allInnerTexts()).map(flat);
      expectThat(JSON.stringify(names) === JSON.stringify([WALLET.name, SECOND.name]), `with two wallets the page offers ${JSON.stringify(names)}`);
      // Until one is pressed, neither has been asked to connect or to sign.
      expectThat((await asked(page)).every((ask) => ask.ask === "found"), `before a wallet was chosen one was asked: ${(await asked(page)).map((ask) => `${ask.wallet}: ${ask.ask}`).join(", ")}`);
      await page.mouse.move(0, 0);
      await shoot(tab, label, "choose", 360, "dark");
      await choice.getByRole("button", { name: SECOND.name, exact: true }).click();
      await page.locator(".rewards-points").waitFor({ timeout: 30_000 });
      expectThat(flat(await page.locator(".rewards-who").innerText()).startsWith(`Signed in as ${short(SECOND.address)}`), `after the second wallet was pressed the page says "${flat(await page.locator(".rewards-who").innerText())}"`);
      const log = await asked(page);
      expectThat(log.every((ask) => ALLOWED_ASKS.has(ask.ask)), `a wallet was asked for something else: ${log.map((ask) => ask.ask).join(", ")}`);
      expectThat(log.filter((ask) => ask.wallet === WALLET.name).length === 0, "the wallet that was not pressed was asked something");
      const signings = log.filter((ask) => ask.ask === "solana:signMessage");
      expectThat(signings.length === 1 && signings[0]?.wallet === SECOND.name && signings[0].account === SECOND.address && Buffer.from(signings[0].message ?? "", "hex").toString("utf8").split("\n")[1] === `Address: ${SECOND.address}` && signedBy(SECOND, Buffer.from(signings[0].message ?? "", "hex"), Buffer.from(signings[0].signature ?? "", "hex")), "the wallet that was pressed was not asked, once, to sign the message for its own address");
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await tab.context.close();
  }

  // ---- 3. No wallet in the browser: the page says so ----
  {
    const label = "rewards no wallet";
    const tab = await open(label, 1280, "light", []);
    const { page } = tab;
    try {
      await arrive(tab);
      await page.getByRole("button", { name: SIGN_IN, exact: true }).click();
      await page.getByText(NO_WALLET, { exact: true }).waitFor({ timeout: 20_000 }).catch(() => complaints.push(`${label}: with no wallet in the browser the page does not say "${NO_WALLET}"`));
      if (flat(await page.locator(".rewards-message").innerText()) !== NO_WALLET) complaints.push(`${label}: with no wallet in the browser the page says "${flat(await page.locator(".rewards-message").innerText())}"`);
      if ((await page.locator(".rewards-points").count()) !== 0 || tab.sent.length !== 0) complaints.push(`${label}: with no wallet in the browser points are shown, or the server was asked for a sign-in`);
      await shoot(tab, label, "no-wallet", 1280, "light");
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await tab.context.close();
  }

  // ---- 4. Ghost mode: no sign-in, no wallet code, and the wallet asked nothing ----
  for (const [width, theme] of [[1280, "dark"], [360, "light"]] as const) {
    const label = `rewards ghost ${width} ${theme}`;
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const tab = await open(label, width, theme, [WALLET], true);
    const { page } = tab;
    try {
      await arrive(tab);
      expectThat((await page.evaluate("document.documentElement.dataset.ghost")) === "on", "the page is not in Ghost mode");
      expectThat(await page.getByText(OFF_IN_GHOST, { exact: true }).isVisible(), `in Ghost mode the page does not say "${OFF_IN_GHOST}"`);
      expectThat((await page.getByRole("button", { name: /Sign in|Connect/i }).count()) === 0 && (await page.getByText(ASKS_WHAT, { exact: true }).count()) === 0, "in Ghost mode the sign-in is still offered");
      // The week, its total and the pool are there as always.
      await page.getByRole("heading", { name: "Current pool" }).waitFor({ timeout: 10_000 });
      // The other pages too, and back: nowhere in the mode is anything of the wallet touched.
      for (const address of ["/", "/stats", "/rewards"]) {
        await visit(page, new URL(address, practiceUrl).toString());
        await page.locator("footer").waitFor({ timeout: 20_000 });
        await page.waitForTimeout(1200);
        const touched = await untouched(tab);
        expectThat(touched === null, `in Ghost mode, on ${address}, ${touched}`);
      }
      expectThat(tab.sent.length === 0, "in Ghost mode the server was asked for a sign-in");
      await shoot(tab, label, "ghost", width, theme);
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await tab.context.close();
  }

  return { complaints, shots };
}
