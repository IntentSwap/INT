# IntentSwap

A cross-chain swap website. Pick a coin you have, pick a coin you want on
almost any chain, see a quote, pay, and track the swap until the coins arrive.

Swaps are executed by NEAR Intents 1Click. IntentSwap is an interface only: it
writes no swap contracts and never holds user funds.

## How it fits together

```
Browser (React) ──HTTPS──▶ Our server (Node) ──HTTPS──▶ Swap provider
   │ wallet                     │ order store (disk)
   └─ signs one transfer        └─ status poller
```

- `server/` the Node server (`node:http`, run with `tsx`)
- `web/` the React site (Vite)
- `shared/` code used by both: money maths, address checks, the API contract
- `test/` automated tests

Rules the code keeps:

- Amounts are `BigInt` on integer strings. Never floating point.
- The server sets the fee and the deposit address. The browser cannot send or change either.
- Every quote from the provider is verified (signature, then a field-by-field comparison with what was asked) before it is stored or shown.
- The wallet is asked for one plain transfer. Never an approval, a permit or a message signature.
- The browser never talks to the provider and never sees a key.

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
| `npm run check:pages` | Measure the built pages in a real browser: Lighthouse (performance 90 or more, accessibility 100, layout shift 0.05 at most) and the axe accessibility rules for WCAG 2.2 AA The speed score is taken on a pretend phone; on a slower machine (the automatic check's, say) the phone's processor is slowed less, by the measuring tool's own table, so that the same phone is measured everywhere, and a page that falls just short is measured twice more and judged by the middle score |
| `npm run rewards:export -- --week … --pool … [--close]` | Show what closing a week of points would do. With `--close`, close it and write the list of payouts (sends nothing) |
| `npm run rewards:record -- --week … --tx 0x…` | Record the transactions that paid a closed week, after checking on BNB Chain what each one paid |
| `npx tsx scripts/make-brand.ts` | Make every size of the logo, the favicons, the home-screen icons and the web manifest again from the two source files in `web/src/assets/brand/` (only when one of them changes) |
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
the site (quoting, the coin picker by keyboard, the review sheet, sheets by
touch, pasting an address, focus) does not go as it should.

Add `--practice=http://127.0.0.1:8798` with a second server started with
`PROVIDER_STUB=true` on that port to include the steps that make an order.
Those are pretend orders: that server never makes a real one. A name after
the address runs one scenario or walk alone, for example `quoting`.

The practice server keeps every limit the real one has, among them thirty
orders a day from one address. A whole run makes about twenty. Start the
practice server afresh before each whole run (its counts are kept in memory),
or the last orders of a second run will be refused.

With `--practice` it also walks paying from a connected wallet (walk name
`wallet`, in `scripts/wallet-walk.ts`). A pretend wallet stands in for a real
one and writes down everything it is asked. The walk fails if any wallet code
or other site is touched before "Connect" is pressed, if the page ever
contacts a site the security policy does not name, or if the wallet is asked
for anything but its address, its network, and one transfer per order that
matches the order exactly.

It also walks signing in on the Rewards page (walk name `rewards`, in
`scripts/rewards-walk.ts`), with a pretend wallet whose key is made up from
fixed text. The walk fails if the wallet is asked to sign before "Sign in" is
pressed, if it is asked for anything but its address, its network and that one
plain message, if the message is not the server's own (naming the site and the
address, and saying it is not a transaction), if a refusal signs anyone in, if
the page or the server's answer names any address but the signed-in one and
the reserve's, or if the sign-in outlives the page.

Every screen it photographs is also put through the axe accessibility rules
(all of axe's rules for WCAG 2.0 to 2.2 at levels A and AA, the size-of-target
rule among them, and its "best practice" rules; `scripts/axe.ts` says exactly
which). Any finding fails the run. Three things are left out of the rules.
The wallet library's own window, the list of wallets that opens on "Connect",
which is drawn by code this site does not write. A control of full size that
is, at the moment of looking, partly scrolled under the site's own header: the
size-of-target rule would call it too small. And the logo's alternative text,
"IntentSwap", beside the name in words: the link that holds both has a name of
its own, which is what is read out, so nothing is said twice. The run also lays the pages out as a
1280 px window zoomed to 200% would (640 px wide), and at 320 px wide, and
checks that nothing is cut off or scrolls sideways there: the home page with
the coin list and the review, Track order, Docs, Rewards, Terms, Privacy, the
token page, and, with `--practice`, an order's page with its deposit details.

