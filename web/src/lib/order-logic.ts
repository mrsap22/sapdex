// Pure rules behind the order page: what each step says, what an ended order says, and when
// to look again. No browser APIs here, so every rule is unit-tested.

import { sameAddress } from "../../../shared/addresses.ts";
import { displayExact } from "../../../shared/amounts.ts";
import { isEndState, type GasLine, type OrderStatus, type OrderView } from "../../../shared/api.ts";
import { chainName, DEPOSIT_CLOSE_MS } from "../../../shared/chains.ts";
import { shortAddress } from "./swap-logic.ts";

/** "stopped": the step an order was at when it ended without delivering. */
export type StepState = "done" | "current" | "stopped" | "pending";

export interface Step {
  key: "deposit" | "seen" | "swapping" | "delivered";
  title: string;
  /** One sentence for the step as it stands. Empty for a step that has not been reached. */
  text: string;
  state: StepState;
}

const ORDER: Record<OrderStatus, number> = {
  waiting: 0,
  expired: 0,
  deposit_seen: 1,
  deposit_too_small: 1,
  swapping: 2,
  failed: 2,
  refunded: 2,
  delivered: 4,
};

/** "14:05": the time of day on this device's clock. */
export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "29:41" or "1:02:10": time left or elapsed, never negative. */
export function clockSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** What is left of the estimate for the swapping step, as "about N min", or null once it has run past twice the estimate. */
export function swapTimeLeft(order: Pick<OrderView, "timeEstimate" | "statusSince">, now: number): string | null {
  const elapsed = Math.max(0, now - Date.parse(order.statusSince)) / 1000;
  const estimate = Math.max(order.timeEstimate, 60);
  if (elapsed > 2 * estimate) return null;
  const left = Math.max(1, Math.ceil((estimate - elapsed) / 60));
  return `about ${left} min`;
}

/**
 * The four steps of an order: waiting for the deposit, deposit seen, swapping, delivered.
 * `now` is the server's clock. An order that ended any other way keeps the steps it completed;
 * the step it stopped at is marked "stopped", and the ending is told by `ending()`.
 */
export function timeline(order: OrderView, now: number): Step[] {
  const reached = ORDER[order.status];
  const ended = isEndState(order.status) || order.status === "deposit_too_small";
  const state = (index: number): StepState => (order.status === "delivered" || index < reached ? "done" : index === reached ? (ended ? "stopped" : "current") : "pending");
  const sent = `${displayExact(BigInt(order.amountIn), order.from.decimals)} ${order.from.symbol}`;
  const received = order.details?.amountOut ?? order.amountOut;
  const left = order.status === "swapping" ? swapTimeLeft(order, now) : null;

  return [
    {
      key: "deposit",
      title: "Waiting for deposit",
      text:
        state(0) === "done"
          ? `${sent} sent.`
          : order.status === "expired"
            ? "No deposit arrived before the deadline."
            : // In the last two minutes nothing more should be sent: the step must not go on asking for it.
              Date.parse(order.deadline) - now <= DEPOSIT_CLOSE_MS
              ? "Deposits are closed. Checking whether one arrived."
              : `Send ${sent} before ${clockTime(sendBy(order))}.`,
      state: state(0),
    },
    {
      key: "seen",
      title: "Deposit seen",
      text: state(1) === "pending" ? "" : state(1) === "done" ? "Deposit confirmed." : order.status === "deposit_too_small" ? "Less than the full amount arrived." : "Deposit found. Waiting for confirmations.",
      state: state(1),
    },
    {
      key: "swapping",
      title: "Swapping",
      text:
        state(2) === "pending"
          ? ""
          : state(2) === "done"
            ? "Swapped."
            : order.status !== "swapping"
              ? ""
              : left === null
                ? "Taking longer than usual. If the swap fails, the provider refunds you automatically."
                : `Swapping. ${left.charAt(0).toUpperCase()}${left.slice(1)} left.`,
      state: state(2),
    },
    {
      key: "delivered",
      title: "Delivered",
      // The same exact figure as in the ending above the steps: one amount, one way of writing it.
      text: order.status === "delivered" ? `${displayExact(BigInt(received), order.to.decimals)} ${order.to.symbol} sent to ${shortAddress(order.recipient)}.` : "",
      state: order.status === "delivered" ? "done" : "pending",
    },
  ];
}

