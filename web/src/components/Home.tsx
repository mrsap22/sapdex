// The home page around the swap card: a headline above it and, beneath it, what the site is
// and does. Every number shown is counted from live data; where the data has not arrived the
// number is left out, never guessed. Nothing here is a box: type, space, thin rules and one
// drawing to a section.

import { ArrowRight, Ban, Check, CircleHelp, ExternalLink } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { chainName, explorerAddressUrl } from "../../../shared/chains.ts";
import { PRIVATE_DOC_SLUG } from "../../../shared/pages.ts";
import type { TokenFacts } from "../../../shared/api.ts";
import { HEADLINE_SUB, headlineWords, INDEPENDENCE } from "../../../shared/positioning.ts";
import { docHref } from "../lib/docs-logic.ts";
import { chainIconUrl } from "../lib/icons.ts";
import { useCountUp, useSeen } from "../lib/reveal.ts";
import { chainsOnList, isPrivateMode, listCounts, PRIVATE_MEANS } from "../lib/site-logic.ts";
import { statsPageOn } from "../lib/stats-logic.ts";
import { usdMicroText } from "../lib/rewards-logic.ts";
import { briefPoints, RESERVE_ASSET, type RewardsPublic } from "../../../shared/rewards.ts";
import { SHIELDED_HOME, zecShieldedOf } from "../../../shared/shielded.ts";
import { api } from "../api.ts";
import { useApp } from "../stores/app.ts";
import { useTokens } from "../stores/tokens.ts";
import { Address } from "./Address.tsx";
import { Amount } from "./Amount.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Link } from "./Link.tsx";
import { Reveal } from "./Reveal.tsx";
import { Stage } from "./Stage.tsx";
import "../styles/home.css";
import { OutboundLink } from "./OutboundLink.tsx";

/** The chain the coin lives on: Solana. The server accepts a coin's address for this chain only. */
const TOKEN_CHAIN = "sol";

/** Where a coin's own page is on Sapling, the launchpad it was planted on. Built from the coin's address alone. */
const saplingCoinUrl = (mint: string) => `https://sapling.cash/coin/${mint}`;

