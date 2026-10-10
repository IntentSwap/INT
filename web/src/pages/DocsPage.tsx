// How the site works, in plain words, as a small documentation: one page to a subject, all in
// one layout (see DocsLayout). The figures of the example on the Fees page are read from a quote
// taken as the page opens, the chains from the live coin list, the deadlines and the rules for
// points from the same constants the server uses.
//
// Where the server routes swaps privately there is one page more, "Private routing", and the
// other pages say what it changes for them, each in a sentence or two. Where it does not, none of
// that is shown and nothing on any page speaks of private routing.
//
// One page is about Ghost mode. It is a page everywhere, and says in as many sections what the
// mode does, what it does not, and what is still kept.

import { useEffect, useMemo, useState } from "react";
import { displayAmount, displayBps, parseAmount } from "../../../shared/amounts.ts";
import { SLIPPAGE, type QuoteView, type TokenView } from "../../../shared/api.ts";
import { chainName, DEPOSIT_CLOSE_MS, isWalletChain, sendWindowMs } from "../../../shared/chains.ts";
import { GHOST_DOC_SLUG, PRIVATE_DOC_SLUG, type DocSlug } from "../../../shared/pages.ts";
import { REWARDS } from "../../../shared/rewards.ts";
import { api } from "../api.ts";
import { Callout, DocSection, DocsLayout, TableFrame } from "../components/DocsLayout.tsx";
import { questions, type Question } from "../components/Faq.tsx";
import { Link } from "../components/Link.tsx";
import { DEFAULT_PAIR, EXAMPLE_AMOUNT } from "../config.ts";
import { docHref } from "../lib/docs-logic.ts";
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

