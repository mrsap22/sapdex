# SaplingDex

A cross-chain swap website, made for people who use Sapling, the launchpad on
Solana where every coin trades against ZEC. Bring any coin from any chain and
arrive on Solana with ZEC, or take ZEC out to any coin on any chain: see a
quote, pay to a deposit address, and track the swap until the coins arrive.

Swaps are executed by NEAR Intents 1Click. SaplingDex is an interface only: it
writes no swap contracts and never holds user funds.

SaplingDex is an independent project and is not affiliated with or endorsed by
Sapling, the Zcash Foundation, Electric Coin Co. or NEAR.

## How it fits together

```
Browser (React) ──HTTPS──▶ Our server (Node) ──HTTPS──▶ Swap provider
   │ no wallet connected        │ order store (disk)
   └─ asks this site only       └─ status poller
```

- `server/` the Node server (`node:http`, run with `tsx`)
- `web/` the React site (Vite)
- `shared/` code used by both: money maths, address checks, the API contract
- `test/` automated tests

Rules the code keeps:

- Amounts are `BigInt` on integer strings. Never floating point.
- The server sets the fee and the deposit address. The browser cannot send or change either.
- Every quote from the provider is verified (signature, then a field-by-field comparison with what was asked) before it is stored or shown.
- The site connects to no wallet. An order is paid by sending to its deposit address: one transfer for a swap, and a second, to its own address, when gas is added.
- The site never speaks to any wallet at all: it asks none to connect, to sign or to approve, on any page, and the built site holds no code that could.
- The browser asks this site and nothing else: never the provider, a chain's node, Sapling or a font host. It never sees a key.
- The site never holds anyone's funds, for any reason.

## Commands

