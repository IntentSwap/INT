// The Terms of Use and the Privacy Policy, in the documentation's layout. Plain words throughout.
// Whether a lawyer has read them is the operator's business before launch; the pages themselves
// read as the site's terms.
//
// Where the server routes swaps privately, the Terms have one section more ("Private routing") and
// the Privacy Policy says what private routing changes about what is public. Where it does not,
// both read as they always have.

import type { ReactNode } from "react";
import { TERMS_VERSION } from "../../../shared/api.ts";
import { REWARDS } from "../../../shared/rewards.ts";
import { DocSection, DocsLayout } from "../components/DocsLayout.tsx";
import { Link } from "../components/Link.tsx";
import { isPrivateMode } from "../lib/site-logic.ts";
import { useApp } from "../stores/app.ts";

/** Which version of the page this is. An order keeps the version of the Terms it was made under. */
function Version() {
  return <p className="docs-version muted">Version {TERMS_VERSION}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <DocSection title={title}>{children}</DocSection>;
}

/** Where to write, said only where a contact is published. */
function Contact() {
  const contact = useApp((state) => state.config?.supportContact ?? null);
  return contact !== null ? <>Write to {contact.replace(/^https:\/\//, "")}. </> : null;
}

/** The site's own address as it is written in a sentence (its host), where the server knows it. */
function useSiteHost(): string | null {
  const address = useApp((state) => state.config?.siteUrl ?? null);
  return address !== null && URL.canParse(address) ? new URL(address).host : null;
}

export function TermsPage() {
  const site = useSiteHost();
  const privateOn = useApp((state) => isPrivateMode(state.config));
  return (
    <DocsLayout href="/terms" title="Terms of Use" lead="What IntentSwap is, what it is not, and what you agree to by using it.">
      <Version />

      <Section title="1. What IntentSwap is">
        <p>IntentSwap{site !== null ? <> ({site})</> : null} is a website that helps you swap one coin for another across blockchains. It is an interface only. It never holds your coins, and it cannot move them: you send them yourself, from your own wallet.</p>
        <p>Swaps are executed by NEAR Intents 1Click, a service run by others. IntentSwap is independent of that service: it does not act for it or speak for it. Using IntentSwap makes no contract between you and that service.</p>
      </Section>

      <Section title="2. Who may use it">
        <p>You may use IntentSwap only if all of these are true:</p>
        <ul>
          <li>You are at least 18 years old.</li>
          <li>You are not in, and not a resident of, a country or territory that is under sanctions. IntentSwap is not for people or places under sanctions.</li>
          <li>You are not on a sanctions list, and you are not acting for anyone who is.</li>
          <li>Using it is lawful where you are. You must not use it where that would be unlawful.</li>
        </ul>
        <p>These are conditions on you. It is for you to know whether you meet them.</p>
      </Section>

      <Section title="3. How a swap works">
        <p>You choose the coin you pay and the coin you receive, and you give a receiving address. You are shown a quote: what you send, about what you receive, the least you will receive, every fee, and how long you have to pay. Nothing happens until you confirm.</p>
        <p>Confirming makes an order. An order cannot be changed once it is made. Making an order moves no coins. You then pay it, either from a connected wallet or by sending to the deposit address shown.</p>
        <p>Blockchain transfers cannot be undone. Once you have sent coins, nobody can call them back: not you, not IntentSwap.</p>
      </Section>

      <Section title="4. Fees">
        <p>IntentSwap takes no fee. The only fee is the provider's 0.20%. What a swap is charged is shown before you confirm, in the quote and again in the review:</p>
        <ul>
          <li>The provider's fee, a percentage of what you send, taken by the swap service. The figure for your swap is the one in its quote.</li>
          <li>The network fee of the chain you receive on. It is taken from what you receive and is already inside the amount shown.</li>
        </ul>
        <p>Your wallet also pays the usual network fee of the chain you send from. IntentSwap does not set it and does not receive it.</p>
        <p>The amount you receive can differ from the quote, up or down. If the swap fills at a better price than quoted, the swap service may keep up to half of the difference. If it fills at a worse price, you bear the difference, but never below the minimum shown to you.</p>
      </Section>

      <Section title="5. Deadlines, refunds and what can be lost">
        <p>Each order has a deadline, shown when you review it and on the order's page. Pay before it.</p>
        <ul>
          <li>If a swap cannot complete, the swap service sends your coins back to your refund address, less its refund fee and the network fee.</li>
          <li>If you send too little, the swap does not go ahead and what you sent is returned to your refund address by the deadline.</li>
          <li>If you send too much, the swap goes ahead and the extra is returned to your refund address.</li>
          <li>If you send after the deadline, your coins may be lost.</li>
          <li>If you send a different coin, on a different network, to a wrong address, or without a memo that was asked for, your coins may be lost.</li>
        </ul>
        <p>Whether coins sent late or wrongly can be recovered is for the swap service alone to decide. It does not consider requests about amounts under 300 US dollars that were lost through the sender's own mistake. IntentSwap cannot recover coins for you.</p>
      </Section>

      <Section title="6. Your wallet is yours to look after">
        <p>You alone hold the keys to your wallet. IntentSwap never asks for a seed phrase or for any key to your wallet, and never will. Anyone who asks for one in IntentSwap's name is not IntentSwap.</p>
        <p>You are responsible for the addresses you enter. Check them character by character. Coins sent to a wrong address cannot be returned.</p>
      </Section>

      <Section title="7. No advice, and nothing promised">
        <p>Nothing on this site is financial, legal or tax advice. Crypto assets are high risk. You can lose all of what you put in.</p>
        <p>Prices move. Blockchains and bridges can fail or slow down. The site, and the swap service behind it, may be slow, wrong or unavailable at any time. Nothing is promised about price, about whether or when a swap completes, or about the site being available.</p>
      </Section>

      <Section title="8. What you must not do">
        <ul>
          <li>Use the site from a place under sanctions, or where using it is unlawful.</li>
          <li>Use it with coins that come from crime, or to hide where coins came from.</li>
          <li>Use it for anyone who is on a sanctions list.</li>
          <li>Attack the site, overload it, or use its data routes from anything other than the site itself.</li>
        </ul>
      </Section>

      <Section title="9. The swap service, and the limits of responsibility">
        <p>You use the swap service at your own risk. To the fullest extent the law allows, you release it, and those who build and run it, from any claim arising from a swap made through this site, and you accept that it gives no warranty of any kind.</p>
        <p>To the fullest extent the law allows, IntentSwap and its operator are not liable for losses that come from price changes, from a blockchain, bridge or wallet, from the swap service, from a mistake in an address, amount, network or memo, from a late payment, or from the site being unavailable. Where liability cannot be excluded, it is limited to the IntentSwap fee, if any, that you paid on the swap in question.</p>
      </Section>

      <Section title="10. If you are in the United Kingdom">
        <p>Crypto assets are not protected in the United Kingdom. This service is not regulated by the Financial Conduct Authority, and you will not have access to the Financial Ombudsman Service or the Financial Services Compensation Scheme if something goes wrong. Do not use it unless you are prepared to lose all of what you put in.</p>
      </Section>

      <Section title="11. Points and weekly rewards">
        <p>
          IntentSwap keeps a record of points for delivered swaps, and may send a weekly payout shared out by points. <Link href="/docs/rewards">The rules</Link> are part of these terms.
        </p>
        <ul>
          <li>Points are a record and nothing more. They have no money value. They are not a currency, an investment or a claim on anything, and they cannot be bought, sold or moved.</li>
          <li>A payout is not owed. Whether there is one in a given week, and how large it is, is at the operator's discretion; it can be changed, made smaller or stopped at any time, also for points already recorded.</li>
          <li>Points recorded by mistake, or gained by abusing the site, can be corrected or removed.</li>
          <li>A rewards address is screened like every other address. Nothing is sent to an address on a sanctions list, or for anyone in a place where the site is not available.</li>
          <li>Seeing your own points means signing one plain message with your wallet, on the Rewards page only. It lasts {REWARDS.sessionMinutes} minutes. Paying for a swap never asks for a signature.</li>
        </ul>
      </Section>

      <Section title="12. Governing law">
        <p>These terms are governed by the law of the country in which the operator of IntentSwap is established, and disputes go to the courts of that country. Nothing here takes away a right that the law of the place where you live gives you and does not let you sign away.</p>
      </Section>

      <Section title="13. Changes and contact">
        <p>These terms may change. The version in force is the one shown here when you confirm an order, and its version label is kept with that order.</p>
        <p>
          <Contact />
          Support asks only for the order ID, the deposit transaction hash, the chain you sent from and the time. Support never asks for a seed phrase and never messages you first.
        </p>
      </Section>

      {/* Only where swaps are routed privately. It comes last, so that the sections before it keep their numbers either way. */}
      {privateOn ? (
        <Section title="14. Private routing">
          <p>IntentSwap asks the swap service to route each swap with its confidential routing. With it, the link between your deposit and your delivery is not in public records. The deposit and the delivery themselves are public transfers, each on its own blockchain.</p>
          <ul>
            <li>Private routing is not anonymity. The swap service's confidential system can see a swap, and so can IntentSwap for what is needed to run your order.</li>
            <li>Addresses are screened against the sanctions list, by IntentSwap and by the swap service, on a privately routed swap as on any other. The swap service applies its own rules on prohibited places and persons.</li>
            <li>You must not use IntentSwap to conceal the proceeds of crime, or to get round sanctions or any law.</li>
            <li>The swap service does not promise that confidentiality is complete, and it may be required to disclose what it holds. IntentSwap does not promise it either.</li>
            <li>When private routing cannot be had for a swap, the swap is not made unless you choose public routing for it. A swap made that way is an ordinary public swap.</li>
            <li>The fees of a privately routed swap are shown in its quote before you confirm, as for any swap, and it adds points by the same rules.</li>
          </ul>
        </Section>
      ) : null}
    </DocsLayout>
  );
}

export function PrivacyPage() {
  const privateOn = useApp((state) => isPrivateMode(state.config));
  const site = useSiteHost();
  // Whether this server refuses visitors by where they are. Only then does it work out a visitor's country.
  const regionBlock = useApp((state) => state.config?.regionBlock === true);
  return (
    <DocsLayout href="/privacy" title="Privacy Policy" lead="What IntentSwap keeps, for how long, and who else is involved in a swap.">
      <Version />

      <Section title="1. The short version">
        <p>IntentSwap{site !== null ? <> ({site})</> : null} has no accounts, sets no cookies and runs no analytics. It loads nothing from other sites: fonts, icons and every other file come from IntentSwap itself. It keeps what it needs to carry out and show your swap, for a limited time, and nothing else.</p>
        {privateOn ? (
          <p>Your deposit and your delivery are public. Each is a transfer recorded on its blockchain, where anyone can see the addresses and the amounts. IntentSwap cannot change that. With private routing, the link between the two is not in public records. The provider's confidential system, which processes the swap, knows both ends of it. IntentSwap keeps the order as set out below, both addresses included, and the order's record also says how it was routed. Private routing is not anonymity.</p>
        ) : (
          <p>Swaps themselves are public. Every transfer is recorded on its blockchain, where anyone can see the addresses and the amounts. IntentSwap cannot change that.</p>
        )}
      </Section>

      <Section title="2. What is kept on the server, and for how long">
        <ul>
          <li>
            <strong>Orders.</strong> When you confirm a swap, the server keeps the order: when it was made; the two coins; the amounts, the fees and the slippage limit; your receiving and refund addresses; the paying wallet's address if you connected one; the rewards address, if the order has one; the deposit address, and the memo where an order has one; the deadline; the provider's signed quote for the order, as it was given; the order's status and when it last changed; the transaction hashes of the deposit and of the delivery or refund, whether you gave them or the provider reported them, with the amounts that arrived, were delivered or were refunded and the reason for a refund; the version of the Terms you accepted; and the result of the sanctions check, with when it was made and which list it was made against. An order that was never paid is deleted 24 hours after its deadline. Other orders are deleted 30 days after they finish. An unfinished order that has coins in it is kept until it has been dealt with.
          </li>
          <li>
            <strong>Access log.</strong> For each request to the site's data routes: the time, the route and the kind of request, the outcome, how long it took, a shortened network address (not the full one), {regionBlock ? <>the country, </> : null}a one-way fingerprint of the order ID, the outcome of the sanctions check when an order is made, and the provider's reference number for the request when there is one. No wallet address and no order link is written to it. It is deleted after 14 days.
          </li>
          <li>
            <strong>Running log.</strong> The server also writes a log of its own work, which the host keeps for the host's own period: when each order's status changed, naming the order by a one-way fingerprint; the alerts raised for the operator; and the provider's reference numbers. It holds no address and no order link.
          </li>
          <li>
            <strong>Points.</strong> When a swap is delivered and has a rewards address, the server writes down: a one-way fingerprint of the order's ID, the rewards address, IntentSwap's fee on that swap in US dollars, why the swap counted for less than in full if it did, the two coins and their chains, and the time. When a week is closed it writes down the pool, each rewards address's points and payout, and afterwards the payout transactions. These are the record of what was counted and paid, and are kept.
          </li>
          <li>
            <strong>Stats.</strong> For the Stats page the server keeps running totals of delivered swaps and, for 48 hours, one rounded row for each (the two coins and their chains, a size band and a quarter of an hour), with no address, no transaction hash, no exact amount and no exact time in either.
          </li>
          <li>
            <strong>Signing in on the Rewards page.</strong> The one-time code of a sign-in is held in the server's memory for {REWARDS.nonceMinutes} minutes and used once. The sign-in itself is not stored on the server: it is a pass that your browser shows with each request, good for {REWARDS.sessionMinutes} minutes. Your signature is checked and not kept.
          </li>
          <li>
            <strong>Track order.</strong> The order ID or deposit address you paste there is used to find the order, and is not written down.
          </li>
          <li>
            <strong>Your network address.</strong> It is used in memory to apply rate limits{regionBlock ? <>, and to work out your country and region</> : null}. Only the shortened form is written down.
          </li>
        </ul>
      </Section>

      <Section title="3. What is kept in your browser">
        <ul>
          <li>The list of coins, for up to 24 hours, so the site still opens if the list cannot be fetched.</li>
          <li>A list of the orders you made in this browser, so you can find them again. It holds the order ID, when the order was made and the two coins: no amount and no address. It never leaves your browser, and you can clear it at any time.</li>
          <li>When you pay an order from a connected wallet: a note of that order's ID, the time, and the transaction's hash once there is one. The note is first written when your wallet is asked, so that reloading the page follows the transfer you sent instead of offering to send it again. It is kept for your last few orders only.</li>
          <li>The Rewards page's sign-in is held in that page's memory only. It is not written to your browser's storage, and it ends when the page is closed or reloaded.</li>
          <li>When you connect a wallet: the wallet-connection software keeps its own notes in your browser, among them your wallet's address and the link to your wallet, so that the connection lasts from one page to the next. Disconnecting removes the connection.</li>
        </ul>
      </Section>

      <Section title="4. Who else is involved">
        <ul>
          <li>
            <strong>NEAR Intents 1Click</strong>, which executes the swap. It receives the coins, the amount, the slippage limit, your receiving and refund addresses, when you pay from a connected wallet that wallet's address, and the deposit's transaction hash once the server knows it. The server also asks it how the order is getting on. It is asked for price previews as well, from the moment an amount is entered and before anything is confirmed: a preview carries the coins, the amount and the slippage limit, any receiving or refund address already typed in full, and a connected wallet's address when paying from the wallet is chosen and the wallet is on the paying chain.
          </li>
          <li>
            <strong>Railway</strong>, which hosts the site and its data. Like any host, it stands in front of the server and may keep its own record of each request for its own period: the time, your full network address and the address requested. For an order's page that address contains the order's ID. IntentSwap's own logs never hold either in full.
          </li>
          <li>
            <strong>Blockchain node providers</strong>, which the server asks about balances and transactions on your behalf. They see the addresses asked about, not your network address.
          </li>
          <li>
            <strong>Reown (WalletConnect)</strong>, only if you press Connect. Your browser then fetches the list of wallets from it and, if you connect a wallet on a phone, passes messages to that wallet through its relay. Like any service your browser contacts, it sees your network address and which site is asking. IntentSwap switches off the usage reports that its software would otherwise send, and does not look your wallet address up with it. Until you press Connect, nothing of it is loaded.
          </li>
          <li>
            <strong>Block explorers</strong>, only if you follow a link to one.
          </li>
          <li>
            <strong>The operator's alert channel</strong>, a messaging service the operator chooses, which is told when something needs attention. An alert never holds an address or a link to an order; at most it names an order by a one-way fingerprint.
          </li>
        </ul>
        <p>A payout is a transfer on BNB Chain from the reserve wallet to a rewards address. Like every transfer, it is public: anyone can see the address and the amount.</p>
        <p>Addresses are checked against the sanctions list published by the United States Treasury. The list is downloaded to the server and the check happens there; your addresses are not sent to anyone for it.</p>
        {/* Only where the server is set to refuse visitors by where they are: nowhere else is a country worked out at all. */}
        {regionBlock ? (
          <p>
            Your country and region are worked out on the server from a database it holds.{" "}
            <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
              IP geolocation by DB-IP
            </a>
            .
          </p>
        ) : null}
      </Section>

      <Section title="5. Asking for deletion">
        <p>
          You can ask for an order record to be deleted before its time. <Contact />
          Give the order ID. Records that must be kept to deal with an unfinished swap, or by law, are kept until that reason has passed.
        </p>
      </Section>
    </DocsLayout>
  );
}