/** Hundredths of a percent as a percentage with two decimals: 125 gives "1.25%". */
const percentOf = (bps: number) => `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;

/** A small label above each headline, and optionally a sentence under it. On a page of its own the headline is the page's title. */
export function SectionHead({ tag, title, id, level = 2, children }: { tag: string; title: string; id: string; level?: 1 | 2; children?: ReactNode }) {
  const Title = level === 1 ? "h1" : "h2";
  return (
    <Reveal as="header" className="section-head">
      <p className="section-tag mono">{tag}</p>
      <Title id={id} className="section-title">
        {title}
      </Title>
      {children !== undefined ? <p className="section-lead muted">{children}</p> : null}
    </Reveal>
  );
}

/**
 * How far into its entrance the headline already is when this component first draws it, in
 * milliseconds. The page itself holds the same words and starts the same entrance before any
 * script arrives (web/index.html); this component draws over them and carries on from the same
 * moment, so the words are never seen to start again. Once played, it is not played again.
 */
let headlineElapsed: number | null = null;
function elapsedSoFar(): number {
  if (headlineElapsed !== null) return headlineElapsed;
  let elapsed = 0;
  if (typeof document !== "undefined") {
    const word = document.querySelector(".first-paint .headline-word");
    const running = word !== null && typeof word.getAnimations === "function" ? word.getAnimations()[0] : undefined;
    if (running !== undefined && typeof running.currentTime === "number") elapsed = running.currentTime;
  }
  // The next time the headline is drawn (coming back to this page), its entrance is long over.
  headlineElapsed = 60_000;
  return elapsed;
}

/** One word of the headline. Each comes up a moment after the one before it. */
const word = (index: number): CSSProperties => ({ "--i": index }) as CSSProperties;

/**
 * Above the card. Short enough that the card stays on the first screen of a phone and of a laptop.
 * The words are the site's first words (shared/positioning.ts): one set where swaps are routed
 * privately and another where they are not. Which it is, is known from the first moment (see
 * isPrivateMode), so these are the words the page itself already shows and nothing changes under
 * the reader's eye.
 */
export function Headline() {
  const [elapsed] = useState(elapsedSoFar);
  const privateOn = useApp((state) => isPrivateMode(state.config));
  return (
    <div className="headline" style={{ "--elapsed": `${Math.round(elapsed)}ms` } as CSSProperties}>
      {/* Two lines: what the site does, then what it is built on, in the accent colour. Each keeps to itself, however the words wrap. */}
      <p className="headline-title">
        {[false, true].map((accent) => (
          <Fragment key={String(accent)}>
            {accent ? " " : null}
            <span className="headline-line">
              {headlineWords(privateOn ? "private" : "public")
                .map((item, index) => ({ ...item, index }))
                .filter((item) => item.accent === accent)
                .map((item, at) => (
                  <Fragment key={item.index}>
                    {at > 0 ? " " : null}
                    <span className={item.accent ? "headline-word headline-accent" : "headline-word"} style={word(item.index)}>
                      {item.text}
                    </span>
                  </Fragment>
                ))}
            </span>
          </Fragment>
        ))}
      </p>
      <p className="headline-sub muted">{HEADLINE_SUB}</p>
    </div>
  );
}

/** How many coins and chains the live list holds. Null until the list has arrived. */
function useListCounts(): { coins: number; chains: number } | null {
  const tokens = useTokens((state) => state.tokens);
  // "Live" means fetched from the server on this visit. A copy kept from an earlier visit is not counted.
  const live = useTokens((state) => state.status === "ready");
  return useMemo(() => (live ? listCounts(tokens) : null), [tokens, live]);
}

/**
 * The chains on the live coin list, each with its mark, passing slowly under the first screen.
 * It stops under the pointer. The marks are shown in one colour. A screen reader is given the
 * list once, as a sentence; the moving copy is not read.
 */
function ChainStrip() {
  const tokens = useTokens((state) => state.tokens);
  const chains = useMemo(() => chainsOnList(tokens).filter((chain) => chainIconUrl(chain.key) !== null), [tokens]);
  // The strip keeps its place while the list is on its way, so that nothing under it moves when it arrives.
  return (
    <div className="strip">
      {chains.length > 0 ? (
        <>
          <p className="sr-only">Chains on the coin list: {chains.map((chain) => chain.name).join(", ")}.</p>
          <div className="strip-track" aria-hidden="true">
            {[0, 1].map((copy) => (
              <ul key={copy} className="strip-row">
                {chains.map((chain) => (
                  <li key={chain.key} className="strip-item">
                    <img src={chainIconUrl(chain.key) ?? ""} alt="" width={20} height={20} decoding="async" loading="lazy" />
                    <span>{chain.name}</span>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** How many swaps the site has delivered, from the Stats page's own totals. Null until it is known, and where the Stats page is off. */
function useSwapsTotal(): number | null {
  const on = useApp((state) => statsPageOn(state.config));
  const [swaps, setSwaps] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.stats().then(
      (stats) => {
        if (live) setSwaps(stats.totals.swaps);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [on]);
  return on ? swaps : null;
}

/**
 * What anyone may see of the rewards: the week's points and the pool. Asked of the server here, by
 * itself: the home page has nothing to do with the Rewards page's sign-in and does not load it.
 * Null until it arrives, and if it does not.
 */
function useRewardsSummary(): RewardsPublic | null {
  const [summary, setSummary] = useState<RewardsPublic | null>(null);
  useEffect(() => {
    let live = true;
    api.rewards().then(
      (answer) => {
        if (live) setSummary(answer);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return summary;
}

/** One figure of the strip beside the headline: a small label, the number, and at most a quiet note under it. */
function Figure({ label, note, warm = false, children }: { label: string; note?: ReactNode; warm?: boolean; children: ReactNode }) {
  return (
    <li className="figure">
      <p className="figure-label">{label}</p>
      <p className={warm ? "figure-value mono figure-warm" : "figure-value mono"}>{children}</p>
      <p className="figure-note mono">{note}</p>
    </li>
  );
}

/**
 * Beside the headline: a strip of plain numbers, each one read from the site's own data and each
 * one checkable (the pool on the Rewards page, with a link to the wallet; the swaps on the Stats
 * page; the chains in the coin picker). A number that has not arrived, or cannot be read, is not
 * there: nothing stands in for it. The strip keeps its height from the first paint, so nothing
 * under it moves as the numbers come in.
 */
export function HeroFigures() {
  const summary = useRewardsSummary();
  const counts = useListCounts();
  const swaps = useSwapsTotal();
  const pool = summary?.pool ?? null;
  return (
    <ul className="figures" aria-label="In numbers">
      {pool !== null && pool.amount !== null ? (
        <Figure label="Pool this week" warm note={pool.usdMicro !== null ? <>about {usdMicroText(BigInt(pool.usdMicro))}</> : null}>
          <Amount raw={pool.amount} decimals={pool.decimals} symbol={RESERVE_ASSET.symbol} />
        </Figure>
      ) : null}
      {summary !== null ? <Figure label="Points this week">{briefPoints(BigInt(summary.weekPointsMicro))}</Figure> : null}
      {swaps !== null && swaps > 0 ? <Figure label="Swaps delivered">{swaps.toLocaleString("en-US")}</Figure> : null}
      {counts !== null ? <Figure label="Chains">{counts.chains}</Figure> : null}
    </ul>
  );
}

/** A number that counts up once, when it first comes into view. A screen reader is given the number itself. */
function Count({ value, go }: { value: number; go: boolean }) {
  const shown = useCountUp(value, go);
  return (
    <>
      <span className="mono fact-number" aria-hidden="true" style={{ "--digits": String(value).length } as CSSProperties}>
        {shown}
      </span>
      <span className="sr-only">{value}</span>
    </>
  );
}

/** Three facts in large type, side by side, with a thin rule between them and nothing round them. */
function FactStrip() {
  const counts = useListCounts();
  // While the list is on its way the third fact keeps its place; once it is known that no live list is to be had (none at all, or only a copy kept from an earlier visit), the fact is left out.
  const waiting = useTokens((state) => state.status === "loading");
  const [ref, seen] = useSeen<HTMLUListElement>();
  return (
    <ul ref={ref} className="facts" aria-label="In short" data-reveal="" data-in={seen ? "" : undefined}>
      <li className="fact">
        <p className="fact-label mono">Custody</p>
        <p className="fact-title">No custody</p>
        <p className="muted">SaplingDex never holds your funds.</p>
      </li>
      <li className="fact">
        <p className="fact-label mono">Paying</p>
        <p className="fact-title">To a deposit address</p>
        <p className="muted">You send from any wallet. The site connects to none.</p>
      </li>
      {/* Counted from the list the swap card itself uses, and from a live one only. */}
      {counts === null && !waiting ? null : (
        <li className="fact">
          <p className="fact-label mono">Reach</p>
          <p className="fact-title">
            {counts !== null ? (
              <>
                <Count value={counts.coins} go={seen} /> coins on <Count value={counts.chains} go={seen} /> chains
              </>
            ) : (
              <span className="skeleton fact-waiting" aria-hidden="true" />
            )}
          </p>
          <p className="muted">Counted from the live coin list.</p>
        </li>
      )}
    </ul>
  );
}

function WhatItDoes() {
  return (
    <section className="section" aria-labelledby="does-title">
      <SectionHead tag="The product" title="What SaplingDex does" id="does-title" />
      <Reveal>
        <Stage />
      </Reveal>
    </section>
  );
}

/**
 * One line drawing in three parts, each lit as its step is reached: what you pay, the deposit
 * address, what you receive. The dashed line is the way back if a swap fails.
 */
function FlowDiagram({ reached }: { reached: number }) {
  return (
    <figure className="diagram" data-reached={reached}>
      <svg viewBox="0 0 360 150" role="img" aria-labelledby="diagram-title" focusable="false">
        <title id="diagram-title">Your coins go to a deposit address and arrive as the coin you chose. If the swap fails they come back to you.</title>
        <g className="diagram-part" data-part="1" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle className="diagram-line" cx="44" cy="52" r="26" />
          <path className="diagram-line" d="M34 52h20M44 42v20" />
        </g>
        <g className="diagram-part" data-part="2" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path className="diagram-accent diagram-arrow" d="M78 52h52M122 44l8 8-8 8" />
          <rect className="diagram-line" x="140" y="24" width="80" height="56" rx="12" />
          <path className="diagram-line" d="M162 44h36M162 60h22" />
        </g>
        <g className="diagram-part" data-part="3" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path className="diagram-accent diagram-arrow" d="M230 52h52M274 44l8 8-8 8" />
          <circle className="diagram-accent" cx="316" cy="52" r="26" />
          <path className="diagram-accent" d="M305 52l8 8 14-16" />
          <path className="diagram-line" strokeDasharray="4 6" d="M180 88v26a12 12 0 0 1-12 12H56a12 12 0 0 1-12-12V88" />
          <path className="diagram-line" d="M36 96l8-8 8 8" />
        </g>
      </svg>
      <figcaption className="diagram-caption muted">
        <span>You pay</span>
        <span>Deposit address</span>
        <span>You receive</span>
        <span className="diagram-note">Dashed line: your refund if the swap fails.</span>
      </figcaption>
    </figure>
  );
}

/** The three steps. Where Add gas is offered (only where swaps are routed privately), the third says that a swap with gas is paid with a second transfer. */
const steps = (privateOn: boolean): { title: string; text: string }[] => [
  { title: "Quote", text: "Choose what you pay and what you receive. The quote shows the rate, every fee and the least you will get." },
  { title: "Review", text: "Check both addresses and the numbers on one sheet. Nothing leaves your wallet until you pay." },
  { title: "Pay and track", text: `Send one transfer to the deposit address shown${privateOn ? "; with Add gas on, a second for the gas" : ""}. The order's page follows it to the end.` },
];