`npm run check:pages` is the short version that also runs on every push. It
starts the built site itself in practice mode, with a made-up token address,
and measures eight pages with Lighthouse as a phone on a slow connection would
load them: the home page, Track order, Docs, Rewards, Terms, Privacy, the
token's page, and the page of a pretend order it makes. Performance must be 90
or more and accessibility 100; a page may not move by more than 0.05 while it
loads; and the largest paint must come within 3.5 seconds. (It comes at about
2.9 today. The site's own budget is 2 seconds and is not met; the limit is
there so that the figure cannot get much worse unnoticed.) It then runs the axe
rules on the same eight pages in both themes at phone and desktop width.

### Checking that the tests would notice

`npx tsx scripts/mutation-check.ts` switches off one protection at a time (the
signature check, the region block, a rate limit and so on), runs the tests, and
puts the code back. Every line should say "caught". Run it after changing any
protection. With some two hundred protections it takes about half an hour; a
word after the command runs only the protections whose file or label contains it.

## Points and weekly payouts

Each delivered swap that names a rewards address adds an entry to the points record
(`DATA_DIR/rewards/entries`, one small file per swap; the rules are in
`shared/rewards.ts`). Nothing needs doing for points to be counted. Payouts are
sent by hand, from the reserve wallet, once a week:

1. After the week has ended (Sunday 23:59 UTC), look at what closing it would do with
   the pool you have in mind:

   ```
   npm run rewards:export -- --week 2026-W41 --pool 12.5
   ```

   This writes nothing. It prints the addresses, the total points, the week's counted
   fee in dollars, each share and payout, what is carried, what is withheld, what stays
   in the reserve, and what the reserve wallet holds. Run it with another pool as often
   as you like. Whole-number maths, every share rounded down; the remainder stays in
   the reserve. A share under the smallest payout is not sent and its points are
   carried into the next week.
2. Close the week: the same command with `--close` at the end.

   ```
   npm run rewards:export -- --week 2026-W41 --pool 12.5 --close
   ```

   This fixes the pool, and writes `rewards/exports/2026-W41.csv` (address, points,
   share, payout, carried, withheld) and a summary beside it, in the data folder. Run
   again for the same week and pool, it writes the same files. A closed week cannot be
   closed again with another pool. Closing checks three things first, and closes
   nothing if one of them fails:

   - **The reserve holds the pool.** The reserve wallet's balance of the payout coin is
     read from BNB Chain. A pool larger than it is refused, and so is any pool while
     the balance cannot be read or `RESERVE_ADDRESS` is not set.
   - **The payout list is screened.** Every address that is due a payout is screened
     against the sanctions list the server screens orders with (the copy in the data
     folder, fetched again when it is more than a day old). With no usable list,
     nothing is closed. A listed address is sent nothing and carries nothing: its share
     stays in the reserve, is not handed to the others, and is marked `withheld` in the
     week's record and in the CSV. The summary counts such addresses.
   - **Weeks are closed in order.** A week is not closed while an earlier week that
     holds points is still open, because points are carried from one week into the
     next and no further. A week nothing is paid for is closed with `--pool 0`: every
     address's points are carried.
3. Send the payouts on the list from the reserve wallet: one transfer for each address,
   for exactly its amount. No tool here sends anything.
4. Record the transactions, so that the Rewards page shows them:

   ```
   npm run rewards:record -- --week 2026-W41 --tx 0x… --tx 0x…
   ```

   Each is checked on BNB Chain: sent by `RESERVE_ADDRESS`, successful, and holding a
   transfer of the payout coin from the reserve wallet to an address on the week's
   list, for exactly that address's payout, where none is on record for it yet. The
   hash is kept with the payout it made. A transaction that holds no such transfer (an
   approval, another coin, another amount) is refused, and so is one already on record
   for any week. If one fails the check, nothing is recorded. The Rewards page counts
   as paid only the payouts that have their transaction on record, and shows each
   address the transaction of its own payout.

