import { ArrowDownUp, Ghost, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { displayBps } from "../../../shared/amounts.ts";
import { chainInfo, chainName } from "../../../shared/chains.ts";
import { cardRouting, estimateUsd, minimumNote, primaryAction, PRIVATE_UNAVAILABLE, quoteAnnouncement, routedPrivately, routingNote, shouldAnnounce, type Announced } from "../lib/swap-logic.ts";
import { useKeyboardInset, useStuck } from "../lib/use-stuck.ts";
import { useApp } from "../stores/app.ts";
import { useGhost } from "../stores/ghost.ts";
import { closePicker, openPicker, usePicker, watchPickerHistory, type PickerSide } from "../stores/picker.ts";
import { useSheet } from "../stores/sheet.ts";
import { quoteAge, useSwap } from "../stores/swap.ts";
import { useTokens } from "../stores/tokens.ts";
import { AddressField, AddressFieldPlaceholder } from "./AddressField.tsx";
import { AmountInput, AmountOutput, UsdValue } from "./AmountField.tsx";
import { PrimaryButton } from "./Button.tsx";
import { CoinButton } from "./CoinButton.tsx";
import { CoinPicker } from "./CoinPicker.tsx";
import { GasSwitch } from "./GasSwitch.tsx";
import { QuotePanel } from "./QuotePanel.tsx";

/** Re-renders once a second, so a quote can be seen to expire. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** How long the card's two views take to change places. The same as --motion-sheet in the token file. */
const SLIDE_MS = 250;

/**
 * The card has two views: the swap, and the coin picker, which takes the swap's place inside the
 * card. This moves the card between them. The view being left stays on the page while it slides
 * away, and the card's height goes smoothly from the one view's to the other's; then the height is
 * the card's own again. Where the system asks for less movement, the views simply change places.
 * Nothing here scrolls the page, and the card's top edge and width never change.
 */
function useCardViews(side: PickerSide | null) {
  const card = useRef<HTMLElement>(null);
  // The picker that is on the page: it stays for the length of its slide away.
  const [shown, setShown] = useState<PickerSide | null>(side);
  const [moving, setMoving] = useState(false);
  if (side !== null && shown !== side) setShown(side);
  const was = useRef(side);
  const timer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (was.current === side) return;
    was.current = side;
    const element = card.current;
    const settle = () => {
      if (element !== null) element.style.height = "";
      setMoving(false);
      if (side === null) setShown(null);
    };
    window.clearTimeout(timer.current);
    if (element === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settle();
      return;
    }
    const arriving = element.querySelector<HTMLElement>(side === null ? ":scope > .card-swap" : ":scope > .card-picker");
    const going = element.querySelector<HTMLElement>(side === null ? ":scope > .card-picker" : ":scope > .card-swap");
    // Where the height starts: where it is now if the card is already on the move, and otherwise the height it had with the view being left.
    const midway = element.style.height !== "" ? element.getBoundingClientRect().height : null;
    element.style.height = "";
    const to = element.getBoundingClientRect().height;
    const from = midway ?? to - (arriving?.offsetHeight ?? 0) + (going?.offsetHeight ?? 0);
    element.style.height = `${from}px`;
    // Read once, so that the browser takes the starting height before it is given the one to go to.
    void element.offsetHeight;
    element.style.height = `${to}px`;
    setMoving(true);
    timer.current = window.setTimeout(settle, SLIDE_MS + 50);
  }, [side]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { card, shown, moving };
}

/**
 * The swap card is the page: two small tools, the coins and the amount, the receiving address, the live quote in one line, and one button.
 * Under the receiving address, only where the server offers it for this swap: the "Add gas" switch.
 * Where the server routes swaps privately, the row of tools also says so at its left end; where it does not, nothing here speaks of routing.
 * Choosing a coin happens inside the card: its contents give way to the coin picker and come back when a coin is chosen.
 * The card connects to no wallet and knows none: a swap is paid one way, by sending to the order's deposit address.
 * In Ghost mode the card carries the mode's small mark at that left end.
 */