/** One step. It says when it has first come into view, and a line is drawn down from its number to the next. */
function Step({ index, title, text, onSeen }: { index: number; title: string; text: string; onSeen(index: number): void }) {
  const [ref, seen] = useSeen<HTMLLIElement>(0.2);
  useEffect(() => {
    if (seen) onSeen(index);
  }, [seen, index, onSeen]);
  return (
    <li ref={ref} className="how-step" data-in={seen ? "" : undefined}>
      <span className="how-number mono" aria-hidden="true">
        {index + 1}
      </span>
      <div className="how-words">
        <h3 className="how-title">{title}</h3>
        <p className="muted">{text}</p>
      </div>
    </li>
  );
}

function HowItWorks({ privateOn }: { privateOn: boolean }) {
  // How many of the steps have been reached. It only ever goes up.
  const [reached, setReached] = useState(0);
  const mark = useRef((index: number) => setReached((before) => Math.max(before, index + 1))).current;
  return (
    <section className="section" aria-labelledby="how-title">
      <SectionHead tag="How it works" title="Three steps" id="how-title" />
      <div className="how">
        <ol className="how-steps">
          {steps(privateOn).map((step, index) => (
            <Step key={step.title} index={index} title={step.title} text={step.text} onSeen={mark} />
          ))}
        </ol>
        <FlowDiagram reached={reached} />
      </div>
    </section>
  );
}