export interface Ending {
  headline: string;
  /** One line: what happened, and what to keep or expect. */
  cause: string;
  action: "swap-again" | "copy-link" | "contact";
  /** How the ending reads: good news, a plain fact, or something that needs attention. */
  tone: "good" | "plain" | "attention";
}

/** Plain words for the reasons the swap service gives for a refund. Its own codes are never shown. */
const REFUND_REASONS: Record<string, string> = {
  SLIPPAGE_EXCEEDED: "The price moved beyond the limit you accepted.",
  DEADLINE_EXCEEDED: "The deposit arrived after the deadline.",
  PARTIAL_DEPOSIT: "Less than the full amount was sent.",
  INCOMPLETE_DEPOSIT: "Less than the full amount was sent.",
};

/**
 * How an order ended: a headline, one line of cause, and the one thing worth doing next. Null while it is still running.
 * `linkLeads` is false for an order whose record the server has deleted (an order made in Ghost mode, once it has
 * finished): its page's link leads nowhere any more, so what is worth keeping is named as the order's ID.
 */
export function ending(order: OrderView, hasContact = true, linkLeads = true): Ending | null {
  // "Contact support" is only said where there is a contact to give. (A site that takes real swaps always has one: the server will not switch swaps on without it.)
  const andWrite = hasContact ? ", and contact support" : "";
  const thisLink = linkLeads ? "this page's link" : "this order's ID";
  const from = order.from;
  const amount = (raw: string | null | undefined, fallback: string, decimals: number) => displayExact(BigInt(raw ?? fallback), decimals);
  switch (order.status) {
    case "delivered":
      return {
        headline: "Delivered",
        cause: `${amount(order.details?.amountOut, order.amountOut, order.to.decimals)} ${order.to.symbol} was sent to your ${chainName(order.to.chain)} address.`,
        action: "swap-again",
        tone: "good",
      };
    case "refunded": {
      const reason = REFUND_REASONS[order.details?.refundReason ?? ""] ?? "The swap could not be completed.";
      const refunded = order.details?.refundedAmount ?? null;
      return {
        headline: "Refunded",
        cause: `${reason} ${refunded !== null ? `${amount(refunded, "0", from.decimals)} ${from.symbol} was` : `Your ${from.symbol} was`} returned to your refund address, ${shortAddress(order.refundTo)}, on ${chainName(from.chain)}.`,
        action: "swap-again",
        tone: "plain",
      };
    }
    case "deposit_too_small": {
      const arrived = order.details?.depositedAmount ?? null;
      return {
        headline: "Deposit too small",
        cause: `${arrived !== null ? `${amount(arrived, "0", from.decimals)} of ${amount(order.amountIn, "0", from.decimals)} ${from.symbol} arrived` : `Less than ${amount(order.amountIn, "0", from.decimals)} ${from.symbol} arrived`}. It is returned to your refund address by the deadline. Nothing more needs sending.`,
        action: "copy-link",
        tone: "attention",
      };
    }
    case "failed":
      return {
        headline: "Swap failed",
        cause: `The swap could not be completed. Keep ${thisLink} and your deposit transaction hash${andWrite}.`,
        action: "contact",
        tone: "attention",
      };
    case "expired":
      return {
        headline: "Expired",
        cause:
          order.depositTxHash !== null
            ? `No deposit was confirmed before the deadline. Keep ${thisLink} and your deposit transaction hash${andWrite}.`
            : `No deposit arrived before the deadline. If you did send coins, keep the transaction hash and ${thisLink}${andWrite}.`,
        action: order.depositTxHash !== null ? "contact" : "swap-again",
        tone: "plain",
      };
    default:
      return null;
  }
}

/** How long to wait before asking the server again. Null when the order has ended and there is nothing more to learn. */
export function pollDelay(status: OrderStatus, failures: number): number | null {
  if (isEndState(status)) return null;
  // After a failed attempt: 5 s, 10 s, 20 s, then every 30 s.
  if (failures > 0) return Math.min(30_000, 5000 * 2 ** (failures - 1));
  return status === "deposit_too_small" ? 30_000 : 5000;
}

/**
 * An order made in Ghost mode is looked at a few more times after it has ended. Its record is
 * deleted from the server the moment it finishes, and the order's page says so only once the
 * server has said it. `looks` is how many such looks have been made already. Null when no more are
 * made: an order that ended with coins still in it is kept until that has been dealt with, and
 * there is then nothing to wait for.
 */