| Command | What it does |
|---|---|
| `npm ci --ignore-scripts` | Install exactly what the lockfile says |
| `npm run check:lock` | Before a push: try a clean install from the lockfile, without installing anything, under the npm this project is pinned to (`packageManager` in `package.json`) and under an older and the newest npm. A lockfile that one of them would refuse is caught here, not by the automatic check |
| `npm run dev` | Server on port 8787 plus the site on port 5173 |
| `npm test` | All automated tests |
| `npm run lint` | Lint and type-check |
| `npm run build` | Build the site and check the output for secrets and size |
| `npm start` | Run the server, which also serves the built site |
| `npx tsx scripts/live-check.ts` | Check the real server code against the real provider, with price previews only |
| `npx tsx scripts/live-survey.ts` | Ask the real provider what it accepts today on every chain (previews only) |
| `npx tsx scripts/mutation-check.ts` | Switch off each protection in turn and confirm a test notices |
| `npx tsx scripts/review-shots.ts <url>` | Walk the site in a real browser: screenshots of every state at three widths in both themes, plus checks of behaviour (see below) |
| `npm run check:pages` | Measure the built pages in a real browser: Lighthouse (performance 90 or more, accessibility 100, layout shift 0.05 at most) and the axe accessibility rules for WCAG 2.2 AA The speed score is taken on a pretend phone; on a slower machine (the automatic check's, say) the phone's processor is slowed less, by the measuring tool's own table, so that the same phone is measured everywhere, and a page that falls just short is measured twice more and judged by the middle score. On GitHub's shared machines the speed score and the paint time are printed as warnings and do not fail the run; accessibility and layout shift fail it everywhere |
| `npx tsx scripts/make-brand.ts` | Make the emblem the page uses, the favicons, the home-screen icons and the web manifest again from the one vector in `web/src/assets/brand/` (only when it changes) |
| `npm run check:logos -- http://127.0.0.1:8799` | Ask a running site for its coin list and fail, naming them, if a listed coin has no logo. Run it after the provider lists new coins. A coin that was looked for and is not in the logo collection is named in the script's own list, and is shown as a plain coin drawing until it has one |
| `npx tsx scripts/make-coin-icons.ts` | Make the coin and chain icons again from the logo files in `web/src/assets/coins/` and `web/src/assets/chains/` (only when one is added or changed): each becomes a 96 px WebP under `web/public/` |
| `npx tsx scripts/make-share.ts <url>` | Redraw the image a shared link shows (`web/public/share.png`) from the running site |

Node 24 is required.

### Local development never creates a real order

Outside production the server refuses to create a real order at the provider.
To practise the whole flow with pretend orders, start with the practice
provider:

```
PROVIDER_STUB=true npm run dev
```

Price previews still come from the real provider (read-only). Orders, deposit
addresses and statuses are made up locally, and the server listens on this
machine only. Production refuses to start with the practice provider on.

`npm run dev` reads variables from a local `.env` file when there is one (copy
`.env.example`). It is git-ignored.

### Checking against the real provider

`npx tsx scripts/live-check.ts` runs the real server code against the real
provider using price previews only: it can never create an order. Run it before
a release and whenever the provider announces a change. It was this check that
found the provider answering under a different ID for Bitcoin.

`npx tsx scripts/live-survey.ts` tries a small preview in both directions on
every chain and prints what the provider says: accepted, a minimum, or no
route. It also prints how a fee is split. Add `--all-coins` to try every coin
(several minutes). Previews only.

Neither script can reach the parts that need a real order: the deposit address
of a real order, the status reply, and passing a deposit hash on. Those have
only ever run against the practice provider.

### Checking the site in a real browser

`npx tsx scripts/review-shots.ts http://127.0.0.1:8799` needs the site running
locally (`npm run build`, then `NODE_ENV=development PORT=8799 DATA_DIR=data npx tsx server/index.ts`)
and the Chrome already on the machine. It saves screenshots to `docs/review/`
and fails if the console complains, anything is fetched from another site, a
page scrolls sideways, the main button is out of view, anything moves when a
quote arrives, a message does not fit its line, or one of its walks through
the site (quoting, the coin picker, the review sheet, sheets by
touch, pasting an address, focus) does not go as it should.

Add `--practice=http://127.0.0.1:8798` with a second server started with
`PROVIDER_STUB=true` on that port to include the steps that make an order.
Those are pretend orders: that server never makes a real one. Add
`--private=http://127.0.0.1:8797` with a third server started with
`PROVIDER_STUB=true PRIVACY_MODE=basic` to include the walks of private
routing and of Add gas. A name after the address runs one scenario or walk
alone, for example `quoting`.

The practice server keeps every limit the real one has, among them thirty
orders a day from one address. A whole run makes about twenty. Start the
practice server afresh before each whole run (its counts are kept in memory),
or the last orders of a second run will be refused.

Throughout every walk, in every mode, it fails if the browser asks any address
but the site's own for anything: a font, a picture, a chain, Sapling, a wallet
service.

Every screen it photographs is also put through the axe accessibility rules
(all of axe's rules for WCAG 2.0 to 2.2 at levels A and AA, the size-of-target
rule among them, and its "best practice" rules; `scripts/axe.ts` says exactly
which). Any finding fails the run. Two things are left out of the rules.
A control of full size that
is, at the moment of looking, partly scrolled under the site's own header: the
size-of-target rule would call it too small. And the logo's alternative text,
"SaplingDex", beside the name in words: the link that holds both has a name of
its own, which is what is read out, so nothing is said twice. The run also lays the pages out as a
1280 px window zoomed to 200% would (640 px wide), and at 320 px wide, and
checks that nothing is cut off or scrolls sideways there: the home page with
the coin list and the review, Track order, Docs, Terms, Privacy, the
token page, and, with `--practice`, an order's page with its deposit details.

`npm run check:pages` is the short version that also runs on every push. It
starts the built site itself in practice mode, with a made-up token address,
and measures eight pages with Lighthouse as a phone on a slow connection would
load them: the home page, Track order, Docs, Terms, Privacy, Stats, the
token's page, and the page of a pretend order it makes. Performance must be 90
or more and accessibility 100; a page may not move by more than 0.05 while it
loads; and the largest paint must come within 3.5 seconds. (It comes at about
2.9 today. The site's own budget is 2 seconds and is not met; the limit is
there so that the figure cannot get much worse unnoticed.) It then runs the axe
rules on the same eight pages in both themes at phone and desktop width. On
GitHub's shared machines the speed score and the paint time are printed as
warnings and do not fail the run; everything else does.

### Checking that the tests would notice

`npx tsx scripts/mutation-check.ts` switches off one protection at a time (the
signature check, the region block, a rate limit and so on), runs the tests, and
puts the code back. Every line should say "caught". Run it after changing any
protection. With some seven hundred protections it takes a few hours; a
word after the command runs only the protections whose file or label contains it.

## Practice mode

Practice mode (`PROVIDER_STUB=true`, local development only) starts with sample
content: past orders, a token, and made-up swaps behind the Stats page. None of
it can exist on the live site (`server/sample.ts`, `test/boot.test.ts`).
A data folder that a practice server has used says so in a file of its own,
`SAMPLE-CONTENT`, and the live site does not start on that folder (plain
development does, and says so in its log): give the practice server a `DATA_DIR`
of its own.

## Variables

Set these as host variables (on Railway: the service → **Variables**). Never
paste a value into chat or commit it. Every value is checked at startup, and a
bad value stops the server with the variable's name in the log.

| Name | What it is | Where the value comes from |
|---|---|---|
| `NODE_ENV` | `production` on the host | Type `production` |
| `PORT` | Port to listen on | Railway sets it. Leave unset |
| `DATA_DIR` | Folder for orders, caches and logs. **Required** | Type `/data` (the volume's mount path) |
| `TRUST_PROXY_HOPS` | Proxies in front of the server. **Required** | Type `1` on Railway |
| `FEE_BPS` | SaplingDex's fee on a swap routed in public, in basis points. Default `0`: SaplingDex takes no fee, and no fee of ours is sent with a quote. Above 0, the provider keeps half of what is set | Leave unset. 0–300 |
| `FEE_BPS_PRIVATE` | SaplingDex's fee on a privately routed swap, in basis points. Default `0`: no fee of ours. Above 0, the provider leaves it whole and adds its own beside it | Leave unset. 0–300 |
| `FEE_RECIPIENT` | Public address that would receive a fee of ours. Needed, and read, only while `FEE_BPS` or `FEE_BPS_PRIVATE` is above 0: with both at 0 the server starts without it | Leave unset. If a fee is ever set: the fee wallet's public address, copied from the wallet itself, exactly as the wallet shows it, with its mix of capital and small letters (the server refuses any other spelling, so that a slip cannot send fees to nobody). It must be a normal wallet whose key you hold. The project's fee wallet is `0x31af10585a22fbea8a9dd7231b4d409a5b91acd9`, written here in small letters only: check the wallet's own address against it, letter for letter, and paste the wallet's |
| `SWAPS_PAUSED` | `true` stops new quotes and orders. Default `true` in production | `true` for the preview. `false` is launch |
| `ONECLICK_API_KEY` | The provider's partner key. Server only: it is never sent to a browser, never logged, and never committed. Private routing needs it, and with it set private routing is on (see `PRIVACY_MODE`). Without it the site runs, with public swaps only | The provider's partner portal, `partners.near-intents.org`: a key is issued on registering. Paste it into the host's variable, or into a local `.env` for development |
| `PRIVACY_MODE` | How swaps are routed at the provider. `basic` is its private routing: the deposit and the delivery are not tied to each other in public records. `public` is the ordinary kind. Left unset, it is `basic` when `ONECLICK_API_KEY` is set and `public` when it is not (the provider answers private quotes only to a partner with a key), and the log then says at start that private routing is waiting for a key. `basic` written out with no key stops the live server from starting. Any other value stops it too | Leave unset. Type `public` to keep private routing off even with a key |
| `ONECLICK_MAX_PER_MIN` | Most provider calls per minute. Default `300` | Leave unset |
| `REGION_BLOCK` | Whether visitors are refused by their country or region: `off` or `on`. Default `off`: nobody is refused for where they are, on any route, and the region database is never downloaded, loaded or kept on disk. `on` restores the block: the built-in list of countries and regions, checked for every request, with every visitor refused until the region database has loaded | Leave unset. Type `on` to switch the block back on |
| `BLOCKED_COUNTRIES` | Read only while `REGION_BLOCK` is `on`: extra countries to block, two-letter codes, comma-separated. Adds to the built-in list | Leave unset |
| `STATS_PAGE` | The Stats page (`/stats`): `on` or `off`. Default `on`. `off` takes away its link, its address and its data route; the totals are still counted, so they are whole when it is switched on again | Leave unset. Type `off` to hide the page |
| `ADD_GAS` | Add gas, the second small order beside a swap: `on` or `off`. Default `on` (it is only ever offered where swaps are routed privately). `off` takes the switch off the swap card and makes no gas order, whatever a request asks for; swaps are untouched | Leave unset. Type `off` to switch Add gas off without a new build |
| `STATS_RECEIVED_MIN` | How many swaps the site must have delivered before the Stats page lists "Top coins received" (totals by coin, never by swap). Default `1` | Leave unset |
| `BSC_RPC_URL`, `ETH_RPC_URL`, `BASE_RPC_URL`, `ARBITRUM_RPC_URL` | Chain access, server only. Public endpoints are used when unset | An RPC provider's dashboard, when you want better reliability |
| `TOKEN_ADDRESS` | The site's coin: its mint address on Solana, as Sapling shows it. A Solana address; anything else stops the start. Shows the token page and the home page's token section when set | After the coin is planted on Sapling |
| `ZEC_SHIELDED` | Whether a real swap has shown that ZEC sent to a unified Zcash address with no transparent part arrives shielded: `unproven` or `proven`. Default `unproven`: beside a unified address the site says only that the provider delivers to it, and no page says that ZEC arrives shielded. `proven` shows the sentences that say so, on the home page, in the Docs and among the questions | Leave unset. Type `proven` only after the test has shown it |
| `X_URL` | Where the X icon in the header and footer leads. None is built in: unset, there is no X icon | The project's account on X, when it has one |
| `GITHUB_URL` | Where the GitHub icon leads. None is built in: unset, there is no GitHub icon | The project's repository |
| `EXCLUDED_CHAINS` | More chains never to offer on the site, by the provider's chain code, comma-separated. Their coins are left out of the coin list, so they cannot be shown, quoted or ordered. Adds to the built-in list (`abs`); it cannot remove from it | Leave unset |
| `SUPPORT_CONTACT` | One support contact, shown in the footer and on a failed order's page. Required before `SWAPS_PAUSED=false` in production: the server will not start with swaps on and nobody to write to | An email address or a link |
| `SITE_URL` | The site's own address, for example `https://example.org`: the share image's full address and each page's canonical link are written with it. None is built in | The site's domain, once it has one |
| `ALERT_WEBHOOK_URL` | Where operator alerts are posted | A Slack or Discord "incoming webhook" URL |

`PROVIDER_STUB` is for local development only and is refused in production.

While `PRIVACY_MODE` is `basic`, every quote asks the provider for private
routing, and a person can still choose to route one swap in public. The fees a
quote shows are the ones the provider's answer holds. When the provider will not give a private quote, the site
says "Private routing is not available for this swap right now." and offers
"Swap without private routing"; it never routes a swap in public by itself. A
privately routed order is not found from its deposit address on the Track order
page: it opens from its own link or ID only. While the Stats page is on, neither
is any order once it has been delivered: its deposit is listed there, and the
address must not lead to the page that shows both ends.

What the site says follows the same setting, and one build holds both. With
`basic` it is "Private swaps, in and out of ZEC. Powered by NEAR Intents.": the
headline, the page's title and link preview (written into the page by the
server, with the share image `share-private.png`), "Private swaps, in and out of ZEC"
as the first thing the site does, the section "What private means here", the
question "What is private routing?", the Docs page "Private routing" at
`/docs/private`, a section of that name in the Terms and a paragraph in the
Privacy Policy. With `public` none of that is shown: the site reads as it did
before private routing existed, says nothing of private swaps, and
`/docs/private` is "Page not found." The first words of each are in
`shared/positioning.ts`. Everything said of private routing is held to the
provider's own words: the link between a deposit and a delivery is not in
public records, both ends are public, and nobody promises that it is complete.

## Add gas

A switch on the swap card, under the receiving address. With it on, a second,
small order is made beside the swap. It delivers a little of the receiving
chain's own coin to the swap's receiving address, so that a wallet with nothing
in it can pay that chain's network fees and move what arrived. It is an
ordinary order in every way: its own quote, verified like any quote, its own
deposit address, its own deadline and its own refund. No contract is involved,
and the site never holds funds.

- **Where it goes.** The server sets the gas order's receiving address: always
  exactly the swap's. Its refund address is the swap's too. Nothing in a request
  can change either.
- **How it is routed.** Privately, and only ever privately. It is offered only
  beside a privately routed swap: `PRIVACY_MODE` is `basic`, and the person has
  not chosen public routing for that swap. Where it cannot be routed privately
  it is not offered and not made.
- **Its size.** About $3 of the paying coin, at the coin list's price; $5 to
  Ethereum and Gnosis, $10 to Tron. `shared/gas.ts` holds the sizes and the
  reason for each. There is none above $10.
- **The preview.** `POST /api/gas` says whether gas can be added beside a swap,
  and what the gas order would be. It answers `gas: null` wherever gas is not
  offered, whatever the reason, and the card then shows no switch: never one
  that cannot be pressed.
- **The two orders.** `POST /api/orders` with `gas` makes the swap exactly as it
  always does, and then the gas order by the same path: its own limits, its own
  sanctions screening, its own quote and signature check. If anything stops the
  gas order, the swap stands and the answer says that gas was not made.
- **What pairs them.** The gas order's ID is derived from the swap's: the first
  27 characters of the base64url SHA-256 of `gas:` followed by the swap's ID.
  Nothing else pairs the two but the records themselves: there is no index, and
  nothing in the gas order's record points back to the swap. The swap's record
  notes whether its gas order was made; the gas order's record says that it is
  one.
- **Paying.** Two payments, never combined. Two deposit addresses and two
  transfers, each sent by the person from their own wallet.
- **Each stands alone.** If only the swap is paid, it is delivered and the gas
  order runs out unpaid. If only the gas is paid, the gas arrives.
- **Stats.** A delivered gas order adds its dollars to the volume, once. It is
  not counted as a swap and has no row among the recent swaps.
- **Ghost mode.** Both orders are made in Ghost mode, and each record is deleted
  when that order is delivered or refunded.

What the site says of it follows `PRIVACY_MODE`, as its words on private routing
do. With `basic`: the Docs page "Add gas" at `/docs/add-gas`, the question "What
is Add gas?", "Add gas" among what the site does, a sentence that a swap with
gas is two orders and two payments wherever the Docs, the questions, the home
page's steps and the Terms speak of paying an order, and a paragraph in the
Privacy Policy on what is kept of a gas order. With `public` none of that is
shown, and `/docs/add-gas` is "Page not found."

## Deploy (Railway)

One click at a time. This creates a **preview** with swaps paused.

1. Railway → **New Project** → **Deploy from GitHub repo** → choose this repository.
2. Open the new service → **Settings** → **Build** → Custom Build Command: `npm run build` and nothing more. The host installs the packages from the lockfile by itself before the build command runs; a build command that installs them again fails there, because the folder is in use. The npm version this project is pinned to (`packageManager` in `package.json`) is the one the developer's machine and the automatic check use; on the host it is not held: the host installs with its own npm, from the same lockfile, which fixes every package's version either way.
3. Same page → **Deploy** → Custom Start Command: `npm start`
4. Same page → Healthcheck Path: `/api/status`
5. Service → **Volumes** → **New Volume** → Mount path: `/data`. Size: 1 GB or more (logs take at most 700 MB and each order a few kilobytes; with `REGION_BLOCK=on` the region database takes about 130 MB more).
6. Service → **Variables** → add, one by one:
   - `NODE_ENV` = `production`
   - `DATA_DIR` = `/data`
   - `TRUST_PROXY_HOPS` = `1`
   - `SWAPS_PAUSED` = `true`
7. Service → **Settings** → **Networking** → **Generate Domain**. That address is the preview link.
8. Keep it to **one instance**. Orders live on the volume and rate limits live in memory.

The server answers within a few seconds of starting; the health check waits
for nothing else. It fetches the coin list and the sanctions list as it starts
(no order can be made until the sanctions list has loaded). Only with
`REGION_BLOCK=on` does the first start take a minute or two longer: the server
then also downloads the region database (a 60 MB download that unpacks to
about 130 MB), and until that has loaded every visitor is blocked.

If a deploy keeps restarting, a setting is stopping the start. The server says
which in one plain line in the deploy logs, for example `SaplingDex cannot
start. SUPPORT_CONTACT: is required before swaps are switched on`: the
setting's name and what is wrong with it, never its value. (The same is in the
log as an event named `config_invalid`. Every log line is one line of JSON
whose `message` is its event's name, so a host's log viewer shows and finds it.)