function Statement({ kind, title, children }: { kind: "do" | "dont"; title: string; children: ReactNode }) {
  return (
    <li className="statement" data-kind={kind}>
      {kind === "do" ? <Check size={20} strokeWidth={1.5} aria-hidden="true" /> : <Ban size={20} strokeWidth={1.5} aria-hidden="true" />}
      <div>
        <p className="statement-title">{title}</p>
        <p className="muted">{children}</p>
      </div>
    </li>
  );
}

/**
 * Four statements where swaps are routed in public. Where they are routed privately there are
 * three: the fourth, that swaps are public, is not true there as it stands, and a section of its
 * own says exactly what is public and what is not (see PrivateMeans).
 */
function DoAndDont({ privateOn }: { privateOn: boolean }) {
  // Said only once a real swap has shown it (the server's setting): until then nothing here speaks of shielded ZEC.
  const shielded = useApp((state) => zecShieldedOf(state.config));
  return (
    <section className="section" aria-labelledby="do-title">
      <SectionHead tag="Plainly" title="What we do, and what we don't" id="do-title" />
      <Reveal as="ul" className="statements" data-count={privateOn && shielded !== "proven" ? 3 : undefined}>
        <Statement kind="dont" title="We never hold your funds.">
          Your coins go from you to the provider's deposit address, and from there to your receiving address.
        </Statement>
        <Statement kind="do" title="The fee is shown before you commit.">
          SaplingDex takes no fee. The only fee is the provider's 0.20%. Every quote shows it, and the network fee, before you confirm.
        </Statement>
        <Statement kind="do" title="If a swap fails, the provider refunds you.">
          The refund goes to the refund address you chose, on the chain you paid from.
        </Statement>
        {shielded === "proven" ? (
          <Statement kind="do" title="ZEC can arrive at a shielded address.">
            {SHIELDED_HOME}
          </Statement>
        ) : null}
        {privateOn ? null : (
          <Statement kind="dont" title="Swaps are public on-chain: this is not a privacy tool.">
            Anyone can see the transactions on the chains involved.
          </Statement>
        )}
      </Reveal>
    </section>
  );
}