Both tools read the same variables as the server (`DATA_DIR`, `RESERVE_ADDRESS`,
the BNB Chain node) and are run where the data is: on Railway, in the service's
shell. There is no web route for either. Back the `rewards` folder up with `orders`.

Practice mode (`PROVIDER_STUB=true`, local development only) starts with sample
content: past orders, a token, a reserve, and points for whichever address signs
in. None of it can exist on the live site (`server/sample.ts`, `test/boot.test.ts`).
A data folder that a practice server has used says so in a file of its own,
`rewards/SAMPLE-CONTENT`, and the live site does not start on that folder (plain
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
| `FEE_RECIPIENT` | Public address that receives our fee. **Required** | The fee wallet's public address, copied from the wallet itself, exactly as the wallet shows it, with its mix of capital and small letters (the server refuses any other spelling, so that a slip cannot send fees to nobody). It must be a normal wallet whose key you hold. The live site's fee wallet is `0x31af10585a22fbea8a9dd7231b4d409a5b91acd9`, written here in small letters only: check the wallet's own address against it, letter for letter, and paste the wallet's |
| `FEE_BPS` | Our fee on a public swap, in basis points. The provider keeps half of it. Default `40` | Leave unset, or 20–300 |
| `FEE_BPS_PRIVATE` | Our fee on a privately routed swap, in basis points. The provider leaves it whole and adds its own beside it, so the default of `20` makes a private swap cost what a public one does. `0` asks for no fee of ours on private swaps (they then add no points). Default `20` | Leave unset, or 0–300 |
| `SWAPS_PAUSED` | `true` stops new quotes and orders. Default `true` in production | `true` for the preview. `false` is launch |
| `ONECLICK_API_KEY` | The provider's partner key. Server only: it is never sent to a browser, never logged, and never committed. Private routing needs it, and with it set private routing is on (see `PRIVACY_MODE`). Without it the site runs, with public swaps only | The provider's partner portal, `partners.near-intents.org`: a key is issued on registering. Paste it into the host's variable, or into a local `.env` for development |
| `PRIVACY_MODE` | How swaps are routed at the provider. `basic` is its private routing: the deposit and the delivery are not tied to each other in public records. `public` is the ordinary kind. Left unset, it is `basic` when `ONECLICK_API_KEY` is set and `public` when it is not (the provider answers private quotes only to a partner with a key), and the log then says at start that private routing is waiting for a key. `basic` written out with no key stops the live server from starting. Any other value stops it too | Leave unset. Type `public` to keep private routing off even with a key |
| `ONECLICK_MAX_PER_MIN` | Most provider calls per minute. Default `300` | Leave unset |
| `BLOCKED_COUNTRIES` | Extra countries to block, two-letter codes, comma-separated. Adds to the built-in list | Your lawyer's advice, for example `US,GB` |
| `BSC_RPC_URL`, `ETH_RPC_URL`, `BASE_RPC_URL`, `ARBITRUM_RPC_URL` | Chain access, server only. Public endpoints are used when unset | An RPC provider's dashboard, when you want better reliability |
| `SOLANA_RPC_URL` | Checked at start-up but not used yet (paying from a Solana wallet is not built) | Leave unset |
| `REOWN_PROJECT_ID` | Wallet-connect project ID. Public by design | Already built in. Leave unset |
| `TOKEN_ADDRESS` | The `$INT` contract on BNB Chain. Shows the `$INT` section when set | After the token launches |
| `TOKEN_PAIR_ADDRESS` | The token's trading pair (liquidity pool) on BNB Chain, shown beside it | After the token launches |
| `RESERVE_ADDRESS` | The wallet weekly payouts are sent from, on BNB Chain. Shows the reserve on the Rewards page when set | When payouts begin |
| `X_URL` | Where the X icon in the header and footer leads. Default `https://x.com/intentswap_`, the project's own account | Leave unset |
| `GITHUB_URL` | Where the GitHub icon leads. Default `https://github.com/IntentSwap/INT`, the project's repository | Leave unset |
| `DEXSCREENER_URL` | Where the DexScreener icon leads. Default `https://dexscreener.com/`, its front page, until the token has a page there | The token's own page, for example `https://dexscreener.com/bsc/0x...`, after the token launches |
| `EXCLUDED_CHAINS` | More chains never to offer on the site, by the provider's chain code, comma-separated. Their coins are left out of the coin list, so they cannot be shown, quoted or ordered. Adds to the built-in list (`abs`); it cannot remove from it | Leave unset |
| `SUPPORT_CONTACT` | One support contact, shown in the footer and on a failed order's page. Required before `SWAPS_PAUSED=false` in production: the server will not start with swaps on and nobody to write to | An email address or a link |
| `SITE_URL` | The site's own address: the share image's full address and each page's canonical link are written with it. Default in production `https://intentswap.app`. Set it only for another address (a preview's own, say); a `SITE_URL` that is itself set is also the one name the Rewards sign-in will carry | Leave unset |
| `ALERT_WEBHOOK_URL` | Where operator alerts are posted | A Slack or Discord "incoming webhook" URL |