Check after the first deploy:

- `https://<domain>/api/status` shows `{"status":"paused",…}`.
- The site loads, with "Swaps are paused" in a banner at the top and in a notice where the swap card would be.
- **The address check.** The rate limits depend on how Railway's edge reports each visitor's address (and so does the region block, where it is on). Run these three, once, from any computer:

  `curl -s -H "X-Forwarded-For: 203.0.113.9" https://<domain>/api/status`

  `curl -s -H "X-Real-IP: 203.0.113.9" https://<domain>/api/status`

  `curl -s -6 https://<domain>/api/status`

  Each should print the normal status. The third needs an IPv6 connection; if the computer has none, use a phone on mobile data and simply open the site. If any of them is refused instead ("Too many requests" at once, or, with the region block on, "Not available in your region"), Railway reports addresses differently than assumed: tell the developer, because `server/ip.ts` then needs a small change (`resolveClientIp` should then read `X-Real-IP` alone). Swaps must stay paused until this check has been done.
- Only with `REGION_BLOCK=on`: from a blocked country (use a testing tool, not a personal VPN account), `https://<domain>/api/tokens` answers "Not available in your region.", and a visitor from there sees that page instead of the site.

## Pause (kill switch)

Set `SWAPS_PAUSED=true` on Railway and redeploy. New quotes and orders stop.
Order tracking keeps working, so people with a swap in progress can still
follow it on their order's page. There is no admin page; host variables are the
only control.

