// How the site works, in plain words, as a small documentation: one page to a subject, all in
// one layout (see DocsLayout). The figures of the example on the Fees page are read from a quote
// taken as the page opens, the chains from the live coin list, and the deadlines from the same
// constants the server uses.
//
// Where the server routes swaps privately there is one page more, "Private routing", and the
// other pages say what it changes for them, each in a sentence or two. Where it does not, none of
// that is shown and nothing on any page speaks of private routing.
//
// One page is about Ghost mode. It is a page everywhere, and says in as many sections what the
// mode does, what it does not, and what is still kept.
//
// One page is about Add gas. Gas is only ever added beside a privately routed swap, so it is a page
// only where swaps are routed privately, and only there do two other pages say that a swap with
// gas is paid with two transfers.

import { useEffect, useMemo, useState } from "react";
import { displayAmount, displayBps, parseAmount } from "../../../shared/amounts.ts";
import { SLIPPAGE, type QuoteView, type TokenView } from "../../../shared/api.ts";
import { chainName, DEPOSIT_CLOSE_MS, sendWindowMs } from "../../../shared/chains.ts";
import { GAS_DOC_SLUG, GHOST_DOC_SLUG, PRIVATE_DOC_SLUG, type DocSlug } from "../../../shared/pages.ts";
import { INDEPENDENCE } from "../../../shared/positioning.ts";
import { SHIELDED_DOCS, zecShieldedOf } from "../../../shared/shielded.ts";
import { api } from "../api.ts";
import { Callout, DocSection, DocsLayout, TableFrame } from "../components/DocsLayout.tsx";
import { questions, type Question } from "../components/Faq.tsx";
import { Link } from "../components/Link.tsx";
import { DEFAULT_PAIR, EXAMPLE_AMOUNT } from "../config.ts";
import { docHref, gasSizes, listed } from "../lib/docs-logic.ts";
import { chainsOnList, isPrivateMode } from "../lib/site-logic.ts";
import { statsPageOn } from "../lib/stats-logic.ts";
import { appFeeWords, minutesText } from "../lib/swap-logic.ts";
import { useApp } from "../stores/app.ts";
import { findToken, useTokens } from "../stores/tokens.ts";