export function ghostLookAgain(looks: number): number | null {
  return [2000, 5000, 10_000, 20_000, 30_000][looks] ?? null;
}

/** The browser tab's title: the ending, when there is one. */
export function tabTitle(order: OrderView | null): string {
  const end = order === null ? null : ending(order);
  return end !== null ? `${end.headline} · SaplingDex` : "Order · SaplingDex";
}

/**
 * The amount to pay as a heading or a list row may give it: the exact figure where that is short
 * enough to stay on one line of a phone (twelve characters), and otherwise nothing. A longer one
 * is left out, never shortened: a rounded amount to pay would read as exact, and someone sending
 * by hand could type it and pay too little. The exact amount is on the order's page, in the
 * Amount row, with its own Copy button.
 */
export function headingAmount(amountIn: string, decimals: number): string | null {
  const exact = displayExact(BigInt(amountIn), decimals);
  return exact.length <= 12 ? exact : null;
}

/** An order's title: "0.5 ETH to USDT", or "ETH to USDT" where the amount is too long to give exactly (see headingAmount). */
export function orderTitle(order: { amountIn: string; from: { symbol: string; decimals: number }; to: { symbol: string } }): string {
  const amount = headingAmount(order.amountIn, order.from.decimals);
  const coins = `${order.from.symbol} to ${order.to.symbol}`;
  return amount === null ? coins : `${amount} ${coins}`;
}

/** The time to send by: two minutes before the order's deadline, when the deposit details are taken away. The pages name this time, never the deadline itself. */
export function sendBy(order: Pick<OrderView, "deadline">): number {
  return Date.parse(order.deadline) - DEPOSIT_CLOSE_MS;
}

/**
 * Time left to pay, and whether the deposit details are still on show. `now` is the server's clock.
 * `left` runs to the order's deadline (the wallet's own cut-off is measured against it); `toSend`
 * runs to the time to send by, and is what a person is shown.
 */
export function payWindow(order: Pick<OrderView, "deadline" | "depositsOpen">, now: number): { left: number; toSend: number; open: boolean } {
  // The server stops giving out the deposit details two minutes before the deadline. The page applies
  // the same rule to what it already holds, so the details also go when the server cannot be reached.
  return { left: Math.max(0, Date.parse(order.deadline) - now), toSend: Math.max(0, sendBy(order) - now), open: order.depositsOpen && Date.parse(order.deadline) - now > DEPOSIT_CLOSE_MS };
}

/** How an order made in Ghost mode ended, as the server says it of one whose record it has deleted: one word, and all it still knows. */
export type SaidEnding = "delivered" | "refunded" | "expired";

/** That word, from what came with the server's "deleted" answer. Null when it said none, or anything else. */
export function endingSaid(detail: Record<string, unknown> | null | undefined): SaidEnding | null {
  const ended = detail?.ended;
  return ended === "delivered" || ended === "refunded" || ended === "expired" ? ended : null;
}

/** The one sentence that says it. */
export const ENDED_AS: Record<SaidEnding, string> = {
  delivered: "It was delivered.",
  refunded: "It was refunded.",
  expired: "It ran out without being paid.",
};

/** Where to look for what a finished order sent back, when the page did not see it end. */
export const LOOK_FOR: Record<SaidEnding, string> = {
  delivered: "It was delivered: look for the delivery at your receiving address, in the order details below.",
  refunded: "It was refunded: look for the refund at your refund address, in the order details below.",
  expired: "It ran out without being paid.",
};

// ---- A swap with gas ----
// Beside such a swap stands a second, small order that delivers a little of the receiving chain's
// own coin to the same receiving address. It is an order in its own right: its own deposit address,
// its own amount, its own deadline and its own end. The swap's page shows it as one compact line
// beneath the four steps and lets it be paid beside the swap. The rules of that are below.

/** The gas order itself, where the line carries one. Null where gas was not added, and where the order's record is gone. */
export function gasOrderOf(gas: GasLine | null | undefined): OrderView | null {
  return gas !== null && gas !== undefined && gas.made && gas.order !== null ? gas.order : null;
}

/** Whether an order is still to be paid: no deposit has been seen for it, or the one seen is not yet known to be in it. */
export function awaitsDeposit(order: Pick<OrderView, "status" | "depositProven">): boolean {
  return order.status === "waiting" || (order.status === "deposit_seen" && !order.depositProven);
}