Un-pausing (`SWAPS_PAUSED=false`) is launch. Do it deliberately.

## Backups and restore

Everything that matters is in `DATA_DIR`:

- `orders/` one JSON file per order. This is the only data that cannot be rebuilt. Old records are deleted on a schedule (an expired order that was never paid, 24 hours after its deadline; any other finished order, 30 days after it finished); an unfinished order with funds in it is never deleted automatically. An order made in Ghost mode is deleted sooner: the moment it is delivered or refunded.
- `ghost/gone/` one small file for each order made in Ghost mode whose record was deleted when it finished: named by a one-way fingerprint of the order's ID, holding one word for how it ended, and removed after 30 days. It is what lets the order's own link say that it finished. Nothing else of such an order is kept.
- `sanctions/`, `geo/`, `cache/` are downloaded again automatically.
- `logs/` access logs, deleted after 14 days and capped at 50 MB a day.

To back up: Railway → the volume → **Backups** → enable a daily schedule.
Backups are not on by default; turn them on before launch.

To restore: Railway → the volume → **Backups** → choose a backup → **Restore**,
then redeploy. On start the server reloads every unfinished order and resumes
tracking it. Orders created after the backup are lost from our records, but
the swaps themselves are unaffected: they run at the provider, and each
person's refund address is part of their order there.