export function SwapCard() {
  useKeyboardInset();
  const swap = useSwap();
  const tokens = useTokens();
  const ghost = useGhost((state) => state.on);
  const ghostFresh = useGhost((state) => state.fresh);
  const paused = useApp((state) => state.config?.paused ?? false);
  // How the server routes swaps. The card only ever says what the server does; it never chooses a level.
  const privacyMode = useApp((state) => state.config?.privacyMode ?? null);
  const routing = cardRouting(privacyMode, swap.withoutPrivate);
  const openSheet = useSheet((state) => state.open);
  const sheetOpen = useSheet((state) => state.current !== null);
  // The coin picker, when it has the card: for the coin paid ("from") or the coin received ("to").
  const pickerSide = usePicker((state) => state.side);
  const views = useCardViews(pickerSide);
  useEffect(() => watchPickerHistory(), []);
  // When the picker closes, the keyboard goes back to the coin selector that opened it, without scrolling the page.
  const fromButton = useRef<HTMLButtonElement>(null);
  const toButton = useRef<HTMLButtonElement>(null);
  const lastSide = useRef<PickerSide | null>(null);
  useLayoutEffect(() => {
    if (pickerSide !== null) {
      lastSide.current = pickerSide;
      return;
    }
    const opener = lastSide.current === null ? null : (lastSide.current === "from" ? fromButton : toButton).current;
    lastSide.current = null;
    opener?.focus({ preventScroll: true });
  }, [pickerSide]);
  const now = useNow();
  // Each press of the flip button turns it half a turn further.
  const [turns, setTurns] = useState(0);

  const from = swap.fromId === null ? null : (tokens.byId.get(swap.fromId) ?? null);
  const to = swap.toId === null ? null : (tokens.byId.get(swap.toId) ?? null);
  const quote = swap.quote;
  const age = quoteAge(swap, now);
  const impact = quote?.priceImpactBps ?? null;
  // The coin a gas order would deliver, as the server's preview names it. With no preview there is none, and no switch.
  const gasCoin = swap.gas === null ? null : (tokens.byId.get(swap.gas.quote.to) ?? null);
  const action = primaryAction({
    paused,
    coinsReady: tokens.status === "ready" || tokens.status === "stale",
    from,
    to,
    amountText: swap.amountText,
    recipient: swap.recipient,
    refundTo: swap.refundTo,
    quote: age,
    problem: swap.problem,
    impactUnconfirmed: impact !== null && impact > 1000 && !swap.impactConfirmed,
  });

  // The line above the button: why a quote failed, or what a minimum comes to.
  const message =
    swap.problem !== null && action.kind === "retry"
      ? swap.problem.message
      : action.kind === "without-private"
        ? PRIVATE_UNAVAILABLE
        : swap.problem !== null && swap.problem.code === "min_usd"
          ? minimumNote(swap.problem.detail, from)
          : null;

  const sentinel = useRef<HTMLDivElement>(null);
  const stuck = useStuck(sentinel);

  // Read out to screen readers: a quote for new inputs, and after that only a real change
  // (more than 0.5%), at most once in 30 seconds. The numbers refresh far more often than that.
  const announced = useRef<Announced | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (quote === null || from === null || to === null || swap.loading || swap.dirty) return;
    // The routing is part of what the quote is for: the same coins and amount by the other route are read out afresh.
    const privately = routedPrivately(quote);
    const next: Announced = { key: `${from.id}|${to.id}|${quote.amountIn}|${privately ? "private" : ""}`, amountOut: BigInt(quote.amountOut), at: Date.now() };
    if (!shouldAnnounce(announced.current, next)) return;
    announced.current = next;
    // The exact figure: the short form of a very small amount ("0.0₅12") is not something that can be read aloud.
    setAnnouncement(quoteAnnouncement(to, next.amountOut, privately));
  }, [quote, from, to, swap.loading, swap.dirty]);

  const act = () => {
    if (action.kind === "refresh" || action.kind === "retry") swap.refreshNow();
    // The person's own choice, for this swap: a public quote is asked for, and from there the flow is as ever.
    else if (action.kind === "without-private") swap.setWithoutPrivate(true);
    else if (action.kind === "review") openSheet("review");
  };

  return (
    <section ref={views.card} className="card" aria-labelledby="swap-title" data-view={pickerSide === null ? "swap" : "picker"} data-moving={views.moving || undefined}>
      <h1 id="swap-title" className="sr-only">
        Swap
      </h1>

      {/* The swap itself. While the picker has the card, nothing in here can be reached or is read out. */}
      <div className="card-view card-swap" inert={pickerSide !== null}>
        {/* Above the fields, to the right: the slippage limit and a fresh quote. To the left, only after
            choosing public routing for this swap: the way back to private routing. The card carries no tag;
            the quote's own rows and the review say how a swap is routed. */}
        <div className="card-tools">
          {ghost ? (
            <span className="card-ghost" data-fresh={ghostFresh || undefined}>
              <Ghost size={14} strokeWidth={1.5} aria-hidden="true" />
              Ghost mode
            </span>
          ) : null}
          {routing === "public-by-choice" ? (
            <button type="button" className="routing-switch card-routing" onClick={() => swap.setWithoutPrivate(false)}>
              Use private routing
            </button>
          ) : null}
          <button type="button" className="tool" onClick={() => openSheet("slippage")} aria-haspopup="dialog" aria-label={`${displayBps(swap.slippageBps)} slippage limit. Change`} title="Slippage limit">
            <SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="tool" onClick={swap.refreshNow} disabled={paused || (quote === null && swap.problem === null) || swap.loading || swap.dirty} aria-label="Refresh the quote" title="Refresh the quote">
            {/* key: each quote that arrives turns the arrows once */}
            <RefreshCw key={quote?.serverNow ?? "none"} className={quote !== null ? "tool-turn" : undefined} size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <div className="field-head">
            <label className="field-label" htmlFor="amount-in">
              You pay
            </label>
          </div>
          <div className="field-row">
            <CoinButton ref={fromButton} token={from} label="You pay" onClick={() => openPicker("from")} />
            <div className="field-value">
              <AmountInput id="amount-in" value={swap.amountText} decimals={from?.decimals ?? 18} autoFocus={!sheetOpen && pickerSide === null} onChange={swap.setAmount} />
              <UsdValue value={quote?.amountInUsd ?? estimateUsd(swap.amountText, from)} />
            </div>
          </div>
        </div>

        <div className="flip-row">
          <button
            type="button"
            className="flip"
            onClick={() => {
              swap.flip();
              setTurns((count) => count + 1);
            }}
            style={{ "--turn": `${turns * 180}deg` } as CSSProperties}
            aria-label="Swap the two coins"
            title="Swap the two coins"
            disabled={from === null || to === null}
          >
            <ArrowDownUp size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <div className="field-head">
            <label className="field-label" htmlFor="amount-out">
              You receive
            </label>
          </div>
          <div className="field-row">
            <CoinButton ref={toButton} token={to} label="You receive" onClick={() => openPicker("to")} />
            <div className="field-value">
              <AmountOutput id="amount-out" raw={quote?.amountOut ?? null} decimals={to?.decimals ?? 6} symbol={to?.symbol ?? ""} stale={swap.loading || swap.dirty} loading={swap.loading || swap.dirty} />
              <UsdValue value={quote?.amountOutUsd ?? null} />
            </div>
          </div>
        </div>

        {to !== null ? (
          <AddressField
            label="Receiving address"
            hint={`Your ${to.symbol} is sent here. Use a wallet you control.`}
            chain={to.chain}
            value={swap.recipient}
            onChange={swap.setRecipient}
            memoNote={chainInfo(to.chain).memoChain === true}
          />
        ) : (
          <AddressFieldPlaceholder label="Receiving address" />
        )}

        {/* Gas arrives at the receiving address, so the switch stands right under it. It works the same in Ghost mode. */}
        <GasSwitch gas={swap.gas} coin={gasCoin} on={swap.gasOn} onChange={swap.setGasOn} />

        {/* A refund address is always asked for: where the coins come back if the swap is not made. */}
        {from !== null ? <AddressField label="Refund address" hint={`If the swap fails, your ${from.symbol} comes back here.`} chain={from.chain} value={swap.refundTo} onChange={swap.setRefundTo} use="refund" /> : null}

        <QuotePanel
          quote={quote}
          from={from}
          to={to}
          loading={swap.loading || swap.dirty}
          stale={quote !== null && (swap.loading || swap.dirty)}
          held={/[1-9]/.test(swap.amountText)}
          // A swap adds points only if a rewards address is given in the review, so nothing is promised before then.
          pointsShown={false}
          routing={routingNote(privacyMode, quote, swap.withoutPrivate)}
          impactConfirmed={swap.impactConfirmed}
          onConfirmImpact={swap.setImpactConfirmed}
        />

        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <p className="card-message" role="status">
          {message ?? " "}
        </p>
        {/* Pinned to the bottom of the screen while the card is taller than it, so the next step is always in view. */}
        <div className="card-submit" data-stuck={stuck || undefined}>
          <PrimaryButton onClick={act} disabled={action.disabled} busy={action.busy}>
            {action.label}
          </PrimaryButton>
        </div>
        <div ref={sentinel} className="card-submit-end" aria-hidden="true" />
        {/* Under the button: how it is paid. There is one way. */}
        <div className="card-actions">
          {from !== null ? (
            <p className="card-footnote muted">
              {from.symbol} on {chainName(from.chain)} is paid by sending it to a deposit address.
            </p>
          ) : null}
        </div>
      </div>
      {views.shown !== null ? <CoinPicker key={views.shown} side={views.shown} leaving={pickerSide === null} onClose={closePicker} /> : null}
    </section>
  );
}