`PROVIDER_STUB` is for local development only and is refused in production.

While `PRIVACY_MODE` is `basic`, every quote asks the provider for private
routing, with our fee from `FEE_BPS_PRIVATE`, and a person can still choose to
route one swap in public. The fees a quote shows are the ones the provider's
answer holds, and points are counted from our fee as it was shown, on a private
swap as on any other. When the provider will not give a private quote, the site
says "Private routing is not available for this swap right now." and offers
"Swap without private routing"; it never routes a swap in public by itself. A
privately routed order is not found from its deposit address on the Track order
page: it opens from its own link or ID only.

What the site says follows the same setting, and one build holds both. With
`basic` it is "Private swaps, across chains. Built on NEAR Intents.": the
headline, the page's title and link preview (written into the page by the
server, with the share image `share-private.png`), "Private cross-chain swaps"
as the first thing the site does, the section "What private means here", the
question "What is private routing?", the Docs page "Private routing" at
`/docs/private`, a section of that name in the Terms and a paragraph in the
Privacy Policy. With `public` none of that is shown: the site reads as it did
before private routing existed, says nothing of private swaps, and
`/docs/private` is "Page not found." The first words of each are in
`shared/positioning.ts`. Everything said of private routing is held to the
provider's own words: the link between a deposit and a delivery is not in
public records, both ends are public, and nobody promises that it is complete.

## Deploy (Railway)

One click at a time. This creates a **preview** with swaps paused.