## If the site is compromised

1. **Pause.** Set `SWAPS_PAUSED=true`.
2. **Take it down.** Railway → the service → **Settings** → remove the public domain (or delete the deployment). A hijacked page could show a false deposit address, so the page itself must go offline, not just the swaps.
3. **Tell users.** Post on the project's X account and on the support contact: stop sending deposits, and do not trust any address shown on the site until further notice.
4. **Rotate everything.** GitHub and Railway passwords and two-factor; the partner key; any RPC keys; the alert webhook.
5. **Check what changed.** GitHub → the repo → commits and deploy keys. Railway → deploy history and variables.
6. **Fee wallet, if a fee is set.** The server holds no keys, so funds in a fee wallet are safe unless that wallet itself was exposed. If in doubt, create a new one and change `FEE_RECIPIENT`.
7. Redeploy from a known-good commit only after the cause is understood.

## Where fees go

SaplingDex takes no fee. The only fee is the provider's 0.20%. It is the
provider's own (less between two dollar coins), it is paid to the provider, and
nothing of it reaches this site. Every quote the server sends to the browser
carries the figures the provider's answer held: nothing for SaplingDex, and the
provider's fee; showing them is part of the quote panel.

With `FEE_BPS` and `FEE_BPS_PRIVATE` at 0, as they are unless set, no fee of
ours goes with a quote at all, and the server refuses any answer from the
provider that would pay this site, pay a second party, or charge more than 25
basis points for the provider.