/**
 * Shown only where swaps are routed privately, in place of the statement that swaps are public:
 * what stays public, what does not, and who can still see a swap. Three rows of plain words with a
 * thin rule between them, and a link to the page that explains the rest.
 */
function PrivateMeans() {
  return (
    <section className="section" aria-labelledby="means-title">
      <SectionHead tag="Private routing" title="What private means here" id="means-title" />
      <Reveal as="dl" className="means">
        {PRIVATE_MEANS.map((row) => (
          <div key={row.label} className="means-row">
            <dt className="means-label">{row.label}</dt>
            <dd className="muted">{row.text}</dd>
          </div>
        ))}
      </Reveal>
      <Link href={docHref(PRIVATE_DOC_SLUG)} className="stage-link draw means-more">
        How private routing works
        <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
      </Link>
    </section>
  );
}

/** What Sapling says of the coin, asked of this site's own server. Null until it arrives, and if it does not. */
function useTokenFacts(wanted: boolean): TokenFacts | null {
  const [facts, setFacts] = useState<TokenFacts | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    api.tokenFacts().then(
      (answer) => {
        if (live) setFacts(answer);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return facts;
}

/**
 * Facts about the coin, and nothing else: its address, its chain, what it trades against, where it
 * was planted, and how its trades feed the pool. No price, no market value and no chart. Not shown
 * at all until the coin's address has been set.
 *
 * How the coin feeds the pool is said from what this site's server read from Sapling itself: the
 * split of Sapling's fee in Sapling's own numbers, and, only where Sapling says so, that this
 * coin's share goes to the pool's wallet. A part that could not be read is left out.
 */
export function TokenSection({ ownPage = false }: { ownPage?: boolean }) {
  const address = useApp((state) => state.config?.tokenAddress ?? null);
  const pool = useApp((state) => state.config?.reserveAddress ?? null);
  const facts = useTokenFacts(address !== null);
  if (address === null) return null;
  const tokenUrl = explorerAddressUrl(TOKEN_CHAIN, address, "token");
  const poolUrl = pool !== null ? explorerAddressUrl(TOKEN_CHAIN, pool) : null;
  const fee = facts?.fee ?? null;
  return (
    <section className="section" id="token" aria-labelledby="token-title">
      <SectionHead tag="$SAPDEX" title="The $SAPDEX coin" id="token-title" level={ownPage ? 1 : 2} />
      <Reveal as="dl" className="token-facts">
        <div className="token-fact">
          <dt className="muted">Address</dt>
          <dd>
            <span className="token-address">
              <Address value={address} />
            </span>
            <CopyButton value={address} what="the coin's address" />
            {tokenUrl !== null ? <Outbound href={tokenUrl}>View on Solscan</Outbound> : null}
          </dd>
        </div>
        <div className="token-fact">
          <dt className="muted">Chain</dt>
          <dd>{chainName(TOKEN_CHAIN)}</dd>
        </div>
        <div className="token-fact">
          <dt className="muted">Trades against</dt>
          <dd>ZEC</dd>
        </div>
        <div className="token-fact">
          <dt className="muted">Planted on</dt>
          <dd>
            Sapling
            <Outbound href={saplingCoinUrl(address)}>The coin's page on Sapling</Outbound>
          </dd>
        </div>
      </Reveal>
      {/* How a trade of the coin reaches the pool, in Sapling's own numbers as this site's server last read them. Left out where they could not be read. */}
      <div className="token-pool" aria-live="polite">
        {fee !== null ? (
          <p className="token-words">
            On Sapling, {percentOf(fee.totalBps)} of every trade of a coin is taken in ZEC and split by Sapling's program: {percentOf(fee.liquidityBps)} to liquidity, {percentOf(fee.burnBps)} to burning $SAPLING, {percentOf(fee.saplingBps)} to Sapling, and{" "}
            {percentOf(fee.planterBps)} to wherever the coin's planter chose.{facts?.feedsPool === true ? <> For this coin that is the pool's wallet: each week the ZEC it holds is shared out, by points, to the people who swapped here.</> : null} These are Sapling's numbers, and
            Sapling can change them. The venue the coin trades on adds a fee of its own.
          </p>
        ) : null}
        {facts?.feedsPool === true && pool !== null ? (
          <p className="token-words">
            <Link href="/rewards">See the pool</Link>
            {poolUrl !== null ? <Outbound href={poolUrl}>The pool's wallet on Solscan</Outbound> : null}
          </p>
        ) : null}
      </div>
      <p className="token-words muted">{INDEPENDENCE}</p>
    </section>
  );
}

function Outbound({ href, children }: { href: string; children: ReactNode }) {
  return (
    <OutboundLink href={href} className="outbound">
      {children}
      <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </OutboundLink>
  );
}

/** Everything beneath the card, in order. The questions and the footer follow. */
export function HomeSections() {
  const privateOn = useApp((state) => isPrivateMode(state.config));
  return (
    <div className="home">
      <ChainStrip />
      <FactStrip />
      <WhatItDoes />
      <HowItWorks privateOn={privateOn} />
      <DoAndDont privateOn={privateOn} />
      {privateOn ? <PrivateMeans /> : null}
      <TokenSection />
    </div>
  );
}

/** Everything on a page that can be pressed or typed into. Help never lies over one of these. */
const CONTROLS = "main a, main button, main summary, main input, main textarea, main select, main label, footer a, footer button";

/**
 * A small button that stays in the corner and leads to the questions. A region of its own, so that
 * it is not loose on the page for someone moving by landmarks. It floats over the page, so as the
 * page scrolls it looks at what is under it: wherever that is something to press or type into
 * (a question's row, a link in a list, a button), it steps out of the way until the control has passed.
 */
export function HelpButton({ href }: { href: string }) {
  const region = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    let frame = 0;
    const look = () => {
      frame = 0;
      const help = region.current?.querySelector<HTMLElement>(".help");
      if (!help) return;
      const box = help.getBoundingClientRect();
      // Not drawn at all (see the stylesheet's own exceptions): nothing to decide.
      if (box.width === 0) return;
      let covered = false;
      for (const control of document.querySelectorAll<HTMLElement>(CONTROLS)) {
        const other = control.getBoundingClientRect();
        if (other.width === 0 || other.height === 0) continue;
        if (other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top) {
          covered = true;
          break;
        }
      }
      setOver(covered);
    };
    const ask = () => {
      if (frame === 0) frame = requestAnimationFrame(look);
    };
    // The page moves under it when it is scrolled or resized, and when its content changes (a page opens, a question unfolds).
    window.addEventListener("scroll", ask, { passive: true });
    window.addEventListener("resize", ask);
    // And when something on the page has finished moving into its place (a section coming into view rises a little as it arrives).
    document.addEventListener("transitionend", ask, true);
    document.addEventListener("animationend", ask, true);
    const watcher = new MutationObserver(ask);
    watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "data-page", "hidden"] });
    ask();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", ask);
      window.removeEventListener("resize", ask);
      document.removeEventListener("transitionend", ask, true);
      document.removeEventListener("animationend", ask, true);
      watcher.disconnect();
    };
  }, []);
  return (
    <aside aria-label="Help" ref={region}>
      <Link href={href} className="help" title="Help" data-over={over || undefined}>
        <CircleHelp size={20} strokeWidth={1.5} aria-hidden="true" />
        <span className="help-label">Help</span>
      </Link>
    </aside>
  );
}