1. Railway → **New Project** → **Deploy from GitHub repo** → choose `intentswap`.
2. Open the new service → **Settings** → **Build** → Custom Build Command: `npm install --global npm@11.6.2 && npm ci --ignore-scripts && npm run build` (the first part makes the host use the npm this project is pinned to, the same one as the developer's machine and the automatic check)
3. Same page → **Deploy** → Custom Start Command: `npm start`
4. Same page → Healthcheck Path: `/api/status`
5. Service → **Volumes** → **New Volume** → Mount path: `/data`. Size: 1 GB or more (the region database takes about 130 MB, logs at most 700 MB, and each order a few kilobytes).
6. Service → **Variables** → add, one by one:
   - `NODE_ENV` = `production`
   - `DATA_DIR` = `/data`
   - `TRUST_PROXY_HOPS` = `1`
   - `SWAPS_PAUSED` = `true`
   - `FEE_RECIPIENT` = the fee wallet's public address, pasted from the wallet itself (the table above has it in small letters, to check against)
7. Service → **Settings** → **Networking** → **Generate Domain**. That address is the preview link.
8. Keep it to **one instance**. Orders live on the volume and rate limits live in memory.

First start takes a minute or two: the server downloads the region database
(a 60 MB download that unpacks to about 130 MB) and the sanctions list. Until
the region database has loaded, every visitor is blocked.

Check after the first deploy:

- `https://<domain>/api/status` shows `{"status":"paused",…}`.
- The site loads, with "Swaps are paused" in a banner at the top and in a notice where the swap card would be. (A visitor from a blocked country sees "Not available in your region." instead of the site.)
- From a blocked country (use a testing tool, not a personal VPN account), `https://<domain>/api/tokens` answers "Not available in your region."
- **The address check.** The region block and the rate limits depend on how Railway's edge reports each visitor's address. Run these three, once, from any computer:

  `curl -s -H "X-Forwarded-For: 203.0.113.9" https://<domain>/api/status`

  `curl -s -H "X-Real-IP: 203.0.113.9" https://<domain>/api/status`

  `curl -s -6 https://<domain>/api/status`

  Each should print the normal status. The third needs an IPv6 connection; if the computer has none, use a phone on mobile data and simply open the site. If any of them prints "Not available in your region" instead, Railway reports addresses differently than assumed: tell the developer, because `server/ip.ts` then needs a small change (`resolveClientIp` should then read `X-Real-IP` alone). Swaps must stay paused until this check has been done.

## Pause (kill switch)

Set `SWAPS_PAUSED=true` on Railway and redeploy. New quotes and orders stop.
Order tracking keeps working, so people with a swap in progress can still
follow it on their order's page. There is no admin page; host variables are the
only control.

Un-pausing (`SWAPS_PAUSED=false`) is launch. Do it deliberately.

## Backups and restore

Everything that matters is in `DATA_DIR`:

- `orders/` one JSON file per order. This is the only data that cannot be rebuilt. Old records are deleted on a schedule (an expired order that was never paid, 24 hours after its deadline; any other finished order, 30 days after it finished); an unfinished order with funds in it is never deleted automatically.
- `rewards/` the points record: one small file per delivered swap that added points (`entries/`), one per closed week (`weeks/`), and the lists the payout tool wrote (`exports/`). It cannot be rebuilt once the orders behind it have been deleted, so it is backed up with them. It is never deleted automatically.
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
4. **Rotate everything.** GitHub, Railway and Reown passwords and two-factor; the partner key; any RPC keys; the alert webhook.
5. **Check what changed.** GitHub → the repo → commits and deploy keys. Railway → deploy history and variables. Reown → allowed domains.
6. **Fee wallet.** The server holds no keys, so funds in the fee wallet are safe unless that wallet itself was exposed. If in doubt, create a new one and change `FEE_RECIPIENT`.
7. Redeploy from a known-good commit only after the cause is understood.

## Where fees go

Each quote carries our fee, paid to `FEE_RECIPIENT`. On a public swap it is
set by `FEE_BPS` and the provider splits it: with the default of 40, about 20
basis points reach us and 20 go to the provider. On a privately routed swap it
is set by `FEE_BPS_PRIVATE` and the provider adds its own beside it: with the
default of 20, 20 reach us and the provider takes 20 of its own, so either kind
of swap costs 40 in all. Every quote the server sends to the browser carries
both figures, taken from the quote itself; showing them is part of the quote
panel.

The provider's written terms say that app fees do not apply to its confidential
swaps, while its system accepted ours in price previews. Whether the fee of a
private swap is in fact paid is to be checked on the first real one.

Fees do not arrive in the wallet on its own chain. They collect as balances
inside NEAR Intents, in each swap's input coin, under the fee address. To
collect them, connect the fee wallet to the NEAR Intents app and withdraw from
there. The fee wallet must be a normal wallet whose key you hold: an exchange
address or a multi-signature wallet cannot sign the withdrawal.

## Alerts

Sent to `ALERT_WEBHOOK_URL` and written to the log:

- more than 20% of provider calls failing over 5 minutes
- a quote that failed verification (sent at once; a repeat for the same reason is held back for a minute)
- a coin whose details differ from the reviewed allowlist (the coin is disabled)
- an order swapping for more than three times its estimate
- the sanctions list failing to refresh, or the region database failing to load or going out of date
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

- Two-factor login on GitHub, Railway and Reown.
- Reown dashboard: allow only the site's own domain (and `localhost` for development).
- Keep the GitHub repository private.

## Adding a coin for wallet payment

Wallet transfers are only ever built from `server/allowlist.ts`. To add a coin,
confirm the contract address from the issuer's own site and the chain's
explorer, confirm it is a plain token (no fee on transfer, no rebasing), and
add it in lower case. The server compares the provider's list and the
on-chain `decimals()` with the allowlist on every refresh; any difference
disables the coin and raises an alert.

## Credits

The X and GitHub icons are from Simple Icons (CC0 1.0). The DexScreener icon is the line drawing
from Arcticons (CC BY-SA 4.0), with heavier lines. Each mark belongs to its owner and is used only
to link to the project's page on that service. Other icons are from Lucide (ISC).