A fee can be set, and is then paid to `FEE_RECIPIENT`. On a public swap it is
set by `FEE_BPS` and the provider splits it: of 40, about 20 basis points would
reach us and 20 go to the provider. On a privately routed swap it is set by
`FEE_BPS_PRIVATE` and the provider adds its own beside it: of 20, 20 would reach
us and the provider takes 20 of its own. The site's pages say that SaplingDex
takes no fee, so they must be changed before a fee is set.

The provider's written terms say that app fees do not apply to its confidential
swaps, while its system accepted ours in price previews. Whether the fee of a
private swap is in fact paid is to be checked on the first real one, should a
fee ever be set.

Fees of ours would not arrive in the wallet on its own chain. They collect as
balances inside NEAR Intents, in each swap's input coin, under the fee address.
To collect them, connect the fee wallet to the NEAR Intents app and withdraw
from there. The fee wallet must be a normal wallet whose key you hold: an
exchange address or a multi-signature wallet cannot sign the withdrawal.

## Alerts

Sent to `ALERT_WEBHOOK_URL` and written to the log:

- more than 20% of provider calls failing over 5 minutes
- a quote that failed verification (sent at once; a repeat for the same reason is held back for a minute)
- a coin whose details differ from the reviewed allowlist (the coin is disabled)
- an order swapping for more than three times its estimate
- the sanctions list failing to refresh, or (with `REGION_BLOCK=on`) the region database failing to load or going out of date
- a deposit paid from a wallet on the sanctions list
- a deposit we confirmed on-chain that the provider has not picked up 10 minutes after the deadline (the order stays open)
- an order with funds in it that was still unfinished a week after its deadline (tracking stops; the record is kept for you to raise with the provider)
- a status reply that does not match the stored deposit address
- the data volume more than 70% full (new orders are refused above 95%)

