// A swap with gas, on its own page. Beside such a swap stands a second, small order that delivers
// a little of the receiving chain's own coin to the same address. The page shows the two as what
// they are, two orders: the swap's four steps and, beneath them, one line for the gas order; two
// deposits, each sent by the person to its own address.
//
// The pages are drawn here as a browser first draws them (to plain markup, without a browser), and
// the rules behind them are asked directly. How the server makes and pairs the two orders has
// tests of its own.

import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEndState, routingOf, type GasLine, type OrderStatus, type OrderView } from "../shared/api.ts";
import { awaitsDeposit, GAS_MISMATCH, GAS_NOT_ADDED, gasBelongs, gasKept, gasLookAgain, gasOrderFor, gasOrderOf, gasPlaced, gasPollDelay, gasWords, lookAgain, pageTitle, pollDelay, tabTitle, TWO_TRANSFERS } from "../web/src/lib/order-logic.ts";
import { DepositDetails, GasAlone, OrderContent } from "../web/src/pages/OrderPage.tsx";
import { useApp } from "../web/src/stores/app.ts";
import { useGhost } from "../web/src/stores/ghost.ts";
import { NEVER } from "./words.ts";

const root = path.resolve("web", "src");
const source = (file: string) => fs.readFileSync(path.join(root, ...file.split("/")), "utf8");
/** A file's code without its comments, with every run of blank space made one space: a sentence of code is found whatever its line breaks and whatever is written beside it. */
const squeezed = (file: string) =>
  source(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");

// ---- The two orders ----
// Example addresses and hashes, made up from fixed text: they are nobody's.
const SOL_ADDRESS = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";
const EVM_ADDRESS = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
const SWAP_DEPOSIT = "0x45E97fE65F23486718e25eBf23A6EFBaFe8388e1";
const GAS_DEPOSIT = "0x49195b6fEBa539EA20481AE9049eFCc59145bB86";
const SWAP_HASH = "0xb00c146bf7c9d9bc6303c3f011a766d66befeb47b4e9c2eba3112e496fbfa5af";
const GAS_HASH = "0x7fce8ef002b9a1a7c746d08dbf4164b2771bc17a6e1eb742d7c0ef986bbc9a16";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** Two more of each kind, for an order that goes somewhere else. */
const OTHER_SOL = "G5pvsDJuFhwa5ddLvSodg5PDCfhGipPWURq6jGEoycpW";
const OTHER_EVM = "0x3b1c431E2318a0aA3e5311caeC1EDe14F35e73F6";
const NOW = Date.parse("2026-10-10T12:10:00.000Z");
const SWAP_ID = "Ex4mpleSwapIdForTheGasTests";
const GAS_ID = "Ex4mpleGasIdForTheGasTests0";
/** What each is paid: half an ETH for the swap, and about three dollars of ETH for the gas. */
const SWAP_AMOUNT = "500000000000000000";
const GAS_AMOUNT = "1185650000000000";

const STATUSES: OrderStatus[] = ["waiting", "deposit_seen", "swapping", "delivered", "deposit_too_small", "refunded", "failed", "expired"];

/** The swap: ETH on Base for USDT on Solana, waiting for its deposit, unless a test says otherwise. */
function swap(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: SWAP_ID,
    status: "waiting",
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    statusSince: new Date(NOW - 60_000).toISOString(),
    pay: "manual",
    from: { id: "base:ETH", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
    to: { id: "sol:USDT", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "x" },
    amountIn: SWAP_AMOUNT,
    amountOut: "1260079171",
    minAmountOut: "1247478379",
    amountInUsd: "1265.13",
    amountOutUsd: "1259.33",
    slippageBps: 100,
    timeEstimate: 34,
    fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1000000000000000" },
    withdrawFee: null,
    refundFee: null,
    recipient: SOL_ADDRESS,
    refundTo: EVM_ADDRESS,
    routing: routingOf("basic"),
    depositAddress: SWAP_DEPOSIT,
    depositMemo: null,
    depositsOpen: true,
    deadline: new Date(NOW + 3_000_000).toISOString(),
    depositTxHash: null,
    depositProven: false,
    depositTxUrl: null,
    details: null,
    serverNow: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/** The gas order beside it: a little of the same ETH for SOL, to the same Solana address, with an ID, an amount and a deposit address of its own. */
function gasOrder(overrides: Partial<OrderView> = {}): OrderView {
  return swap({
    id: GAS_ID,
    gasOrder: true,
    to: { id: "sol:SOL", symbol: "SOL", name: "Solana", chain: "sol", decimals: 9, contract: null },
    amountIn: GAS_AMOUNT,
    amountOut: "20145310",
    minAmountOut: "19943856",
    amountInUsd: "3.00",
    amountOutUsd: "2.97",
    fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "2371300000000" },
    depositAddress: GAS_DEPOSIT,
    ...overrides,
  });
}

/** An order that has been paid: nothing more is sent to it. */
const PAID = { depositProven: true, depositAddress: null, depositsOpen: false } as const;
const details = (extra: Partial<NonNullable<OrderView["details"]>> = {}): NonNullable<OrderView["details"]> => ({ originTxs: [], destinationTxs: [], depositedAmount: null, amountIn: null, amountOut: null, refundedAmount: null, refundReason: null, ...extra });
/** The line as it reads while the gas order's record is there. */
const line = (overrides: Partial<OrderView> = {}): GasLine => ({ made: true, order: gasOrder(overrides) });
/** The swap as the server sends it where gas was asked for with it. */
const withGas = (gas: GasLine, overrides: Partial<OrderView> = {}): OrderView => swap({ gas, ...overrides });
// ---- Drawing ----
interface Held {
  /** Whether Ghost mode is on in the tab that draws. Off unless a test says so. */
  ghost?: boolean;
}

/**
 * A part of the site as it is first drawn. Drawn here, outside a browser, a component reads each
 * store's first state, so what the drawing needs is put there for its length and taken away again.
 */
function draw(element: () => ReactElement, held: Held = {}): string {
  const wanted: [{ getInitialState(): object }, Record<string, unknown>][] = [
    [useGhost, { on: held.ghost === true }],
    [useApp, { config: null }],
  ];
  const before = wanted.map(([store, values]) => {
    const first = store.getInitialState() as Record<string, unknown>;
    const kept = Object.fromEntries(Object.keys(values).map((key) => [key, first[key]]));
    Object.assign(first, values);
    return [first, kept] as const;
  });
  useGhost.setState({ on: held.ghost === true });
  try {
    return renderToStaticMarkup(element());
  } finally {
    for (const [first, kept] of before) Object.assign(first, kept);
    useGhost.setState({ on: false });
  }
}

/** A swap's page. */
const page = (example: OrderView, held: Held & { gone?: boolean; contact?: string | null } = {}) =>
  draw(() => createElement(OrderContent, { order: example, now: NOW, reconnecting: false, contact: held.contact ?? null, onOrder: () => undefined, privacyMode: "basic", gone: held.gone === true }), held);
/** What a fresh load of a deleted swap's link shows of its gas order. */
const alone = (gas: GasLine, held: Held = {}) => draw(() => createElement(GasAlone, { gas, now: NOW, reconnecting: false, contact: null, onGas: () => undefined }), held);

/** One element of a drawn page, whole: from the tag it opens with to the tag that closes it. Empty when the page has no such element. */
function element(markup: string, opening: string): string {
  const start = markup.indexOf(opening);
  if (start === -1) return "";
  const tag = /^<([a-z0-9]+)/.exec(opening)?.[1] ?? "div";
  const marks = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  marks.lastIndex = start;
  let depth = 0;
  for (let mark = marks.exec(markup); mark !== null; mark = marks.exec(markup)) {
    depth += mark[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return markup.slice(start, mark.index + mark[0].length);
  }
  return "";
}
/** The words of a piece of markup, as they are read. */
const words = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
/** Every address drawn in full, as it would be read off the screen. */
const addresses = (markup: string) => [...markup.matchAll(/<span class="address mono" translate="no">(.*?<\/span>[^<]*<span class="address-end">[^<]*<\/span>)<\/span>/g)].map((match) => (match[1] ?? "").replace(/<[^>]+>/g, ""));
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((button) => words(button[0]));

const SWAP_BLOCK = '<section class="deposit" aria-labelledby="deposit-title">';
const GAS_BLOCK = '<section class="deposit" aria-labelledby="gas-deposit-title">';
const GAS_LINE = '<div class="gas-line"';
const gasRow = (markup: string) => element(markup, GAS_LINE);
/** The note an order made in Ghost mode carries under its title, as it is seen: without the part drawn only to keep its room. */
const UNSEEN = '<div class="order-ghost-state" data-unseen="true" aria-hidden="true" inert="">';
const note = (markup: string) => element(markup.replace(element(markup, UNSEEN) || "\u0000", ""), '<div class="order-ghost" role="note">');

beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://saplingdex.example", search: "" } }));
afterEach(() => vi.unstubAllGlobals());

// ---- The gas line ----
describe("the gas line's words", () => {
  /** What the line says for each state a gas order can be in, word for word. */
  const SAID: Record<OrderStatus, { mark: string; state: string; text: string }> = {
    waiting: { mark: "current", state: "Waiting", text: "Waiting for its deposit." },
    deposit_seen: { mark: "current", state: "Seen", text: "Its deposit was seen. Waiting for confirmations." },
    swapping: { mark: "current", state: "Swapping", text: "Its deposit is confirmed. Swapping it for SOL." },
    delivered: { mark: "done", state: "Delivered", text: "0.02014531 SOL sent to DZrFMB…QtAWjP." },
    deposit_too_small: { mark: "stopped", state: "Deposit too small", text: "Less than 0.00118565 ETH arrived. It is returned to your refund address by the deadline. Nothing more needs sending." },
    refunded: { mark: "stopped", state: "Refunded", text: "The gas could not be delivered. Your ETH was returned to your refund address, 0xdbF0…C8C6FB, on Base." },
    failed: { mark: "stopped", state: "Failed", text: "The gas could not be delivered. Keep this page's link and its deposit transaction hash, and contact support." },
    expired: { mark: "stopped", state: "Ran out", text: "It ran out unpaid: nothing was sent to it and nothing is lost." },
  };

  it("says every state a gas order can be in, in plain words", () => {
    expect(Object.keys(SAID).sort()).toEqual([...STATUSES].sort());
    for (const status of STATUSES) expect(gasWords(line({ status }), NOW), status).toEqual(SAID[status]);
    // The five the line is asked to tell apart, by the words a person looks for.
    expect([SAID.waiting.state, SAID.deposit_seen.state, SAID.delivered.state, SAID.refunded.state, SAID.expired.state]).toEqual(["Waiting", "Seen", "Delivered", "Refunded", "Ran out"]);
    // No two states read alike.
    expect(new Set(STATUSES.map((status) => SAID[status].state)).size).toBe(STATUSES.length);
    expect(new Set(STATUSES.map((status) => SAID[status].text)).size).toBe(STATUSES.length);
  });

  it("gives what really arrived, was refunded or came short, where the provider says", () => {
    expect(gasWords(line({ status: "delivered", details: details({ amountOut: "20151200" }) }), NOW).text).toBe("0.0201512 SOL sent to DZrFMB…QtAWjP.");
    expect(gasWords(line({ status: "refunded", details: details({ refundedAmount: "1183000000000000", refundReason: "SLIPPAGE_EXCEEDED" }) }), NOW).text).toBe("The price moved beyond the limit you accepted. 0.001183 ETH was returned to your refund address, 0xdbF0…C8C6FB, on Base.");
    expect(gasWords(line({ status: "deposit_too_small", details: details({ depositedAmount: "1000000000000000" }) }), NOW).text).toBe("0.001 of 0.00118565 ETH arrived. It is returned to your refund address by the deadline. Nothing more needs sending.");
    // A reason the page does not know is never shown as the provider wrote it.
    const unknown = gasWords(line({ status: "refunded", details: details({ refundReason: "SOME_NEW_CODE" }) }), NOW);
    expect(unknown.text).toBe(SAID.refunded.text);
  });

  it("a gas order that ran out unpaid says that nothing was sent to it and nothing is lost; one a transaction was named for does not", () => {
    expect(gasWords(line({ status: "expired" }), NOW).text).toBe("It ran out unpaid: nothing was sent to it and nothing is lost.");
    const named = gasWords(line({ status: "expired", depositTxHash: GAS_HASH }), NOW);
    expect(named).toEqual({ mark: "stopped", state: "Ran out", text: "No deposit was confirmed before its deadline. Keep this page's link and its deposit transaction hash, and contact support." });
    expect(named.text).not.toMatch(/nothing is lost|nothing was sent/);
  });

  it("tells nobody to contact support where no contact is published", () => {
    for (const example of [line({ status: "failed" }), line({ status: "expired", depositTxHash: GAS_HASH })]) {
      expect(gasWords(example, NOW, true).text).toMatch(/, and contact support\.$/);
      expect(gasWords(example, NOW, false).text).toMatch(/its deposit transaction hash\.$/);
      expect(gasWords(example, NOW, false).text).not.toMatch(/support/i);
    }
  });

  it("stops saying that it waits once its deposit is closed, two minutes before its own deadline", () => {
    const waiting = line();
    const deadline = Date.parse(gasOrderOf(waiting)!.deadline);
    expect(gasWords(waiting, deadline - 120_001).text).toBe("Waiting for its deposit.");
    expect(gasWords(waiting, deadline - 120_000)).toEqual({ mark: "current", state: "Waiting", text: "Its deposit is closed. Checking whether one arrived." });
    expect(gasWords(line({ depositsOpen: false, depositAddress: null }), NOW).text).toBe("Its deposit is closed. Checking whether one arrived.");
  });

  it("where gas could not be added: one line, and that the swap is unaffected", () => {
    expect(GAS_NOT_ADDED).toBe("Gas was not added. Your swap is unaffected.");
    expect(gasWords({ made: false }, NOW)).toEqual({ mark: "stopped", state: null, text: "Gas was not added. Your swap is unaffected." });
  });

  it("a gas order made in Ghost mode that has finished: how it ended, and that its record was deleted", () => {
    expect(gasWords({ made: true, order: null, ended: "delivered" }, NOW)).toEqual({ mark: "done", state: "Delivered", text: "It was delivered. It was made in Ghost mode, so its record was deleted when it finished." });
    expect(gasWords({ made: true, order: null, ended: "refunded" }, NOW)).toEqual({ mark: "stopped", state: "Refunded", text: "It was refunded. It was made in Ghost mode, so its record was deleted when it finished." });
    expect(gasWords({ made: true, order: null, ended: "expired" }, NOW)).toEqual({ mark: "stopped", state: "Ran out", text: "It ran out without being paid. It was made in Ghost mode, so its record was deleted when it finished." });
  });

  it("uses none of the words the site never uses, whatever the line says", () => {
    const all: GasLine[] = [{ made: false }, { made: true, order: null, ended: "delivered" }, { made: true, order: null, ended: "refunded" }, { made: true, order: null, ended: "expired" }, ...STATUSES.map((status) => line({ status })), line({ status: "expired", depositTxHash: GAS_HASH })];
    for (const example of all) {
      const said = gasWords(example, NOW);
      expect(NEVER.test(`${said.state ?? ""} ${said.text}`), said.text).toBe(false);
      expect(`${said.state ?? ""} ${said.text}`).not.toMatch(/coming soon|not yet|\bearn|yield|APR|\breturns\b/i);
    }
    for (const sentence of [TWO_TRANSFERS, GAS_NOT_ADDED, GAS_MISMATCH]) {
      expect(sentence.length).toBeGreaterThan(10);
      expect(NEVER.test(sentence), sentence).toBe(false);
    }
  });
});

describe("the gas line on a swap's page", () => {
  it("stands beneath the swap's four steps and its transactions, with about what arrives and its own state", () => {
    const markup = page(withGas(line(), { status: "swapping", ...PAID, depositTxHash: SWAP_HASH, details: details({ originTxs: [{ hash: SWAP_HASH, url: null }] }) }));
    // The swap's four steps are as ever.
    expect([...markup.matchAll(/<p class="step-title">([^<]*)<\/p>/g)].map((step) => step[1])).toEqual(["Waiting for deposit", "Deposit seen", "Swapping", "Delivered"]);
    expect(markup.match(/<li class="step"/g)).toHaveLength(4);
    const row = gasRow(markup);
    expect(row).toMatch(/^<div class="gas-line" data-state="current"><span class="step-mark" data-state="current">/);
    expect(row).toContain('<span class="step-title">Gas</span>');
    expect(row).toMatch(/<span class="muted">about <span class="amount mono" title="0\.02014531 SOL">/);
    expect(row).toContain('<span class="gas-line-state">Waiting</span>');
    expect(row).toContain('<p class="step-text muted">Waiting for its deposit.</p>');
    // One line, after the steps and after the swap's own deposit link.
    expect(markup.match(/class="gas-line"/g)).toHaveLength(1);
    expect(markup.indexOf(GAS_LINE)).toBeGreaterThan(markup.indexOf("</ol>"));
    expect(markup.indexOf(GAS_LINE)).toBeGreaterThan(markup.indexOf('<p class="order-tx">'));
    expect(markup.indexOf(GAS_LINE)).toBeLessThan(markup.indexOf("Order details"));
  });

  it("draws every state, and names an amount to come only while it may still come", () => {
    for (const status of STATUSES) {
      const example = line({ status, ...(status === "waiting" ? {} : PAID) });
      const said = gasWords(example, NOW, false);
      const row = gasRow(page(withGas(example, { status: "swapping", ...PAID })));
      expect(row, status).toContain(`<div class="gas-line" data-state="${said.mark}">`);
      expect(row, status).toContain(`<span class="gas-line-state">${said.state}</span>`);
      expect(words(row), status).toContain(said.text);
      expect(/<span class="muted">about /.test(row), status).toBe(said.mark === "current");
    }
  });

  it("once delivered, links the gas order's own deposit and delivery, as the swap's are linked", () => {
    const delivery = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const done = line({ status: "delivered", ...PAID, depositTxHash: GAS_HASH, depositTxUrl: `https://basescan.org/tx/${GAS_HASH}`, details: details({ destinationTxs: [{ hash: delivery, url: `https://solscan.io/tx/${delivery}` }], amountOut: "20151200" }) });
    const row = gasRow(page(withGas(done, { status: "delivered", ...PAID })));
    expect(row).toContain('<div class="gas-line" data-state="done">');
    expect(words(row)).toContain("Gas Delivered 0.0201512 SOL sent to DZrFMB…QtAWjP.");
    expect(row).toContain(`<span class="muted">Gas deposit</span><a class="order-tx-link" href="https://basescan.org/tx/${GAS_HASH}"`);
    expect(row).toContain(`<span class="muted">Gas delivery</span><a class="order-tx-link" href="https://solscan.io/tx/${delivery}"`);
    // Where the explorer is not known the hash stands without a link, as the swap's does.
    const plain = gasRow(page(withGas(line({ status: "delivered", ...PAID, details: details({ destinationTxs: [{ hash: delivery, url: null }] }) }), { status: "delivered", ...PAID })));
    expect(plain).toContain('<span class="muted">Gas delivery</span><span class="mono order-tx-plain">5VERv8NMvz…SZkQUW</span>');
  });

  it("where gas was not added, is that one sentence and nothing else of gas", () => {
    const markup = page(withGas({ made: false }));
    expect(gasRow(markup)).toMatch(/^<div class="gas-line" data-state="stopped"><span class="step-mark" data-state="stopped">.*?<\/span><div class="step-body"><p class="step-text">Gas was not added\. Your swap is unaffected\.<\/p><\/div><\/div>$/);
    expect(markup).not.toMatch(/gas-line-head|gas-deposit-title|gas-pay-title|gas-tx-hash|pay-pair|Gas order details/);
    // The swap itself is paid, followed and shown as any order is.
    expect(words(element(markup, SWAP_BLOCK))).toMatch(/^Send your deposit /);
    expect(words(markup)).toContain("Already sent? Add the transaction hash");
  });

  it("where the gas order's record is deleted first, says how it ended, and the swap carries on", () => {
    const markup = page(withGas({ made: true, order: null, ended: "delivered" }, { ghost: true, status: "swapping", ...PAID }));
    expect(words(gasRow(markup))).toBe("Done: Gas Delivered It was delivered. It was made in Ghost mode, so its record was deleted when it finished.");
    expect(markup.match(/<li class="step" data-state="current"/g)).toHaveLength(1);
    expect(markup).not.toMatch(/gas-deposit-title|gas-pay-title|gas-tx-hash|Gas order details/);
  });

  it("an order that gas was never asked for has no such line: its page is as it always was", () => {
    for (const example of [swap(), swap({ status: "swapping", ...PAID }), swap({ status: "delivered", ...PAID })]) {
      const markup = page(example);
      expect(markup, example.status).not.toMatch(/gas-line|gas-deposit-title|gas-pay-title|gas-tx-hash|pay-pair/);
      expect(words(markup), example.status).not.toMatch(/\bgas\b/i);
    }
    expect(words(element(page(swap()), SWAP_BLOCK))).toMatch(/^Send your deposit /);
    expect(words(page(swap())).endsWith(`Order ${SWAP_ID} . Keep this page's link: it is the only way back to this order.`)).toBe(true);
  });
});

// ---- Looking again ----
describe("looking again at a swap with gas", () => {
  const LINES: (GasLine | null | undefined)[] = [undefined, null, { made: false }, { made: true, order: null, ended: "delivered" }, ...STATUSES.map((status) => line({ status }))];

  it("goes on until both orders have ended, and stops then", () => {
    for (const swapStatus of STATUSES) {
      for (const gas of LINES) {
        const gasStatus = gasOrderOf(gas)?.status ?? null;
        const bothEnded = isEndState(swapStatus) && (gasStatus === null || isEndState(gasStatus));
        const wait = lookAgain(pollDelay(swapStatus, 0), gas);
        expect(wait === null, `${swapStatus} / ${gasStatus ?? "no gas order"}`).toBe(bothEnded);
      }
    }
    // The page's own walk through a swap that is delivered while its gas order still waits.
    const walk: [OrderStatus, OrderStatus][] = [["waiting", "waiting"], ["swapping", "waiting"], ["delivered", "waiting"], ["delivered", "deposit_seen"], ["delivered", "swapping"], ["delivered", "delivered"]];
    expect(walk.map(([swapStatus, gasStatus]) => lookAgain(pollDelay(swapStatus, 0), line({ status: gasStatus })))).toEqual([5000, 5000, 5000, 5000, 5000, null]);
    // And the other way about: the gas order ends first, and the swap is followed to its own end as ever.
    expect((["waiting", "swapping", "delivered"] as const).map((swapStatus) => lookAgain(pollDelay(swapStatus, 0), line({ status: "expired" })))).toEqual([5000, 5000, null]);
  });

  it("looks as soon as the sooner of the two asks, and for an order with no gas exactly as before", () => {
    // A gas order waiting for a refund is looked at slowly; a running swap beside it keeps the page's own pace.
    expect(lookAgain(pollDelay("swapping", 0), line({ status: "deposit_too_small" }))).toBe(5000);
    expect(lookAgain(pollDelay("delivered", 0), line({ status: "deposit_too_small" }))).toBe(30_000);
    expect(lookAgain(pollDelay("deposit_too_small", 0), line({ status: "swapping" }))).toBe(5000);
    for (const swapStatus of STATUSES) for (const none of [undefined, null, { made: false } as const]) expect(lookAgain(pollDelay(swapStatus, 0), none)).toBe(pollDelay(swapStatus, 0));
    expect(gasPollDelay(line())).toBe(5000);
    for (const none of [undefined, null, { made: false } as const, { made: true, order: null, ended: "expired" } as const, line({ status: "delivered" })]) expect(gasPollDelay(none)).toBeNull();
  });

  it("the page asks by that rule, after the swap's own, and keeps what it last knew of the gas order", () => {
    const code = source("pages/OrderPage.tsx");
    // The swap's own wait, the few more looks at an ended Ghost mode swap, and then the gas order's say.
    expect(squeezed("pages/OrderPage.tsx")).toContain("next = pollDelay(fresh.status, 0); if (next === null && fresh.ghost === true) next = ghostLookAgain(looksAfterEnd++); next = lookAgain(next, fresh.gas); } catch (err) {");
    expect(code).toContain("        setGas((before) => gasKept(before, fresh.gas));");
    expect(code).toMatch(/setOrder\(null\);\s*setMissing\(false\);\s*setDeleted\(false\);\s*setEndedAs\(null\);\s*setGas\(null\);/);
    // What an answer says of the gas order stands; an answer that says nothing leaves what was known.
    const known = line({ status: "swapping" });
    expect(gasKept(null, known)).toBe(known);
    expect(gasKept(known, { made: true, order: null, ended: "delivered" })).toEqual({ made: true, order: null, ended: "delivered" });
    expect(gasKept(known, undefined)).toBe(known);
    expect(gasKept(known, null)).toBe(known);
    expect(gasKept(null, undefined)).toBeNull();
    // The tab's title and the swap's own state stay the swap's.
    expect(code).toContain("    document.title = tabTitle(order);");
    expect(tabTitle(withGas(line({ status: "delivered" })))).toBe("Order · SaplingDex");
    expect(tabTitle(withGas(line({ status: "expired" }), { status: "delivered" }))).toBe("Delivered · SaplingDex");
  });

  it("a fresh view of the gas order goes into the gas line, and only a view of that very order", () => {
    const known = line();
    const fresh = gasOrder({ status: "deposit_seen", depositTxHash: GAS_HASH });
    expect(gasPlaced(known, fresh)).toEqual({ made: true, order: fresh });
    // The swap's own view, or any other order's, never lands in the gas line.
    expect(gasPlaced(known, swap())).toBe(known);
    expect(gasPlaced(known, gasOrder({ id: "AnotherOrderAltogether000001" }))).toBe(known);
    for (const none of [null, { made: false } as const, { made: true, order: null, ended: "delivered" } as const]) expect(gasPlaced(none, fresh)).toBe(none);
    expect(source("pages/OrderPage.tsx")).toContain("  const placeGas = (view: OrderView) => setGas((line) => gasPlaced(line, view));");
  });
});

describe("a Ghost mode swap whose record is deleted while its gas order is still known", () => {
  const code = source("pages/OrderPage.tsx");
  const flat = squeezed("pages/OrderPage.tsx");

  it("keeps looking for the gas order's sake until that is gone too, and then stops", () => {
    // While the gas order runs it is looked at as any running order is.
    for (const status of ["waiting", "deposit_seen", "swapping"] as const) for (const looks of [0, 3, 50]) expect(gasLookAgain(line({ status, ghost: true }), looks), status).toBe(5000);
    expect(gasLookAgain(line({ status: "deposit_too_small", ghost: true }), 0)).toBe(30_000);
    // Once it has ended and its record is still there, a few more looks, to learn that the record has gone.
    for (const status of ["delivered", "refunded", "failed", "expired"] as const) {
      expect([0, 1, 2, 3, 4].map((looks) => gasLookAgain(line({ status, ghost: true }), looks)), status).toEqual([2000, 5000, 10_000, 20_000, 30_000]);
      for (const looks of [5, 6, 50]) expect(gasLookAgain(line({ status, ghost: true }), looks), status).toBeNull();
    }
    // Once nothing is left of it but a word, or nothing at all, there is nothing to look for.
    for (const none of [undefined, null, { made: false } as const, { made: true, order: null, ended: "delivered" } as const]) expect(gasLookAgain(none, 0)).toBeNull();
  });

  it("the page takes the gas line from the answer that the swap's record is deleted, and looks again by that rule", () => {
    expect(flat).toContain(
      'const beside = err instanceof ApiError && err.code === "order_deleted" ? err.gas : null; if (beside !== null) { failures.current = 0; setGas(beside); const gasOrder = gasOrderOf(beside); if (gasOrder !== null) useApp.setState({ clockOffset: Date.parse(gasOrder.serverNow) - Date.now() }); const again = gasLookAgain(beside, gasLooksAfterEnd); if (gasPollDelay(beside) === null) gasLooksAfterEnd += 1; if (again !== null) timer = setTimeout(() => void look(), again); } if (err instanceof ApiError && err.code === "order_deleted") {',
    );
    // The swap is still told as deleted, exactly as before; the answer about the gas order is read first.
    expect(code.indexOf("const beside = err instanceof ApiError")).toBeLessThan(code.indexOf("setDeleted(true);"));
    expect(code.indexOf("const beside = err instanceof ApiError")).toBeLessThan(code.indexOf("failures.current += 1;"));
  });

  it("a fresh load of the link shows the notice for the swap and, beneath it, the gas order: the link is still the one way back to it", () => {
    expect(flat).toContain("if (deleted && order === null && gas !== null) { return ( <> <OrderDeleted ended={endedAs} /> <GasAlone gas={gas} now={now} reconnecting={reconnecting} contact={contact} onGas={placeGas}> {controls} </GasAlone> </> ); }");
    // Before the notice that stands alone, which is what a deleted swap with no gas order known still gets.
    expect(code.indexOf("if (deleted && order === null && gas !== null) {")).toBeLessThan(code.indexOf("if (deleted && order === null) return <OrderDeleted ended={endedAs} />;"));
    expect(code.indexOf("if (deleted && order === null && gas !== null) {")).toBeGreaterThan(code.indexOf("if (missing) {"));

    const markup = alone(line({ ghost: true }));
    expect(markup).toMatch(/^<section class="order" aria-labelledby="gas-alone-title"><header class="gas-alone-head"><h2 id="gas-alone-title" class="order-subtitle">Gas order<\/h2><p class="muted">Made with the swap above, and an order of its own\. This page&#x27;s link is the only way back to it\.<\/p><\/header>/);
    // Its deposit is still on show, with its own amount, and its line, its hash field and its details.
    const block = element(markup, GAS_BLOCK);
    expect(words(block)).toMatch(/^Gas deposit 48:00 left to send, until \d\d:\d\d Send only ETH, only on Base, and exactly this amount\. Anything else may be lost\. Amount 0\.00118565 ETH Copy the amount Network Base I'm sending on Base Tick the box to see the deposit address\.$/);
    expect(words(gasRow(markup))).toBe("Now: Gas about 0.02014 SOL 0.02014531 SOL Waiting Waiting for its deposit.");
    expect(words(markup)).toContain("Already sent the gas? Add its transaction hash");
    expect(words(markup)).toContain("Gas order details");
    expect(words(markup).endsWith(`Gas order ${GAS_ID} .`)).toBe(true);
    // Nothing of the swap is drawn: nothing of it is kept.
    expect(markup).not.toContain(SWAP_ID);
    expect(words(markup)).not.toMatch(/0\.5 ETH|USDT|Swap deposit|two separate transfers/);
    // In order: what to pay, how it stands, the shortcut, the details.
    expect(markup.indexOf(GAS_BLOCK)).toBeLessThan(markup.indexOf(GAS_LINE));
    expect(markup.indexOf(GAS_LINE)).toBeLessThan(markup.indexOf('id="gas-tx-hash"'));
  });

  it("once the gas order has moved on, takes its deposit away and goes on telling its state; once it is gone too, says how it ended", () => {
    const swapping = alone(line({ ghost: true, status: "swapping", ...PAID }));
    expect(swapping).not.toMatch(/gas-deposit-title|gas-tx-hash/);
    expect(words(gasRow(swapping))).toBe("Now: Gas about 0.02014 SOL 0.02014531 SOL Swapping Its deposit is confirmed. Swapping it for SOL.");
    const gone = alone({ made: true, order: null, ended: "refunded" });
    expect(words(gone)).toBe("Gas order Made with the swap above, and an order of its own. Stopped: Gas Refunded It was refunded. It was made in Ghost mode, so its record was deleted when it finished.");
    expect(buttons(gone)).toEqual([]);
  });

  it("a page that was showing the swap keeps what it showed of it, and the gas order beneath stays as it stands", () => {
    const delivered = withGas(line({ ghost: true }), { ghost: true, status: "delivered", ...PAID, depositTxHash: SWAP_HASH });
    const markup = page(delivered, { gone: true });
    expect(words(markup)).toContain("This order has finished and its record has been deleted from the server.");
    // The gas order is still to be paid, and still can be: its deposit, its line and its hash field are there.
    expect(words(element(markup, GAS_BLOCK))).toMatch(/^Gas deposit .* Amount 0\.00118565 ETH /);
    expect(words(gasRow(markup))).toContain("Waiting for its deposit.");
    expect(markup).toContain('id="gas-tx-hash"');
    // A swap that was itself still waiting has nothing more sent to it, while the gas order's own deposit stays open.
    const waiting = page(withGas(line({ ghost: true }), { ghost: true }), { gone: true });
    expect(words(waiting)).toContain("Deposits for this order are closed. Do not send now: a payment sent after the deadline may be lost.");
    expect(waiting).not.toContain(SWAP_BLOCK);
    expect(waiting).not.toContain('id="tx-hash"');
    expect(waiting).toContain(GAS_BLOCK);
  });

  describe("the note of a swap whose record is deleted says the truth of its link", () => {
    const ALL_THAT_IS_LEFT = "This order has finished and its record has been deleted from the server. This page is all that is left of it; it will not load again.";
    const GAS_STILL_OPEN = "This order has finished and its record has been deleted from the server. Its gas order is still open, below. This page's link is the way back to it until that has finished too.";
    const ENDING_NOT_SEEN = "How it ended was not seen here. If you sent the deposit, look for the delivery at your receiving address, or for a refund at your refund address: both are in the order details below.";
    /** A delivered Ghost mode swap, with what is known of its gas order, on a page that was showing it when its record went. */
    const gone = (gas?: GasLine, overrides: Partial<OrderView> = {}) => page(swap({ ghost: true, status: "delivered", ...PAID, depositTxHash: SWAP_HASH, ...(gas === undefined ? {} : { gas }), ...overrides }), { gone: true });

    it("with no gas order known, it is all that is left and will not load again, as ever", () => {
      expect(words(note(gone()))).toBe(ALL_THAT_IS_LEFT);
      // Gas that was never added is no gas order, and one that has gone too leaves nothing to come back to but how it ended.
      expect(words(note(gone({ made: false })))).toBe(ALL_THAT_IS_LEFT);
      for (const ended of ["delivered", "refunded", "expired"] as const) expect(words(note(gone({ made: true, order: null, ended }))), ended).toBe(ALL_THAT_IS_LEFT);
    });

    it("while its gas order is still open beneath it, says that the link is the way back to that, and never that the page will not load again", () => {
      for (const status of ["waiting", "deposit_seen", "swapping", "deposit_too_small"] as const) {
        const markup = gone(line({ ghost: true, status, ...(status === "waiting" ? {} : PAID) }));
        expect(words(note(markup)), status).toBe(GAS_STILL_OPEN);
        expect(words(markup), status).not.toMatch(/will not load again|all that is left/);
        // What it points to is there: the gas order's line, beneath.
        expect(markup.indexOf(GAS_LINE), status).toBeGreaterThan(markup.indexOf('class="order-ghost"'));
      }
      expect(note(gone(line({ ghost: true })))).toContain('<p class="order-ghost-sub muted">Its gas order is still open, below. This page&#x27;s link is the way back to it until that has finished too.</p>');
      // Where the page had not seen how the swap ended, it still says that, after it.
      const unseen = page(swap({ ghost: true, status: "swapping", ...PAID, gas: line({ ghost: true }) }), { gone: true });
      expect(words(note(unseen))).toBe(`${GAS_STILL_OPEN} ${ENDING_NOT_SEEN}`);
    });

    it("once the gas order has ended too, is as it was", () => {
      for (const status of ["delivered", "refunded", "failed", "expired"] as const) expect(words(note(gone(line({ ghost: true, status, ...PAID })))), status).toBe(ALL_THAT_IS_LEFT);
    });

    it("says nothing of a gas order while the swap's own record is there, and points to none that is not the swap's own", () => {
      const kept = page(withGas(line({ ghost: true }), { ghost: true }));
      expect(words(note(kept))).toBe("This is the only way back to this order. It is not saved anywhere. Its record is deleted from this site's server the moment it is delivered or refunded. Copy link to this order");
      expect(words(note(gone(line({ ghost: true, recipient: OTHER_SOL }))))).toBe(ALL_THAT_IS_LEFT);
      expect(source("pages/OrderPage.tsx")).toContain("      {ghost ? <GhostNote link={link} gone={gone} ended={end !== null} how={how} gasOpen={gasOrder !== null && gasPollDelay(gas) !== null} /> : null}");
    });
  });

  it("the page's clock runs on for a gas order that is still running, and stops with it", () => {
    expect(flat).toContain("const gasRunsOn = deleted && gasPollDelay(gas) !== null; useEffect(() => { if (!gasRunsOn) return; const timer = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(timer); }, [gasRunsOn]);");
  });
});

// ---- Paying by deposit address ----
describe("paying a swap with gas by deposit address", () => {
  it("shows the swap's deposit and, beneath it, the gas deposit: each named, each with its own amount and time left", () => {
    const markup = page(withGas(line()));
    const swapBlock = element(markup, SWAP_BLOCK);
    const gasBlock = element(markup, GAS_BLOCK);
    expect(words(swapBlock)).toMatch(/^Swap deposit 48:00 left to send, until \d\d:\d\d Send only ETH, only on Base, and exactly this amount\. Anything else may be lost\. Amount 0\.5 ETH Copy the amount Network Base I'm sending on Base Tick the box to see the deposit address\.$/);
    expect(words(gasBlock)).toMatch(/^Gas deposit 48:00 left to send, until \d\d:\d\d Send only ETH, only on Base, and exactly this amount\. Anything else may be lost\. Amount 0\.00118565 ETH Copy the amount Network Base I'm sending on Base Tick the box to see the deposit address\.$/);
    // Neither names the other's amount, and the swap's comes first.
    expect(words(swapBlock)).not.toContain("0.00118565");
    expect(words(gasBlock)).not.toContain("0.5 ETH");
    expect(markup.indexOf(SWAP_BLOCK)).toBeLessThan(markup.indexOf(GAS_BLOCK));
    expect(markup.indexOf(GAS_BLOCK)).toBeLessThan(markup.indexOf('<ol class="steps">'));
    // Two headings, two names: nothing on the page is named twice.
    const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["deposit-title", "gas-deposit-title", "tx-hash", "gas-tx-hash"]));
  });

  it("says, above the two, that they are two separate transfers and must not be combined", () => {
    expect(TWO_TRANSFERS).toBe("These are two separate transfers. Send each to its own address; do not combine them.");
    const markup = page(withGas(line()));
    expect(markup.match(/<p class="pay-pair">/g)).toHaveLength(1);
    expect(markup).toContain(`<p class="pay-pair">${TWO_TRANSFERS}</p>${SWAP_BLOCK}`);
  });

  it("each block shows its own order's address, amount, Copy buttons and QR code, and never the other's", () => {
    const block = (order: OrderView, part: "swap" | "gas") => draw(() => createElement(DepositDetails, { order, now: NOW, ticked: true, part }));
    const swapBlock = block(swap(), "swap");
    const gasBlock = block(gasOrder(), "gas");
    expect(addresses(swapBlock)).toEqual([SWAP_DEPOSIT]);
    expect(addresses(gasBlock)).toEqual([GAS_DEPOSIT]);
    for (const drawn of [swapBlock, gasBlock]) {
      expect(buttons(drawn)).toEqual(["Copy the amount", "Copy the deposit address"]);
      expect(drawn).toContain('aria-label="QR code of the deposit address on Base"');
    }
    expect(words(gasBlock)).toContain("Amount 0.00118565 ETH");
    expect(words(swapBlock)).toContain("Amount 0.5 ETH");
    // On the page each block is handed its own order, and nothing else.
    const code = source("pages/OrderPage.tsx");
    expect(code).toContain('  return <DepositDetails order={gasOrder} now={now} part="gas" />;');
    expect(code.match(/<DepositDetails order=\{order\} now=\{now\} part=\{part\} \/>/g)).toHaveLength(1);
    expect(code.match(/<DepositDetails /g)).toHaveLength(2);
  });

  it("each block closes by itself: by its own deadline, and when its own order is paid", () => {
    // The gas order's deposit has closed and the swap's has not.
    const gasClosed = page(withGas(line({ depositsOpen: false, depositAddress: null })));
    expect(words(element(gasClosed, SWAP_BLOCK))).toMatch(/^Swap deposit /);
    expect(gasClosed).not.toContain(GAS_BLOCK);
    expect(words(gasClosed)).toContain("Deposits for the gas order are closed. Do not send now: a payment sent after the deadline may be lost.");
    expect(words(gasClosed)).not.toContain("Deposits for this order are closed");
    // The same by the page's own clock, whatever the server last said.
    const soon = line({ deadline: new Date(NOW + 119_000).toISOString() });
    expect(page(withGas(soon))).not.toContain(GAS_BLOCK);
    // The swap is paid and the gas order is not: only the gas deposit is left, with no line about two transfers.
    const swapPaid = page(withGas(line(), { status: "swapping", ...PAID }));
    expect(swapPaid).not.toContain(SWAP_BLOCK);
    expect(swapPaid).not.toContain("pay-pair");
    expect(words(element(swapPaid, GAS_BLOCK))).toMatch(/^Gas deposit .* Amount 0\.00118565 ETH /);
    // The gas order is paid and the swap is not: only the swap's, named as any order's deposit is.
    const gasPaid = page(withGas(line({ status: "swapping", ...PAID })));
    expect(gasPaid).not.toContain(GAS_BLOCK);
    expect(gasPaid).not.toContain("pay-pair");
    expect(words(element(gasPaid, SWAP_BLOCK))).toMatch(/^Send your deposit /);
    // A gas order that ran out while the swap goes on: no gas deposit, and the line says that nothing is lost.
    const ranOut = page(withGas(line({ status: "expired", depositsOpen: false, depositAddress: null }), { status: "swapping", ...PAID }));
    expect(ranOut).not.toMatch(/gas-deposit-title|gas-tx-hash/);
    expect(words(gasRow(ranOut))).toBe("Stopped: Gas Ran out It ran out unpaid: nothing was sent to it and nothing is lost.");
  });

  it("has a hash field for each order, and each sends its hash to its own order", () => {
    const markup = page(withGas(line()));
    expect(words(markup)).toContain("Already sent the swap? Add its transaction hash");
    expect(words(markup)).toContain("Already sent the gas? Add its transaction hash");
    expect(markup).toContain('<label class="sr-only" for="tx-hash">Transaction hash</label><input id="tx-hash"');
    expect(markup).toContain('<label class="sr-only" for="gas-tx-hash">Transaction hash of the gas deposit</label><input id="gas-tx-hash"');
    // One field, written once, sends to the ID of the order it was given and hands back that order's answer.
    const code = source("pages/OrderPage.tsx");
    expect(code.match(/api\.submitDeposit\(/g)).toHaveLength(1);
    expect(code).toContain("      onOrder(await api.submitDeposit(order.id, text));");
    expect(code).toContain('      {order.status === "waiting" && !gone ? <HashField order={order} onOrder={onOrder} part={gasOrder !== null ? "swap" : undefined} /> : null}\n      {gasOrder !== null && gasOrder.status === "waiting" ? <HashField order={gasOrder} onOrder={onGas} part="gas" /> : null}\n');
    // Each is there only while its own order waits.
    const swapPaid = page(withGas(line(), { status: "swapping", ...PAID }));
    expect(swapPaid).not.toContain('id="tx-hash"');
    expect(swapPaid).toContain('id="gas-tx-hash"');
    const gasPaid = page(withGas(line({ status: "deposit_seen", ...PAID })));
    expect(gasPaid).toContain('id="tx-hash"');
    expect(gasPaid).not.toContain('id="gas-tx-hash"');
  });

  it("gives the gas order's own numbers and its own ID, folded away under the swap's", () => {
    const markup = page(withGas(line()));
    const folds = [...markup.matchAll(/<details class="order-fold"><summary>([^<]*)</g)].map((match) => match[1]);
    expect(folds).toEqual(["Already sent the swap? Add its transaction hash", "Already sent the gas? Add its transaction hash", "Order details", "Gas order details"]);
    const gasDetails = words(markup.slice(markup.indexOf("Gas order details")));
    expect(gasDetails).toContain("You send 0.00118565 ETH on Base You receive, about 0.02014531 SOL on Solana Routing Private Minimum received 0.019943856 SOL 1.00% slippage SaplingDex fee None Provider fee");
    expect(gasDetails).toContain(`Gas order ${GAS_ID} .`);
    // The page's foot still names the swap, whose link leads to both.
    expect(words(markup).endsWith(`Order ${SWAP_ID} . Keep this page's link: it is the only way back to this order.`)).toBe(true);
  });
});

// ---- Nothing is asked of a wallet ----
describe("paying a swap with gas asks nothing of any wallet", () => {
  it("the page connects to none and builds no transfer: each order is paid by sending to its deposit address, and no file of the page names a thing a wallet could be asked", () => {
    for (const example of [withGas(line()), withGas(line(), { status: "swapping", ...PAID }), withGas(line({ status: "swapping", ...PAID })), gasOrder()]) {
      const markup = page(example);
      expect(markup).not.toMatch(/pay-title|pay-message/);
      expect(words(markup)).not.toMatch(/Connect wallet|Your wallet|Pay from your wallet|1 of 2|2 of 2/);
      expect(markup.match(/<button type="button" class="button-primary"/g)).toBeNull();
    }
    // The gas order's payment is its deposit details, and nothing else.
    expect(squeezed("pages/OrderPage.tsx")).toContain('function GasPay({ gasOrder, now }: { gasOrder: OrderView; now: number }) { return <DepositDetails order={gasOrder} now={now} part="gas" />; }');
    for (const file of ["pages/OrderPage.tsx", "lib/order-logic.ts"]) {
      expect(source(file), file).not.toMatch(/\b(?:sendCalls|wallet_sendCalls|writeContract|sendTransaction|signMessage|signTypedData|increaseAllowance|setApprovalForAll|multicall)\b|\bapprov(?:e|al)\w*\s*\(|\.request\(/);
      expect(source(file), file).not.toMatch(/from "[^"]*\/wallet[^"]*"|useWallet|WalletPay/);
    }
  });
});

// ---- The pair, held to itself ----
describe("the gas order shown beneath a swap must be that swap's own", () => {
  const usdc = { id: "base:USDC", symbol: "USDC", name: "USD Coin", chain: "base", decimals: 6, contract: USDC_BASE };
  /** Each way a gas order can fail to be this swap's, one thing at a time. */
  const MISMATCHES: [string, Partial<OrderView>][] = [
    ["another receiving address", { recipient: OTHER_SOL }],
    ["another refund address", { refundTo: OTHER_EVM }],
    ["paid with another coin", { from: usdc, amountIn: "3000000" }],
    ["delivering on another chain", { to: { id: "arb:ETH", symbol: "ETH", name: "Ethereum", chain: "arb", decimals: 18, contract: null } }],
    ["delivering a token, where the chain's own coin is due", { to: { id: "sol:USDC", symbol: "USDC", name: "USD Coin", chain: "sol", decimals: 6, contract: "y" } }],
    ["the swap's own ID", { id: SWAP_ID }],
  ];

  it("is the swap's when it is another order, paid with the same coin, delivering the receiving chain's own coin to the same address, refunded to the same address", () => {
    expect(gasBelongs(swap(), gasOrder())).toBe(true);
    expect(gasOrderFor(swap(), line())?.id).toBe(GAS_ID);
    for (const [what, change] of MISMATCHES) {
      expect(gasBelongs(swap(), gasOrder(change)), what).toBe(false);
      expect(gasOrderFor(swap(), line(change)), what).toBeNull();
    }
    // Whatever state either is in makes no difference to whose it is.
    for (const status of STATUSES) expect(gasBelongs(swap({ status }), gasOrder({ status })), status).toBe(true);
    for (const none of [undefined, null, { made: false } as const, { made: true, order: null, ended: "delivered" } as const]) expect(gasOrderFor(swap(), none)).toBeNull();
  });

  it("compares addresses as addresses of their chain: letter-case alone never parts a pair, and only where the chain reads it so", () => {
    // Receiving on a chain whose addresses read the same in either case, and refunded on one.
    const toArb = swap({ to: { id: "arb:USDC", symbol: "USDC", name: "USD Coin", chain: "arb", decimals: 6, contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" }, recipient: EVM_ADDRESS });
    const gasOnArb = (change: Partial<OrderView> = {}) => gasOrder({ to: { id: "arb:ETH", symbol: "ETH", name: "Ethereum", chain: "arb", decimals: 18, contract: null }, recipient: EVM_ADDRESS, ...change });
    expect(gasBelongs(toArb, gasOnArb())).toBe(true);
    expect(gasBelongs(toArb, gasOnArb({ recipient: EVM_ADDRESS.toLowerCase(), refundTo: EVM_ADDRESS.toLowerCase() }))).toBe(true);
    expect(gasBelongs(toArb, gasOnArb({ recipient: OTHER_EVM }))).toBe(false);
    expect(gasBelongs(toArb, gasOnArb({ refundTo: OTHER_EVM }))).toBe(false);
    // On Solana a letter in another case is another address.
    expect(gasBelongs(swap(), gasOrder({ recipient: SOL_ADDRESS.toLowerCase() }))).toBe(false);
  });

  it("where it is not, the page offers no way to pay it: no deposit, no pay step, no hash field, and nothing of it but one sentence", () => {
    expect(GAS_MISMATCH).toBe("The gas order shown does not match this swap, and nothing should be sent to the gas order.");
    for (const [what, change] of MISMATCHES) {
      const markup = page(withGas(line(change)));
      expect(markup, what).not.toMatch(/gas-deposit-title|gas-pay-title|gas-tx-hash|pay-pair|Gas order details|gas-line-head/);
      expect(gasRow(markup), what).toMatch(/^<div class="gas-line" data-state="stopped"><span class="step-mark" data-state="stopped">.*?<\/span><div class="step-body"><p class="step-text">The gas order shown does not match this swap, and nothing should be sent to the gas order\.<\/p><\/div><\/div>$/);
      // Not its deposit address, not its amount to send, not its ID.
      expect(addresses(markup), what).not.toContain(GAS_DEPOSIT);
      expect(words(markup), what).not.toMatch(/0\.00118565|Gas deposit|Already sent the gas/);
      if (change.id === undefined) expect(markup, what).not.toContain(GAS_ID);
      // The swap itself is paid and followed as any order is.
      expect(words(element(markup, SWAP_BLOCK)), what).toMatch(/^Send your deposit .* Amount 0\.5 ETH /);
      expect(words(markup), what).toContain("Already sent? Add the transaction hash");
      expect(markup.match(/<li class="step"/g), what).toHaveLength(4);
    }
  });

  it("says so whatever state that gas order is in, and draws no link of it", () => {
    for (const status of STATUSES) expect(gasWords(line({ status, recipient: OTHER_SOL }), NOW, true, false), status).toEqual({ mark: "stopped", state: null, text: GAS_MISMATCH });
    // Where gas was not added, or the gas order is gone, there is nothing to hold against the swap, and the line says what it always says.
    expect(gasWords({ made: false }, NOW, true, false).text).toBe(GAS_NOT_ADDED);
    expect(gasWords({ made: true, order: null, ended: "delivered" }, NOW, true, false).state).toBe("Delivered");
    const delivery = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const done = line({ status: "delivered", ...PAID, recipient: OTHER_SOL, depositTxHash: GAS_HASH, depositTxUrl: `https://basescan.org/tx/${GAS_HASH}`, details: details({ destinationTxs: [{ hash: delivery, url: `https://solscan.io/tx/${delivery}` }] }) });
    const row = gasRow(page(withGas(done, { status: "delivered", ...PAID })));
    expect(words(row)).toBe(`Stopped: ${GAS_MISMATCH}`);
    expect(row).not.toMatch(/order-tx|href=/);
  });

  it("a matching pair is as it was, and the page asks the rule before it shows anything of the gas order", () => {
    const markup = page(withGas(line()));
    expect(markup).toContain(GAS_BLOCK);
    expect(markup).toContain('id="gas-tx-hash"');
    expect(words(gasRow(markup))).toBe("Now: Gas about 0.02014 SOL 0.02014531 SOL Waiting Waiting for its deposit.");
    const code = source("pages/OrderPage.tsx");
    expect(code).toContain("  const gasOrder = gasOrderFor(order, gas);\n  const gasAwaits = gasOrder !== null && awaitsDeposit(gasOrder);");
    expect(code).toContain("  const mismatch = gasOrder === null && gasOrderOf(gas) !== null;");
    expect(code).toContain("      {gas !== null ? <GasRow gas={gas} now={now} hasContact={contact !== null} belongs={!mismatch} /> : null}");
    // Everything that could ask for a payment to the gas order is drawn from that one checked order.
    for (const drawn of ["{gasOrder !== null && gasAwaits ? <GasPay gasOrder={gasOrder}", '{gasOrder !== null && gasOrder.status === "waiting" ? <HashField order={gasOrder}', "{gasOrder !== null ? <Summary order={gasOrder}"]) expect(code, drawn).toContain(drawn);
    // A page that was showing the swap when its record went still holds the gas order against what it last showed of the swap.
    const gone = page(withGas(line({ ghost: true, recipient: OTHER_SOL }), { ghost: true, status: "delivered", ...PAID }), { gone: true });
    expect(gone).not.toMatch(/gas-deposit-title|gas-tx-hash/);
    expect(words(gasRow(gone))).toBe(`Stopped: ${GAS_MISMATCH}`);
  });
});

// ---- Ghost mode ----
describe("a swap with gas in Ghost mode", () => {
  it("is paid by deposit address, both orders, as out of the mode: two deposits, each named, with the line about two transfers", () => {
    const pair = withGas(line({ ghost: true }), { ghost: true });
    for (const example of [pair, withGas(line()), withGas(line({ ghost: true }), { ghost: true, status: "swapping", ...PAID })]) {
      const markup = page(example, { ghost: true });
      expect(markup).not.toMatch(/pay-title|pay-message/);
      expect(words(markup)).not.toMatch(/Connect wallet|Your wallet|1 of 2|2 of 2/);
      expect(markup).toContain(GAS_BLOCK);
    }
    const markup = page(pair, { ghost: true });
    expect(markup).toContain(`<p class="pay-pair">${TWO_TRANSFERS}</p>${SWAP_BLOCK}`);
    expect(markup.indexOf(SWAP_BLOCK)).toBeLessThan(markup.indexOf(GAS_BLOCK));
  });

  it("nothing is stored for either order: the page keeps nothing of its own, and writes no note of a payment", () => {
    for (const file of ["pages/OrderPage.tsx", "lib/order-logic.ts"]) expect(source(file), file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(source("pages/OrderPage.tsx").match(/\b(?:rememberSent|rememberAsking|doneAsking|forgetSent|sentFor|writeKept|dropKept)\(/g)).toBeNull();
  });
});

// ---- The gas order by itself ----
describe("a gas order opened by its own ID", () => {
  it("says that it is the gas order: in its title, over its details and at its foot", () => {
    expect(pageTitle(gasOrder())).toBe("Gas: 0.00118565 ETH to SOL");
    expect(pageTitle(swap())).toBe("0.5 ETH to USDT");
    expect(pageTitle(withGas(line()))).toBe("0.5 ETH to USDT");
    const markup = page(gasOrder());
    expect(markup).toContain('<h1 id="order-title" class="order-title">Gas: 0.00118565 ETH to SOL</h1>');
    expect(markup).toContain('<details class="order-fold"><summary>Gas order details<');
    expect(markup).not.toContain("<summary>Order details<");
    expect(words(markup).endsWith(`Gas order ${GAS_ID} . Keep this page's link: it is the only way back to this order.`)).toBe(true);
  });

  it("is otherwise the ordinary page of an order: its own steps, its own deposit, and no gas line of its own", () => {
    const markup = page(gasOrder());
    expect(markup.match(/<li class="step"/g)).toHaveLength(4);
    expect(words(element(markup, SWAP_BLOCK))).toMatch(/^Send your deposit .* Amount 0\.00118565 ETH /);
    expect(words(markup)).toContain("Already sent? Add the transaction hash");
    expect(markup).not.toMatch(/gas-line|gas-deposit-title|gas-tx-hash|pay-pair/);
    // An ordinary order still says what it always said.
    const ordinary = page(swap());
    expect(ordinary).toContain("<summary>Order details<");
  });

  it("is an order like any other to every rule of the page", () => {
    expect(awaitsDeposit(gasOrder())).toBe(true);
    expect(awaitsDeposit(gasOrder({ status: "deposit_seen", depositProven: false }))).toBe(true);
    expect(awaitsDeposit(gasOrder({ status: "deposit_seen", depositProven: true }))).toBe(false);
    for (const status of STATUSES.filter((status) => status !== "waiting" && status !== "deposit_seen")) expect(awaitsDeposit(gasOrder({ status })), status).toBe(false);
    expect(gasOrderOf(line())?.id).toBe(GAS_ID);
    for (const none of [undefined, null, { made: false } as const, { made: true, order: null, ended: "delivered" } as const]) expect(gasOrderOf(none)).toBeNull();
  });
});

// ---- The operator's tools ----
describe("the controls of a practice order with gas", () => {
  const code = source("pages/OrderPage.tsx");

  it("move each of the two orders by itself: the gas order's act on the gas order's own ID", () => {
    expect(code).toContain("<button key={action} type=\"button\" className=\"button-chip\" onClick={() => void api.practice(gasOrder.id, action).catch(() => undefined)}>");
    expect(code).toContain("<button key={action} type=\"button\" className=\"button-chip\" onClick={() => void api.practice(swap.id, action).catch(() => undefined)}>");
    expect(code.match(/api\.practice\(gasOrder\.id, /g)).toHaveLength(1);
    expect(code.match(/api\.practice\(swap\.id, /g)).toHaveLength(2);
    expect(code).toContain('<div className="states-row" role="group" aria-label="Test controls for the gas order">');
    // Each is there while its own order can still be moved, also once the swap's record has gone.
    expect(code).toContain("  const swapRuns = order !== null && !deleted && ending(order) === null;\n  const gasRuns = gasOrder !== null && ending(gasOrder) === null;\n  const controls = practice && (swapRuns || gasRuns) ? <TestControls swap={swapRuns ? order : null} gasOrder={gasRuns ? gasOrder : null} /> : null;");
  });
});

describe("the page of component states", () => {
  it("draws, and holds a sample of each state of an order with gas", async () => {
    const { default: StatesPage } = await import("../web/src/pages/StatesPage.tsx");
    const html = draw(() => createElement(StatesPage));
    const group = /<h2 class="states-title">Orders with gas<\/h2>([\s\S]*?)<h2 class="states-title">/.exec(html)?.[1] ?? "";
    const labels = [...group.matchAll(/<p class="states-label muted">([^<]*)<\/p>/g)].map((match) => (match[1] ?? "").replace(/&#x27;/g, "'"));
    for (const wanted of ["Both waiting, sent by hand", "Swap delivered, gas delivered", "Gas was not added", "The gas ran out unpaid; the swap goes on", "The gas order opened by its own ID", "a fresh load after the swap's record is deleted"]) expect(labels.some((label) => label.includes(wanted)), wanted).toBe(true);
    expect(labels.length).toBeGreaterThanOrEqual(14);
    // Both waiting: two deposits and the line; delivered: both lines done; not added: the one sentence; ran out: nothing lost.
    expect(group).toContain(`<p class="pay-pair">${TWO_TRANSFERS}</p>`);
    expect(group).toContain(GAS_BLOCK);
    expect(group).toContain('<div class="gas-line" data-state="done">');
    expect(group).toContain(`<p class="step-text">${GAS_NOT_ADDED}</p>`);
    expect(words(group)).toContain("Gas Ran out It ran out unpaid: nothing was sent to it and nothing is lost.");
    expect(group).toContain('<h1 id="order-title" class="order-title">Gas: 0.00118565 ETH to SOL</h1>');
    expect(group).toContain('<section class="order" aria-labelledby="gas-alone-title">');
    // The two that are never meant to be seen on the live site: a gas order that is not the swap's, and the note of a deleted swap whose gas order is still open.
    expect(group).toContain(`<p class="step-text">${GAS_MISMATCH}</p>`);
    expect(words(group)).toContain("Its gas order is still open, below. This page's link is the way back to it until that has finished too.");
    // No state of paying from a wallet is among them: there is no such step.
    expect(words(html)).not.toMatch(/1 of 2|2 of 2|Pay from your wallet/);
    expect(NEVER.test(words(group))).toBe(false);
  });
});