/**
 * Whether a gas order is this swap's own: another order than the swap, paid with the swap's coin,
 * delivering the receiving chain's own coin (one with no contract) on the swap's receiving chain, to
 * the swap's own receiving address, and refunded to the swap's own refund address.
 *
 * The server makes every gas order so, from the swap's own request, and nothing a request says can
 * change it. The page holds the pair to it all the same: it never asks for a payment to a gas order
 * that would deliver anywhere but where the swap delivers. Addresses are compared as addresses of
 * their chain, so letter-case alone never parts a pair.
 */
export function gasBelongs(swap: Pick<OrderView, "id" | "from" | "to" | "recipient" | "refundTo">, gasOrder: Pick<OrderView, "id" | "from" | "to" | "recipient" | "refundTo">): boolean {
  if (gasOrder.id === swap.id) return false;
  if (gasOrder.from.id !== swap.from.id) return false;
  if (gasOrder.to.chain !== swap.to.chain) return false;
  if (gasOrder.to.contract !== null) return false;
  if (!sameAddress(swap.to.chain, gasOrder.recipient, swap.recipient)) return false;
  if (!sameAddress(swap.from.chain, gasOrder.refundTo, swap.refundTo)) return false;
  return true;
}

/**
 * The gas order a swap's page shows as that swap's and takes payment for: the one its gas line
 * carries, where that is the swap's own (see gasBelongs). Null where the line carries none, and
 * where the one it carries is not the swap's.
 */
export function gasOrderFor(swap: Parameters<typeof gasBelongs>[0], gas: GasLine | null | undefined): OrderView | null {
  const order = gasOrderOf(gas);
  return order !== null && gasBelongs(swap, order) ? order : null;
}

/** The one line a swap's page says when gas was asked for and could not be added. */
export const GAS_NOT_ADDED = "Gas was not added. Your swap is unaffected.";

/** The one line it says of a gas order that is not the swap's own. Nothing of that order is shown beside it, and no way to pay it. */
export const GAS_MISMATCH = "The gas order shown does not match this swap, and nothing should be sent to the gas order.";

/** What stands above the two deposits, the swap's and the gas's, when both are on show. */
export const TWO_TRANSFERS = "These are two separate transfers. Send each to its own address; do not combine them.";

/** The title of an order's own page. A gas order opened by its own ID says that it is one. */
export function pageTitle(order: Parameters<typeof orderTitle>[0] & Pick<OrderView, "gasOrder">): string {
  return order.gasOrder === true ? `Gas: ${orderTitle(order)}` : orderTitle(order);
}

export interface GasWords {
  /** How the line is marked, as a step is: still going, done, or stopped. */
  mark: Exclude<StepState, "pending">;
  /** Its state in a word or two. Null where the line is one plain sentence: gas was not added. */
  state: string | null;
  /** What that means, in a sentence or two. */
  text: string;
}

/** The word for how a gas order ended, where one word is all that is left of it. */
const GAS_ENDED: Record<SaidEnding, string> = { delivered: "Delivered", refunded: "Refunded", expired: "Ran out" };

/**
 * The gas line of a swap's page: the gas order's own state in plain words, whatever that state is.
 * `now` is the server's clock. A gas order that ran out with nothing sent to it says so, and that
 * nothing is lost: that is how it ends when only the swap was paid. `belongs` is false for a gas
 * order that is not the swap's own (see gasBelongs): the line then says that, whatever state that
 * order is in.
 */