Most alerts are held back for a while after being sent once, so one fault does
not flood the channel. The log has every occurrence: one that was held back
from the channel is written there marked `"held":true`.

## Limits

Each visitor may ask for 30 previews a minute and create 6 orders a minute and
30 a day, with at most 10 orders open at once that have not started swapping. A receiving address may
be used for 10 orders an hour. On IPv6 the daily and unpaid limits also apply
to the wider network (/48) at four times these figures. All limits are in
`server/ratelimit.ts`; how the provider call budget is shared between
previews, new orders and status checks is in `server/oneclick.ts`
(`RESERVED_SHARE`).

## Support

Ask users only for: the order ID, the deposit transaction hash, the origin
chain, and the time. Support never asks for a seed phrase and never messages
first. The site says so in its questions ("How do I get help?"), on every
order's page, in the Docs and in the Terms.

## Security settings to turn on

- Two-factor login on GitHub and Railway.
- Keep the GitHub repository private.

## The reviewed coin list

`server/allowlist.ts` holds a short list of coins on four chains whose contract
address and decimals were confirmed by hand. On every refresh the server
compares the provider's list and the on-chain `decimals()` with it, and raises
an alert on any difference: a sign that the provider's list, or a node, is not
saying what it should. Nothing is paid from a wallet by this site, so the list
decides nothing about how a coin can be paid. To add a coin, confirm the
contract address from the issuer's own site and the chain's explorer, and add
it in lower case.

## Credits

The fonts are Figtree, Instrument Serif (italic) and DM Mono, each under the
SIL Open Font License 1.1 and served by the site itself; the licence and each
font's copyright line are in `web/src/assets/fonts/OFL.txt`. The emblem (two
leaves curving round each other) is the project's own: the photograph it was
supplied as and the vector traced from it are in `web/src/assets/brand/`.

The X and GitHub icons are from Simple Icons (CC0 1.0). Each mark belongs to its owner and is used only
to link to the project's page on that service. Other icons are from Lucide (ISC).

The coin logos kept in `web/src/assets/coins/` and `web/src/assets/chains/` are from the Trust Wallet
assets repository (github.com/trustwallet/assets; MIT licence, copyright 2019-2023 Trust Wallet, its
text kept in `web/src/assets/coin-logos-LICENSE.txt`), each taken by the coin's chain and contract
address. The site serves its own scaled copies of them and loads
nothing from that repository. Each logo is a trade mark that belongs to its owner, and is used
only to name that coin or that chain in a list.