function HowItWorks() {
  const privateOn = usePrivateRouting();
  const statsOn = useApp((state) => statsPageOn(state.config));
  return (
    <DocsLayout href={docHref(null)} title="How it works" lead="IntentSwap swaps one coin for another, also when the two are on different chains. Swaps run on NEAR Intents. IntentSwap is the interface: it never holds your funds.">
      <DocSection title="Quote">
        <p>Choose the coin you pay and the coin you receive, and type an amount. The quote shows the rate, each fee, the least you will receive and how long it should take. It is refreshed while you look at it.</p>
      </DocSection>
      <DocSection title="Review">
        <p>One sheet shows the numbers and both addresses in full: where your coins are delivered, and where they come back to if the swap fails. Confirming makes an order. Making an order moves no coins.</p>
      </DocSection>
      <DocSection title="Pay">
        <p>Pay the order from a connected wallet, which is asked for one transfer and nothing else, or send the exact amount yourself to the deposit address shown.</p>
        <Callout tone="tip" title="Either way, you send the coins yourself.">
          <p>IntentSwap cannot move them, and never holds them.</p>
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
    <DocsLayout href={docHref("fees")} title="Fees" lead="IntentSwap takes no fee. The only fee is the provider's 0.20%.">
      <DocSection title="What a swap costs">
        <ul>
          <li>
            <strong>The provider's fee.</strong> NEAR Intents, which carries out the swap, takes 0.20% of the amount you pay, and less on a swap between two dollar coins. {example !== null ? <>In the quote below it is {displayBps(example.fees.providerBps)}. </> : null}Every quote shows it on a line of its own, before you confirm.
          </li>
          <li>
            <strong>The network fee of the chain you receive on.</strong> The provider takes it out of what you receive. It is already inside the amount the quote shows.
          </li>
          <li>
            <strong>The network fee of the chain you pay on.</strong> Your wallet pays it when you send. IntentSwap does not set it and does not receive it.
          </li>
        </ul>
        <p>IntentSwap adds nothing to these. A quote's "IntentSwap fee" line reads "None".</p>
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
                  <th scope="row">IntentSwap fee</th>
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
                  <th scope="col">Pay from a wallet</th>
                  <th scope="col">Time to send it yourself</th>
                </tr>
              </thead>
              <tbody className="docs-chains">
                {chains.map((chain) => (
                  <tr key={chain.key}>
                    <th scope="row">{chain.name}</th>
                    <td className="mono">{chain.coins}</td>
                    <td>{isWalletChain(chain.key) ? "Yes" : "No"}</td>
                    <td>{minutesText(sendWindowMs("manual", chain.key))}</td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          </>
        ) : (
          <p>The live list of coins could not be loaded just now. The coin picker on the swap page shows every coin and chain that can be swapped.</p>
        )}
      </DocSection>
      <DocSection title="Two ways to pay" id="paying">
        <p>Wallet payment works on BNB Chain, Ethereum, Base and Arbitrum. On every chain you can pay by sending to a deposit address, from any wallet.</p>
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
            <strong>Paying from a connected wallet:</strong> {minutesText(sendWindowMs("wallet", DEFAULT_PAIR.from.chain))}.
          </li>
          <li>
            <strong>Sending it yourself:</strong> {minutesText(sendWindowMs("manual", DEFAULT_PAIR.from.chain))}.
          </li>
          {slow.length > 0 ? (
            <li>
              <strong>Paying from a slower chain</strong> ({slow.join(", ")}): {minutesText(sendWindowMs("manual", slowChains[0]?.key ?? ""))}, because their transactions take longer to confirm.
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
        <p>To pay an order your wallet is asked for one transfer: the order's amount, to the order's deposit address. Paying never asks it to approve spending or to sign a message.</p>
        <p>
          One page asks for a signature, and it is not this one: on <Link href="/rewards">Rewards</Link>, signing in to see your own points means signing one plain message. It is not a transaction, moves nothing, approves nothing and costs no network fee.
        </p>
        <Callout tone="warning" title="Anything else is not IntentSwap.">
          <p>If a page in IntentSwap's name asks your wallet to approve spending, or to sign anything while you are paying, close it.</p>
        </Callout>
      </DocSection>
      <DocSection title="Your order's link" id="link">
        <p>
          Keep the order's link. It is the way back to the order, and anyone who has it can see the order.
          {privateOn ? <> On a privately routed swap the order's page shows both ends of it: share the link only with someone you would show both to.</> : null}
        </p>
      </DocSection>
      <DocSection title="What IntentSwap never does" id="never">
        <ul>
          <li>IntentSwap never asks for a seed phrase or a key to your wallet, and never messages you first. Anyone who does, in its name, is not IntentSwap.</li>
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

function Rewards() {
  const privateOn = usePrivateRouting();
  return (
    <DocsLayout href={docHref("rewards")} title="Points and weekly rewards" lead="Each delivered swap adds points to a rewards address. Each week a payout is shared out among that week's addresses by their points.">
      <DocSection title="How points are counted" id="points">
        <ul>
          <li>
            <strong>{REWARDS.pointsPerUsd} points for each $1 swapped:</strong> one point for every 10 cents of the swap's value in US dollars. The value is the provider's, for what you paid, as the quote showed it.
          </li>
          <li>
            <strong>Only delivered swaps count.</strong> A refunded, failed or expired order, or one whose deposit was too small, adds none.
          </li>
          <li>
            <strong>Every delivered swap counts the same way,</strong> whatever the coins and the chains. No fee is part of the sum.
          </li>
          {privateOn ? (
            <li>
              <strong>A privately routed swap adds points the same way.</strong> They are counted from its value in US dollars, as for any swap.
            </li>
          ) : null}
        </ul>
        <p>Points have no money value. They cannot be bought, sold or moved to another address.</p>
      </DocSection>
      <DocSection title="The week" id="week">
        <p>A week runs from Monday 00:00 to Sunday 23:59, UTC time. A swap belongs to the week in which it was delivered.</p>
      </DocSection>
      <DocSection title="Whose points" id="address">
        <p>Points belong to a rewards address: an address on BNB Chain.</p>
        <ul>
          <li>
            <strong>Paying from a connected wallet:</strong> the wallet's own address.
          </li>
          <li>
            <strong>Sending it yourself:</strong> the review sheet has a field for a rewards address. It can be left empty; the swap then adds no points.
          </li>
        </ul>
        <p>A rewards address is screened like every other address of an order.</p>
      </DocSection>
      <DocSection title="Seeing your points" id="signing-in">
        <p>
          Nobody can look up another address's points: there is no ranking and no list. On <Link href="/rewards">Rewards</Link> you see your own, after showing that the address is yours. Of everyone else's there is one figure only: how many points the week has in all, brought up to date every 15 minutes.
        </p>
        <p>That takes one signature of a plain message: this site's name, your address, a code used once, and the time it runs out. It is not a transaction. It moves nothing, approves nothing and costs no network fee. The sign-in lasts {REWARDS.sessionMinutes} minutes.</p>
        <Callout tone="tip" title="Only the Rewards page asks for a signature.">
          <p>Paying for a swap never does.</p>
        </Callout>
      </DocSection>
      <DocSection title="The pool" id="pool">
        <p>
          The pool is what one wallet on BNB Chain holds in NEAR, the coin rewards are paid in. <Link href="/rewards">Rewards</Link> shows that amount now, with its value in US dollars beneath and a link to the wallet on BscScan so that anyone can check it. Other coins the wallet holds are not part of the pool. Each week it is shared out by points.
        </p>
        <p>Signed in, you also see your share, which is your points out of the week's points, and what that share of the pool comes to in NEAR. Both are estimates: your share changes as others swap, and the pool changes until the week closes. Your own new swap counts in your share at once; other people's swaps count within 15 minutes.</p>
      </DocSection>
      <DocSection title="Payouts" id="payouts">
        <p>Rewards are paid in NEAR on BNB Chain, to your rewards address: the address you sign in with on the Rewards page.</p>
        <p>After a week has closed, its payout is shared out by points: an address's share is its points divided by all the points of that week. It is sent by hand from the pool's wallet to each rewards address. The Rewards page lists each payout with its transaction.</p>
        <p>The addresses on a week's list are screened again as the list is made. One that is on a sanctions list is sent nothing.</p>
        <p>A share too small to send is not lost: its points are carried into the next week. So are every address's points in a week for which nothing is paid.</p>
        <Callout tone="warning" title="A payout is not owed.">
          <p>Whether there is a payout in a given week, and how large it is, is at IntentSwap's discretion and can change or stop. Do not make a swap for the sake of a payout.</p>
        </Callout>
      </DocSection>
    </DocsLayout>
  );
}

function Questions() {
  const contact = useApp((state) => state.config?.supportContact ?? null);
  const privateOn = usePrivateRouting();
  return (
    <DocsLayout href={docHref("faq")} title="Questions" lead="Asked before a first swap, and answered in plain words.">
      {questions(privateOn).map((item: Question) => (
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
        <p>NEAR Intents, the provider, runs it and calls it confidential routing. It processes the swap on a network of its own with restricted visibility: what happens there is not published for everyone to read, as it is on a public blockchain. IntentSwap asks for this routing. It does not run it.</p>
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
            <strong>IntentSwap, for what is needed to run your order.</strong> The coins, the amounts, your addresses and the order's status. The <Link href="/privacy">Privacy Policy</Link> lists what is kept, and for how long.
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
            <strong>It is not a way round screening.</strong> Addresses are screened against the sanctions list, by IntentSwap and by the provider, on a privately routed swap as on any other.
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
        <p>IntentSwap takes no fee. The only fee is the provider's 0.20%. A privately routed swap costs what any swap does, and its quote shows it before you confirm: what you pay, and what you receive after the provider's fee and the network fee.</p>
        <p>
          Such a swap adds <Link href={docHref("rewards")}>points</Link> as any other does: they are counted from its value in US dollars. A weekly payout is a public transfer to the rewards address, so it shows that the address has used IntentSwap. It says nothing of either end of any swap.
        </p>
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
 * Ghost mode, in plain words: the one switch, the five things it does while it is on, what it does
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
    <DocsLayout href={docHref(GHOST_DOC_SLUG)} title="Ghost mode" lead="One switch in the header. While it is on, this site loads no wallet software, asks nothing of any other site and keeps nothing in your browser but the switch itself, and the record of an order you make is deleted from its server when the order finishes. This page says what that covers, and what it does not.">
      <DocSection title="What it is" id="what">
        <p>Ghost mode is one switch, in the header. With it on, a swap works as it always does: a quote, a review, an order, a deposit, a delivery. What changes is what the site loads, what it asks of other sites, and what it and your browser keep.</p>
        <p>It changes how the site is used, not the swap. The swap itself is the same, and as public as any other.</p>
      </DocSection>
      <DocSection title="What it does" id="does">
        <p>Five things, for as long as the switch is on.</p>
        <ul>
          <li>
            <strong>The switch is the one thing remembered.</strong> It is kept as a single on/off flag for this tab, so that loading the page again does not turn Ghost mode off. It ends when the tab is closed.
          </li>
          <li>
            <strong>No wallet is loaded.</strong> The wallet software is not fetched at all, so there is no Connect and no balance is read. A wallet that was connected is disconnected, and what its software left in your browser is removed. You pay by sending to the order's deposit address, from any wallet. The <Link href="/rewards">Rewards</Link> sign-in needs a wallet, so it is off too.
          </li>
          <li>
            <strong>Nothing is asked of any other site.</strong> The page asks nothing of any address but this site's own, and tells your browser to refuse anything else. A link that leaves the site still works as a plain link: it opens in a new tab, carries a small mark that says it leaves this site, and does not tell the other site where you came from.
          </li>
          <li>
            <strong>Nothing is kept in your browser.</strong> No list of your orders, no copy of the coin list, no note of any kind: only the switch itself. Orders you made earlier, in normal mode, are not shown while Ghost mode is on. They are there again when you turn it off, unless you chose "Also clear what this browser already holds" when you turned it on.
          </li>
          <li>
            <strong>An order's record is deleted when it finishes.</strong> An order made in Ghost mode is marked as one. The moment it is delivered or refunded, or its deadline passes unpaid, its record is deleted from the server. Until then its own link is the only way back to it: it is on no list, and it is never found from its deposit address. After that the link says only that the order finished.
          </li>
        </ul>
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
            <strong>A one-way fingerprint of the order's ID, for 30 days.</strong> It is there so that the order's link can say that the order finished, where it would otherwise say that there is no such order. The ID itself is not kept.
          </li>
          <li>
            <strong>Its place in the totals.</strong> {statsOn ? <>The <Link href="/stats">Stats page</Link> counts it in its totals: the swaps, the volume, the chains and the coins. It has no row among the recent swaps, and its deposit transaction is never listed.</> : <>The server's running totals count it: the swaps, the volume, the chains and the coins. No row is kept for it.</>}
          </li>
          <li>
            <strong>Its points, if you named a rewards address.</strong> They are counted before the record is deleted, and kept as any points are: a one-way fingerprint of the order's ID, the rewards address, the swap's value in US dollars, its two coins and their chains, and the time. Leave the rewards address empty and the swap adds no points, and none of this is kept.
          </li>
          <li>
            <strong>Lines in the logs.</strong> The server's logs name an order by a one-way fingerprint only, and are kept as for any order. For an order made in Ghost mode they carry no address and no transaction hash.
          </li>
        </ul>
        <p>One kind of order is kept longer. An order that fails with coins still in it is kept until that has been dealt with, as any order is, and deleted then.</p>
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
        <p>While it is on, the header shows "Ghost mode" where Connect would be. Press that to turn it off. The page then loads itself again, in normal mode.</p>
        <p>Closing the tab turns it off as well.</p>
      </DocSection>
    </DocsLayout>
  );
}

const PAGES: Record<DocSlug, () => React.JSX.Element> = { fees: Fees, chains: Chains, refunds: Refunds, safety: Safety, private: PrivateRouting, "ghost-mode": GhostMode, rewards: Rewards, faq: Questions };

export default function DocsPage({ slug }: { slug: DocSlug | null }) {
  const Page = slug === null ? HowItWorks : PAGES[slug];
  return <Page />;
}