export function gasWords(gas: GasLine, now: number, hasContact = true, belongs = true): GasWords {
  if (!gas.made) return { mark: "stopped", state: null, text: GAS_NOT_ADDED };
  // Made in Ghost mode and finished: one word is all the server still says of it.
  if (gas.order === null) return { mark: gas.ended === "delivered" ? "done" : "stopped", state: GAS_ENDED[gas.ended], text: `${ENDED_AS[gas.ended]} It was made in Ghost mode, so its record was deleted when it finished.` };
  if (!belongs) return { mark: "stopped", state: null, text: GAS_MISMATCH };
  const order = gas.order;
  const from = order.from;
  const paid = (raw: string) => displayExact(BigInt(raw), from.decimals);
  const keep = `Keep this page's link and its deposit transaction hash${hasContact ? ", and contact support" : ""}.`;
  switch (order.status) {
    case "waiting":
      // In the last two minutes nothing more should be sent to it: the line stops saying that it waits.
      return { mark: "current", state: "Waiting", text: payWindow(order, now).open ? "Waiting for its deposit." : "Its deposit is closed. Checking whether one arrived." };
    case "deposit_seen":
      return { mark: "current", state: "Seen", text: "Its deposit was seen. Waiting for confirmations." };
    case "swapping":
      return { mark: "current", state: "Swapping", text: `Its deposit is confirmed. Swapping it for ${order.to.symbol}.` };
    case "delivered":
      // What really arrived, where the provider reports it: the same exact figure, written the same way, as the swap's own last step.
      return { mark: "done", state: "Delivered", text: `${displayExact(BigInt(order.details?.amountOut ?? order.amountOut), order.to.decimals)} ${order.to.symbol} sent to ${shortAddress(order.recipient)}.` };
    case "deposit_too_small": {
      const arrived = order.details?.depositedAmount ?? null;
      return { mark: "stopped", state: "Deposit too small", text: `${arrived !== null ? `${paid(arrived)} of ${paid(order.amountIn)} ${from.symbol} arrived` : `Less than ${paid(order.amountIn)} ${from.symbol} arrived`}. It is returned to your refund address by the deadline. Nothing more needs sending.` };
    }
    case "refunded": {
      const reason = REFUND_REASONS[order.details?.refundReason ?? ""] ?? "The gas could not be delivered.";
      const refunded = order.details?.refundedAmount ?? null;
      return { mark: "stopped", state: "Refunded", text: `${reason} ${refunded !== null ? `${paid(refunded)} ${from.symbol} was` : `Your ${from.symbol} was`} returned to your refund address, ${shortAddress(order.refundTo)}, on ${chainName(from.chain)}.` };
    }
    case "failed":
      return { mark: "stopped", state: "Failed", text: `The gas could not be delivered. ${keep}` };
    case "expired":
      // A transaction was named for it and never confirmed: coins may be in it, and the line does not say that nothing is lost.
      return { mark: "stopped", state: "Ran out", text: order.depositTxHash !== null ? `No deposit was confirmed before its deadline. ${keep}` : "It ran out unpaid: nothing was sent to it and nothing is lost." };
  }
}

/** When to look again for the gas order's sake. Null when there is none to follow: gas was not added, its record is gone, or it has ended. */
export function gasPollDelay(gas: GasLine | null | undefined): number | null {
  const order = gasOrderOf(gas);
  return order === null ? null : pollDelay(order.status, 0);
}

/**
 * When a swap's page looks again. A swap with gas is two orders, and the page goes on looking until
 * both have ended. `swapWait` is what the swap alone asks for: null once it has ended and nothing
 * more is to be learned of it. Null only when neither order asks for another look.
 */
export function lookAgain(swapWait: number | null, gas: GasLine | null | undefined): number | null {
  const gasWait = gasPollDelay(gas);
  return swapWait === null ? gasWait : gasWait === null ? swapWait : Math.min(swapWait, gasWait);
}

/**
 * Once a swap's record is deleted (it was made in Ghost mode, and has finished), its page goes on
 * looking for the sake of its gas order: as often as for any running order while that one runs, a
 * few times more once it has ended, so as to learn that its record has gone too, and not at all
 * once nothing is left of it but a word. `looksAfterEnd` is how many looks have been made since it ended.
 */
export function gasLookAgain(gas: GasLine | null | undefined, looksAfterEnd: number): number | null {
  const order = gasOrderOf(gas);
  if (order === null) return null;
  return pollDelay(order.status, 0) ?? ghostLookAgain(looksAfterEnd);
}

/** What is known of the gas line after an answer: what the answer says of it or, where it says nothing, what was known before. */
export function gasKept(before: GasLine | null, said: GasLine | null | undefined): GasLine | null {
  return said ?? before;
}

/**
 * A fresh view of the gas order, put into the line. Only a view of the very order the line already
 * carries is taken; a view of any other order, the swap's own included, leaves the line as it was.
 */
export function gasPlaced(line: GasLine | null, view: OrderView): GasLine | null {
  return gasOrderOf(line)?.id === view.id ? { made: true, order: view } : line;
}