/** A quote for a small swap of the opening pair, taken as the page opens. Null while it loads; "none" when it could not be had. */
function useExampleQuote(from: TokenView | undefined, to: TokenView | undefined, paused: boolean): QuoteView | null | "none" {
  const [quote, setQuote] = useState<QuoteView | null | "none">(null);
  const fromId = from?.id;
  const toId = to?.id;
  const decimals = from?.decimals;
  useEffect(() => {
    // While swaps are paused the server gives no quotes: none is asked for.
    if (paused) {
      setQuote("none");
      return;
    }
    if (fromId === undefined || toId === undefined || decimals === undefined) return;
    const amount = parseAmount(EXAMPLE_AMOUNT, decimals);
    if (!amount.ok) return;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 20_000);
    api
      .quote({ from: fromId, to: toId, amount: amount.raw.toString(), pay: "manual" }, stop.signal)
      .then(setQuote)
      .catch(() => {
        if (!stop.signal.aborted) setQuote("none");
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [fromId, toId, decimals, paused]);
  return quote;
}

/** True where swaps are routed privately: what these pages say of private routing is said only then. */
function usePrivateRouting(): boolean {
  return useApp((state) => isPrivateMode(state.config));
}

/** The link to the page that explains private routing. Drawn only where that page exists. */
function PrivateRoutingLink() {
  return <Link href={docHref(PRIVATE_DOC_SLUG)}>How private routing works</Link>;
}

/** The link to the page that explains Add gas, by its name. Drawn only where that page exists. */
function AddGasLink() {
  return <Link href={docHref(GAS_DOC_SLUG)}>Add gas</Link>;
}

function HowItWorks() {
  const privateOn = usePrivateRouting();
  const statsOn = useApp((state) => statsPageOn(state.config));
  return (
    <DocsLayout href={docHref(null)} title="How it works" lead={`SaplingDex swaps one coin for another, also when the two are on different chains. Swaps are powered by NEAR Intents. SaplingDex is the interface: it never holds your funds. ${INDEPENDENCE}`}>
      <DocSection title="For Sapling" id="sapling">
        <p>Sapling is a launchpad on Solana where every coin trades against ZEC. This site is the way in and the way out for every other coin and chain.</p>
        <ul>
          <li>
            <strong>The way in:</strong> pay with any coin on the list, from any chain, and receive ZEC on Solana.{privateOn ? <> With <AddGasLink /> on, a little SOL arrives too, so a new Solana wallet can trade straight away.</> : null}
          </li>
          <li>
            <strong>The way out:</strong> pay with ZEC on Solana and receive any coin on any chain.
          </li>
        </ul>
        <p>Sapling has a page of its own for moving ZEC between Zcash and Solana.</p>
      </DocSection>
      <DocSection title="Quote">
        <p>Choose the coin you pay and the coin you receive, and type an amount. The quote shows the rate, each fee, the least you will receive and how long it should take. It is refreshed while you look at it.</p>
      </DocSection>
      <DocSection title="Review">
        <p>One sheet shows the numbers and both addresses in full: where your coins are delivered, and where they come back to if the swap fails. Confirming makes an order. Making an order moves no coins.</p>
      </DocSection>
      <DocSection title="Pay">
        <p>
          Send the exact amount to the deposit address shown, from any wallet. The site connects to no wallet.
          {/* Only where Add gas is offered: a swap with gas is two orders, and so two transfers. */}
          {privateOn ? (
            <>
              {" "}
              With <AddGasLink /> there are two orders, and each is paid in this way: one transfer for the swap, and a second for the gas, each to its own address.
            </>
          ) : null}
        </p>
        <Callout tone="tip" title="You send the coins yourself.">
          <p>SaplingDex cannot move them, and never holds them.</p>
        </Callout>
      </DocSection>
      <DocSection title="Track">
        <p>
          The order has its own page. It follows the deposit, the swap and the delivery, and links to the transactions. <Link href="/track">Track order</Link> finds that page again from the order's ID or its deposit address.{privateOn ? <> A privately routed order is found from its link or ID only, never from its deposit address: the address is public, and the order's page shows both ends of the swap.</> : null}
          {statsOn ? <> Once any order has been delivered it is found from its link or ID only: its deposit is listed on the Stats page, and the order's page shows both ends of the swap.</> : null} An order made in <Link href={docHref(GHOST_DOC_SLUG)}>Ghost mode</Link> is found from its own link only, and only until it finishes.
        </p>
      </DocSection>
      {privateOn ? (
        <DocSection title="Private routing" id="private-routing">
          <p>
            Swaps are routed with NEAR Intents' confidential routing, so your deposit and your delivery are not tied to each other in public records. Both are still public transfers. Private routing is not anonymity. <PrivateRoutingLink />
          </p>
        </DocSection>
      ) : null}
    </DocsLayout>
  );
}

function Fees() {
  const tokens = useTokens((state) => state.tokens);
  const from = findToken(tokens, DEFAULT_PAIR.from.chain, DEFAULT_PAIR.from.symbol);
  const to = findToken(tokens, DEFAULT_PAIR.to.chain, DEFAULT_PAIR.to.symbol);
  const paused = useApp((state) => state.config?.paused === true || state.health === "paused");
  const quote = useExampleQuote(from, to, paused);
  const privateOn = usePrivateRouting();
  // What a swap is charged is what its quote carries back from the provider. So the figures of the
  // example are read from a quote taken as this page opened, and are left out when there is none.
  const example = quote !== null && quote !== "none" ? quote : null;
  return (
    <DocsLayout href={docHref("fees")} title="Fees" lead="SaplingDex takes no fee. The only fee is the provider's 0.20%.">
      <DocSection title="What a swap costs">
        <ul>
          <li>
            <strong>The provider's fee.</strong> NEAR Intents, which carries out the swap, takes 0.20% of the amount you pay, and less on a swap between two dollar coins. {example !== null ? <>In the quote below it is {displayBps(example.fees.providerBps)}. </> : null}Every quote shows it on a line of its own, before you confirm.
          </li>
          <li>
            <strong>The network fee of the chain you receive on.</strong> The provider takes it out of what you receive. It is already inside the amount the quote shows.
          </li>
          <li>
            <strong>The network fee of the chain you pay on.</strong> Your wallet pays it when you send. SaplingDex does not set it and does not receive it.
          </li>
        </ul>
        <p>SaplingDex adds nothing to these. A quote's "SaplingDex fee" line reads "None".</p>
        {privateOn ? <p>A privately routed swap has the same three fees, and its quote shows them the same way.</p> : null}
      </DocSection>
      <DocSection title="An example" id="example">
        {/* A real quote, taken now. If it cannot be had, the page says so and shows no numbers in its place. */}
        {from !== undefined && to !== undefined && example !== null ? (
          <>
            <p className="docs-example-title">
              Quoted just now: {EXAMPLE_AMOUNT} {from.symbol} on {chainName(from.chain)} to {to.symbol} on {chainName(to.chain)}.
            </p>
            <TableFrame label="An example quote">
              <tbody className="docs-example">
                {/* As the quote's own breakdown shows it: "None", or the figures where the server is set to take a fee. */}
                <tr>
                  <th scope="row">SaplingDex fee</th>
                  {appFeeWords(example) !== null ? (
                    <td>{appFeeWords(example)}</td>
                  ) : (
                    <td className="mono">
                      <span className="docs-part">{displayBps(example.fees.appBps)} ·</span>{" "}
                      <span className="docs-part">
                        {displayAmount(BigInt(example.fees.appAmount), from.decimals).text} {from.symbol}
                      </span>
                    </td>
                  )}
                </tr>
                <tr>
                  <th scope="row">Provider fee</th>
                  <td className="mono">
                    <span className="docs-part">{displayBps(example.fees.providerBps)} ·</span>{" "}
                    <span className="docs-part">
                      {displayAmount(BigInt(example.fees.providerAmount), from.decimals).text} {from.symbol}
                    </span>
                  </td>
                </tr>
                {example.withdrawFee !== null ? (
                  <tr>
                    <th scope="row">{chainName(to.chain)} network fee, included</th>
                    <td className="mono">
                      {displayAmount(BigInt(example.withdrawFee), to.decimals).text} {to.symbol}
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <th scope="row">You receive, about</th>
                  <td className="mono">
                    {displayAmount(BigInt(example.amountOut), to.decimals, { steady: true }).text} {to.symbol}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Minimum received</th>
                  <td className="mono">
                    {displayAmount(BigInt(example.minAmountOut), to.decimals, { steady: true }).text} {to.symbol}
                  </td>
                </tr>
              </tbody>
            </TableFrame>
          </>
        ) : quote === "none" ? (
          <p className="docs-example-none">
            {/* No figure is given here. What is charged is only known from a quote: the server's own setting is not it. */}
            {paused ? "Swaps are paused, so no example can be quoted right now. When they are on, a real quote is shown here with every fee in it." : "An example quote could not be loaded just now."} Every quote on the swap page shows the swap fee and the network fee before you confirm.
          </p>
        ) : (
          <p className="docs-example-none" aria-busy="true">
            Getting an example quote…
          </p>
        )}
      </DocSection>
    </DocsLayout>
  );
}

function Chains() {
  const tokens = useTokens((state) => state.tokens);
  // What is said of receiving ZEC at a shielded address follows the server's setting: nothing is claimed until it is proven.
  const shielded = useApp((state) => zecShieldedOf(state.config));
  // Counted only from a list fetched on this visit: a copy kept from an earlier one is not called live.
  const live = useTokens((state) => state.status === "ready");
  const chains = useMemo(() => (live ? chainsOnList(tokens) : []), [tokens, live]);
  return (
    <DocsLayout href={docHref("chains")} title="Supported chains" lead="Every coin and chain on this page is read from the live coin list, the same one the swap page uses.">
      <DocSection title="What can be swapped" id="list">
        {chains.length > 0 ? (
          <>
            <p>
              <span className="mono">{tokens.length}</span> coins on <span className="mono">{chains.length}</span> chains. The coin picker on the swap page shows every one of them.
            </p>
            <TableFrame label="Chains on the coin list">
              <thead>
                <tr>
                  <th scope="col">Chain</th>
                  <th scope="col">Coins</th>
                  <th scope="col">Time to send</th>
                </tr>
              </thead>
              <tbody className="docs-chains">
                {chains.map((chain) => (
                  <tr key={chain.key}>
                    <th scope="row">{chain.name}</th>
                    <td className="mono">{chain.coins}</td>
                    <td>{minutesText(sendWindowMs(chain.key))}</td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          </>
        ) : (
          <p>The live list of coins could not be loaded just now. The coin picker on the swap page shows every coin and chain that can be swapped.</p>
        )}
      </DocSection>
      <DocSection title="Zcash addresses" id="zcash">
        <p>ZEC on Zcash can be received at a transparent address (it starts with t1 or t3), a TEX address (tex1) or a unified address (u1). Addresses that start with zs1 are not supported.</p>
        {shielded === "proven" ? SHIELDED_DOCS.map((sentence) => <p key={sentence}>{sentence}</p>) : <p>The provider delivers to a unified address. It is not confirmed whether the ZEC arrives there shielded, so this site does not say that it does.</p>}
        <p>A unified address can also be given as the refund address when you pay with ZEC on Zcash. The provider accepts it; how a refund to one arrives is not confirmed.</p>
      </DocSection>
      <DocSection title="How you pay" id="paying">
        <p>On every chain you pay the same way: by sending to the order's deposit address, from any wallet. The site connects to no wallet.</p>
      </DocSection>
    </DocsLayout>
  );
}

function Refunds() {
  const tokens = useTokens((state) => state.tokens);
  // "Contact support" is said only where a contact is published.
  const hasContact = useApp((state) => (state.config?.supportContact ?? null) !== null);
  const live = useTokens((state) => state.status === "ready");
  const slowChains = useMemo(() => (live ? chainsOnList(tokens).filter((chain) => chain.slow) : []), [tokens, live]);
  const slow = slowChains.map((chain) => chain.name);
  const closeMinutes = minutesText(DEPOSIT_CLOSE_MS);
  return (
    <DocsLayout href={docHref("refunds")} title="Refunds and deadlines" lead="Each order gives you a set time to send your payment. If a swap cannot be completed, your coins come back to the refund address you chose.">
      <DocSection title="The time to send" id="time">
        <p>The order's page counts it down.</p>
        <ul>
          <li>
            <strong>On most chains:</strong> {minutesText(sendWindowMs(DEFAULT_PAIR.from.chain))}.
          </li>
          {slow.length > 0 ? (
            <li>
              <strong>Paying from a slower chain</strong> ({slow.join(", ")}): {minutesText(sendWindowMs(slowChains[0]?.key ?? ""))}, because their transactions take longer to confirm.
            </li>
          ) : null}
          <li>When that time is up the deposit details are taken off the page. That is {closeMinutes} before the order itself runs out, so that nothing is sent too late to arrive in time.</li>
        </ul>
      </DocSection>
      <DocSection title="When a swap cannot be completed" id="refunds">
        <p>The provider sends your coins back to the refund address you chose, on the chain you paid from. The order's page says why, and links to the refund.</p>
        <ul>
          <li>
            <strong>Less than the full amount arrives:</strong> the order shows "Deposit too small". What arrived is returned to your refund address by the deadline.
          </li>
          <li>
            <strong>The price moves past the limit you accepted:</strong> the swap is not made at a worse price. Your coins are returned. The limit is {displayBps(SLIPPAGE.default)} unless you change it: press the slippage figure in the quote. It can be set from {displayBps(SLIPPAGE.min)} to {displayBps(SLIPPAGE.max)}.
          </li>
        </ul>
      </DocSection>
      <DocSection title="What may be lost" id="lost">
        <Callout tone="warning" title="Send the exact amount, on the network shown, before the time shown.">
          <p>
            A deposit sent after the deadline, on the wrong chain, of the wrong coin, or without a memo the order asks for may be lost. Keep the order's link and the transaction hash{hasContact ? ", and contact support" : ""}.
          </p>
        </Callout>
      </DocSection>
    </DocsLayout>
  );
}

function Safety() {
  const privateOn = usePrivateRouting();
  return (
    <DocsLayout href={docHref("safety")} title="Staying safe" lead="A swap cannot be undone once the coins are sent. A minute spent checking is the only protection there is.">
      <DocSection title="Before you confirm" id="before">
        <ul>
          <li>Before you confirm in your wallet, check that it shows the same address and the same amount as the order's page.</li>
          <li>Use receiving and refund addresses of wallets you control. An exchange's deposit address may need a memo, or may not accept what is sent.</li>
          <li>New to this? Try a small amount first.</li>
        </ul>
      </DocSection>
      <DocSection title="What your wallet is asked for" id="wallet">
        <p>To pay, this site asks your wallet for nothing: it connects to no wallet. You make one plain transfer yourself, of the order's amount, to the order's deposit address. Paying never needs an approval of spending or a signed message.</p>
        {/* Only where Add gas is offered. A second transfer is then expected, and the page says exactly what it is. */}
        {privateOn ? (
          <p>
            With <AddGasLink /> there are two orders, so you make two transfers: one for the swap, and a second for the gas. Each is a plain transfer of that order's amount to that order's own deposit address.
          </p>
        ) : null}
        <p>This site never speaks to a wallet at all. No page of it asks one to connect, to approve spending or to sign anything.</p>
        <Callout tone="warning" title="Anything else is not SaplingDex.">
          <p>If a page in SaplingDex's name asks you to connect a wallet, to approve spending, or to sign anything, close it.</p>
        </Callout>
      </DocSection>
      <DocSection title="Your order's link" id="link">
        <p>
          Keep the order's link. It is the way back to the order, and anyone who has it can see the order.
          {privateOn ? <> On a privately routed swap the order's page shows both ends of it: share the link only with someone you would show both to.</> : null}
        </p>
      </DocSection>
      <DocSection title="What SaplingDex never does" id="never">
        <ul>
          <li>SaplingDex never asks for a seed phrase or a key to your wallet, and never messages you first. Anyone who does, in its name, is not SaplingDex.</li>
          {privateOn ? (
            <li>
              Your deposit and your delivery are public on-chain: anyone can see those two transfers on the chains involved. With private routing the link between them is not in public records. Private routing is not anonymity. <PrivateRoutingLink />
            </li>
          ) : (
            <li>Swaps are public on-chain. Anyone can see the transactions on the chains involved.</li>
          )}
        </ul>
      </DocSection>
    </DocsLayout>
  );
}

function Questions() {
  const contact = useApp((state) => state.config?.supportContact ?? null);
  const privateOn = usePrivateRouting();
  const shielded = useApp((state) => zecShieldedOf(state.config));
  return (
    <DocsLayout href={docHref("faq")} title="Questions" lead="Asked before a first swap, and answered in plain words.">
      {questions(privateOn, shielded).map((item: Question) => (
        <DocSection key={item.id} title={item.question} id={item.id}>
          {item.answer(contact, privateOn)}
        </DocSection>
      ))}
    </DocsLayout>
  );
}

/**
 * What private routing is, in plain words: who runs it, what stays public, what does not, who can
 * still see a swap, and what it is not. Every sentence here is held to what the provider itself
 * says of its confidential routing: the link between a deposit and a delivery is
 * not in public records, both ends are public, and nobody promises that it is complete.
 *
 * A page only where swaps are routed privately. Everywhere else its address is "Page not found."
 * (web/src/App.tsx, and server/static.ts for the server's own answer), and this is never drawn.
 */
function PrivateRouting() {
  // Where the site has its Stats page, the deposit of every delivered swap is listed there, and the list of who can see a swap says so.
  const statsOn = useApp((state) => statsPageOn(state.config));
  return (
    <DocsLayout href={docHref(PRIVATE_DOC_SLUG)} title="Private routing" lead="Swaps on this site are routed with NEAR Intents' confidential routing. With it, the link between what you send and what you receive is not in public records. This page says what that covers, and what it does not.">
      <DocSection title="What it is" id="what">
        <p>A swap has two ends: your deposit on the chain you send from, and the delivery on the chain you receive on. With ordinary routing the two can be matched to each other in public records. With private routing they are not tied to each other there.</p>
        <p>NEAR Intents, the provider, runs it and calls it confidential routing. It processes the swap on a network of its own with restricted visibility: what happens there is not published for everyone to read, as it is on a public blockchain. SaplingDex asks for this routing. It does not run it.</p>
      </DocSection>
      <DocSection title="What stays public" id="public">
        <ul>
          <li>
            <strong>Your deposit.</strong> The transfer on the chain you send from: its amount, the wallet it came from and the deposit address it went to.
          </li>
          <li>
            <strong>Your delivery.</strong> The transfer on the chain you receive on: its amount and your receiving address.
          </li>
          <li>
            <strong>A refund, if the swap fails.</strong> A transfer to your refund address, on the chain you paid from.
          </li>
        </ul>
        <p>Each is an ordinary transfer on its own blockchain, where anyone can see the addresses and the amounts.</p>
      </DocSection>
      <DocSection title="What is not public" id="not-public">
        <p>The link between your deposit and your delivery. The swap between them is processed inside the provider's confidential system, so the two are not tied to each other in public records.</p>
      </DocSection>
      <DocSection title="Who can still see a swap" id="who">
        <ul>
          <li>
            <strong>The provider's confidential system.</strong> It processes the swap and knows both ends of it.
          </li>
          <li>
            <strong>SaplingDex, for what is needed to run your order.</strong> The coins, the amounts, your addresses and the order's status. The <Link href="/privacy">Privacy Policy</Link> lists what is kept, and for how long.
          </li>
          <li>
            <strong>Anyone who has the order's link.</strong> The order's page shows both ends. Share the link only with someone you would show both to.
          </li>
          {statsOn ? (
            <li>
              <strong>Anyone, for the deposit alone.</strong> The <Link href="/stats">Stats page</Link> lists the deposit transaction of every delivered swap, privately routed or not, except one made in Ghost mode: the coin, the amount, the time and a link to it. Totals of the coins received are shown there too; which swap was delivered where is not.
            </li>
          ) : null}
        </ul>
      </DocSection>
      <DocSection title="What it is not" id="not">
        <Callout tone="warning" title="Private routing is not anonymity.">
          <p>No route guarantees it, and the provider does not promise that confidentiality is complete or without interruption.</p>
        </Callout>
        <ul>
          <li>
            <strong>It is not a way round screening.</strong> Addresses are screened against the sanctions list, by SaplingDex and by the provider, on a privately routed swap as on any other.
          </li>
          <li>
            <strong>It is not certain.</strong> Amounts and timing can give hints. Analysis of the public transfers, a failure in the systems that run it, or disclosure that a regulator requires of the provider can each weaken it.
          </li>
        </ul>
      </DocSection>
      <DocSection title="How it differs from a mixer" id="mixer">
        <p>Private routing is not a mixer. There is no pool of other people's coins that yours are mixed with, and no waiting for a crowd. It is one swap, routed by the provider, and the provider knows both ends of it.</p>
      </DocSection>
      <DocSection title="How it differs from shielded coins" id="shielded">
        <p>Shielded coins hide amounts and addresses on their own chain, by cryptography. Here the two ends of a swap are ordinary public transfers, with their amounts and addresses in the open. Only the link between them is kept out of public records.</p>
      </DocSection>
      <DocSection title="What it costs" id="cost">
        <p>SaplingDex takes no fee. The only fee is the provider's 0.20%. A privately routed swap costs what any swap does, and its quote shows it before you confirm: what you pay, and what you receive after the provider's fee and the network fee.</p>
      </DocSection>
      <DocSection title="When it is not available" id="unavailable">
        <p>When a private quote cannot be had for a swap, the card says so and offers "Swap without private routing". That is an ordinary public swap: its deposit and its delivery can be matched to each other in public records.</p>
        <Callout tone="tip" title="Nothing is switched without your choosing it.">
          <p>The review sheet and the order's page say how each order is routed.</p>
        </Callout>
      </DocSection>
    </DocsLayout>
  );
}

/**
 * Ghost mode, in plain words: the one switch, the three things it does while it is on, what is so in any mode, what it does
 * not do, what is still kept of an order made in it, and how to turn it on and off. Every sentence
 * here states what the site and its server do; none says more of a swap than is so, and what the
 * mode leaves as it was (the public transfers, the swap service, the network address) has a
 * section of its own.
 *
 * A page everywhere. Where swaps are routed privately it also says how the two sit side by side.
 */
function GhostMode() {
  const privateOn = usePrivateRouting();
  // Where the site has its Stats page, the totals an order is counted in are the ones shown there.
  const statsOn = useApp((state) => statsPageOn(state.config));
  return (
    <DocsLayout href={docHref(GHOST_DOC_SLUG)} title="Ghost mode" lead="One switch in the header. While it is on, this site keeps nothing in your browser but the switch itself, and the record of an order you make is deleted from its server when the order finishes. This page says what that covers, and what it does not.">
      <DocSection title="What it is" id="what">
        <p>Ghost mode is one switch, in the header. With it on, a swap works as it always does: a quote, a review, an order, a deposit, a delivery. What changes is what the site and your browser keep.</p>
        <p>It changes how the site is used, not the swap. The swap itself is the same, and as public as any other.</p>
      </DocSection>
      <DocSection title="What it does" id="does">
        <p>Three things, for as long as the switch is on.</p>
        <ul>
          <li>
            <strong>The switch is the one thing remembered.</strong> It is kept as a single on/off flag for this tab, so that loading the page again does not turn Ghost mode off. It ends when the tab is closed.
          </li>
          <li>
            <strong>Nothing is kept in your browser.</strong> No list of your orders, no copy of the coin list, no note of any kind: only the switch itself. Orders you made earlier, in normal mode, are not shown while Ghost mode is on. They are there again when you turn it off, unless you chose "Also clear what this browser already holds" when you turned it on.
          </li>
          <li>
            <strong>An order's record is deleted when it finishes.</strong> An order made in Ghost mode is marked as one. The moment it is delivered or refunded its record is deleted from the server. One that was never paid is deleted a day after its deadline, once the server has stopped looking for a late deposit. Until then its own link is the only way back to it: it is on no list, and it is never found from its deposit address. After that the link says only that the order finished, and in one word how: delivered, refunded, or run out.
          </li>
        </ul>
        <p>Two things are so in any mode, with the switch on or off, and so are no change. No wallet is connected to pay: you pay by sending to the order's deposit address, from any wallet. And the page asks nothing of any address but this site's own, and tells your browser to refuse anything else. A link that leaves the site still works as a plain link: it opens in a new tab, carries a small mark that says it leaves this site, and does not tell the other site where you came from.</p>
        <Callout tone="tip" title="Keep the order's link.">
          <p>It is the only way back to an order made in Ghost mode, and it is not saved anywhere. The order's page has a Copy link button.</p>
        </Callout>
      </DocSection>
      <DocSection title="What it does not do" id="not">
        <Callout tone="warning" title="Ghost mode does not make a swap less public.">
          <p>It is about what this site and your browser keep. It changes nothing on any blockchain.</p>
        </Callout>
        <ul>
          <li>
            <strong>The deposit and the delivery are still public.</strong> Each is an ordinary transfer on its own chain, where anyone can see the addresses and the amounts. So is a refund.
          </li>
          <li>
            <strong>The swap service still carries out the swap.</strong> NEAR Intents receives what it does for any swap (the coins, the amounts and your addresses) and keeps its own records.
          </li>
          <li>
            <strong>Your network address is still seen.</strong> By your own network, and by this site's host, which stands in front of the server and may keep its own record of each request. This site's own access log is kept as for any visit, with the address in a shortened form. The <Link href="/privacy">Privacy Policy</Link> says what each holds.
          </li>
          <li>
            <strong>Your browser's own history is not cleared.</strong> The browser lists the pages you open, an order's link among them, as it does for any site. That list is the browser's, not this site's.
          </li>
        </ul>
      </DocSection>
      <DocSection title="What is still kept" id="kept">
        <p>Once an order made in Ghost mode has finished, this is all the server still holds of it.</p>
        <ul>
          <li>
            <strong>A one-way fingerprint of the order's ID, with one word for how it ended, for 30 days.</strong> It is there so that the order's link can say that the order finished, and how, where it would otherwise say that there is no such order. The ID itself is not kept.
          </li>
          <li>
            <strong>Its place in the totals.</strong> {statsOn ? <>The <Link href="/stats">Stats page</Link> counts it in its totals: the swaps, the volume, the chains and the coins. It has no row among the recent swaps, and its deposit transaction is never listed.</> : <>The server's running totals count it: the swaps, the volume, the chains and the coins. No row is kept for it.</>}
          </li>
          <li>
            <strong>Lines in the logs.</strong> The server's logs name an order by a one-way fingerprint only, and are kept as for any order. For an order made in Ghost mode they carry no address and no transaction hash.
          </li>
        </ul>
        <p>Three kinds of order are kept longer, because coins may still be in them. An order that fails is kept for 30 days, as any order is, and deleted then. So is one that ran out after a transaction was named for it that could not be confirmed. An order that was sent too small a deposit is kept until that deposit has been refunded.</p>
        <Callout tone="warning" title="Pay before the order's deadline.">
          <p>A deposit sent after the deadline may be lost, as for any order. With the record deleted, there is no deposit address and no amount left here to check a late payment against.</p>
        </Callout>
      </DocSection>
      <DocSection title="What it does not change" id="same">
        <p>Ghost mode switches off no check and adds no fee. The quote and the provider's signature on it are checked, the limits apply, and every address is screened against the sanctions list, as for any order.</p>
        <p>A swap costs what it costs in normal mode, and its quote shows every fee before you confirm.</p>
      </DocSection>
      {privateOn ? (
        <DocSection title="Ghost mode and private routing" id="private-routing">
          <p>
            They are two separate things. Private routing is how the swap service routes a swap. Ghost mode is what this site and this browser keep. Either can be on without the other. Swaps on this site are routed privately, so an order made in Ghost mode is routed privately too. <PrivateRoutingLink />
          </p>
        </DocSection>
      ) : null}
      <DocSection title="Turning it on and off" id="switch">
        <p>Press the Ghost mode button in the header. The first time since the page was loaded, a short sheet says what the mode does and asks "Turn on" or "Not now". The same sheet offers "Also clear what this browser already holds", which removes what the site kept here in normal mode.</p>
        <p>While it is on, the Ghost mode button in the header is shown as on. Press it to turn the mode off. The page then loads itself again, in normal mode.</p>
        <p>Closing the tab turns it off as well.</p>
      </DocSection>
    </DocsLayout>
  );
}

/**
 * Add gas, in plain words: what the switch does, when it is there, the two payments, that each
 * order stands alone, where the gas goes and how it is routed, what it costs, what it adds to
 * the totals, and Ghost mode. Every sentence here states what the site and its
 * server do. The sizes are read from the rule the server itself uses (shared/gas.ts).
 *
 * A page only where swaps are routed privately, as the page on private routing is: gas is only
 * ever added beside a privately routed swap, so anywhere else there is no switch to explain, its
 * address is "Page not found.", and this is never drawn.
 */
function AddGas() {
  // Where the site has its Stats page, the totals a gas order is counted in are the ones shown there.
  const statsOn = useApp((state) => statsPageOn(state.config));
  const sizes = gasSizes();
  return (
    <DocsLayout href={docHref(GAS_DOC_SLUG)} title="Add gas" lead="A switch on the swap card. With it on, a second, small order delivers a little of the receiving chain's own coin to the same address as your swap, so that a wallet with nothing in it can pay network fees and move what arrived straight away.">
      <DocSection title="What it does" id="what">
        <p>Each chain has a coin of its own, and its network fees are paid in that coin: SOL on Solana, for example. When a swap delivers another coin to a new, empty wallet, such as USDC on Solana, the coins arrive and cannot be moved, because the wallet has none of the chain's own coin to pay a fee with.</p>
        <p>With Add gas switched on, a second, small order is made beside the swap. It delivers a little of the receiving chain's own coin to the same receiving address, so the wallet can pay network fees and move what arrived straight away.</p>
        <p>
          A gas order is for about ${sizes.usual}.{sizes.larger.length > 0 ? <> {listed(sizes.larger.map((size, index) => `${index === 0 ? "On" : "on"} ${listed(size.chains)} ${index === 0 ? "it is " : ""}about $${size.usd}`))}.</> : null} The review shows how much of the chain's own coin arrives, before you confirm.
        </p>
        <Callout tone="tip" title="No contract is involved.">
          <p>It is done with ordinary orders and plain transfers. SaplingDex never holds your funds.</p>
        </Callout>
      </DocSection>
      <DocSection title="When the switch is there" id="when">
        <p>The switch is on the swap card, under the receiving address. It is offered when all of these are so:</p>
        <ul>
          <li>
            <strong>The coin you receive is not its chain's own coin.</strong> USDC on Solana is one such: fees there are paid in SOL.
          </li>
          <li>
            <strong>The swap is privately routed.</strong> Gas is offered only beside a privately routed swap.
          </li>
          <li>
            <strong>A valid receiving address is on the card.</strong> Gas is for that address, so the switch arrives once it is entered.
          </li>
          <li>
            <strong>The coin you pay with is not the receiving chain's own coin.</strong> An order cannot swap a coin for itself.
          </li>
          <li>
            <strong>The swap service will take the small order just then.</strong>
          </li>
        </ul>
        <p>Where it is not offered, there is no switch.</p>
      </DocSection>
      <DocSection title="Two payments" id="payments">
        <p>The gas order is paid with the same coin as the swap. So there are two payments: one for the swap, and one for the gas.</p>
        <ul>
          <li>Two deposit addresses, one for each order, and two separate transfers from your own wallet.</li>
        </ul>
        <Callout tone="warning" title="Two separate transfers, never combined.">
          <p>Each order has its own deposit address and its own amount. Send each amount to its own address.</p>
        </Callout>
      </DocSection>
      <DocSection title="Each order stands alone" id="alone">
        <p>The gas order is an ordinary order, with its own quote, its own deposit address, its own deadline and its own refund. Neither order waits for the other.</p>
        <ul>
          <li>
            <strong>Only the swap is paid:</strong> the swap is delivered. The gas order runs out unpaid, and nothing is lost.
          </li>
          <li>
            <strong>Only the gas is paid:</strong> the gas arrives.
          </li>
          <li>
            <strong>The gas order cannot be made at the moment you confirm:</strong> the swap is made all the same, and its page says that gas was not added.
          </li>
        </ul>
      </DocSection>
      <DocSection title="Where the gas goes" id="where">
        <p>Always to the swap's receiving address. No other address can be given for it.</p>
        <p>
          The gas order is only ever routed privately, like the swap beside it. So the gas arrives by the same private route, and a new wallet needs no funding from an old one. Its deposit and its delivery are still public transfers, as the swap's are. With gas there are two of each, close together in time: two deposits from the paying wallet, and two deliveries to the receiving address. Private routing is not anonymity. <PrivateRoutingLink />
        </p>
      </DocSection>
      <DocSection title="What it costs" id="cost">
        <p>SaplingDex takes no fee on either order. The provider's fee and the receiving chain's network fee apply to the gas order as to any order, and both are shown before you confirm.</p>
      </DocSection>
      <DocSection title="In the totals" id="totals">
        <p>{statsOn ? <>On the <Link href="/stats">Stats page</Link> its value in US dollars is counted in the volume. It is not counted as another swap, and it has no row among the recent swaps.</> : <>The server's running totals count its value in US dollars in the volume. It is not counted as another swap, and no row is kept for it.</>}</p>
      </DocSection>
      <DocSection title="In Ghost mode" id="ghost-mode">
        <p>
          Add gas works in <Link href={docHref(GHOST_DOC_SLUG)}>Ghost mode</Link>. Both orders are then made in Ghost mode, and the record of each is deleted when that order is delivered or refunded.
        </p>
      </DocSection>
    </DocsLayout>
  );
}

const PAGES: Record<DocSlug, () => React.JSX.Element> = { fees: Fees, chains: Chains, refunds: Refunds, safety: Safety, private: PrivateRouting, "ghost-mode": GhostMode, "add-gas": AddGas, faq: Questions };

export default function DocsPage({ slug }: { slug: DocSlug | null }) {
  const Page = slug === null ? HowItWorks : PAGES[slug];
  return <Page />;
}
