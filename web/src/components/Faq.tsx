import { ChevronDown } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { GAS_DOC_SLUG, GHOST_DOC_SLUG, PRIVATE_DOC_SLUG } from "../../../shared/pages.ts";
import { REWARDS } from "../../../shared/rewards.ts";
import { docHref } from "../lib/docs-logic.ts";
import { isPrivateMode } from "../lib/site-logic.ts";
import { useApp } from "../stores/app.ts";
import { SectionHead } from "./Home.tsx";
import { Link } from "./Link.tsx";
import { Reveal } from "./Reveal.tsx";

export interface Question {
  /** The question's own address within a page. */
  id: string;
  question: string;
  /** The answer. It is given the published support contact, or null where there is none, and whether swaps are routed privately. */
  answer(contact: string | null, privateRouting: boolean): ReactNode;
  /** A question asked only where swaps are routed privately. It is not on the list anywhere else. */
  privateOnly?: true;
}

/**
 * Questions people ask before a first swap, answered in plain words. Every answer states what
 * happens, not what is hoped. One list: the home page shows it folded, the Docs show it open.
 *
 * Where swaps are routed privately there are two questions more, and three answers say what private
 * routing changes: what others can see, what a swap costs, and what adds points. Where they are
 * not, nothing on the list speaks of private routing (see `questions`).
 *
 * One question is about Ghost mode, and is asked everywhere: what it does, what it does not, and
 * where the rest is written.
 *
 * The second of the two is about Add gas, which is offered only beside a privately routed swap.
 * There too, the answer on connecting a wallet says that a swap with gas is paid with two transfers.
 */
const FAQ: readonly Question[] = [
  {
    id: "what-is-intentswap",
    question: "What is IntentSwap?",
    answer: () => <p>A website for swapping one coin for another across blockchains. Swaps run on NEAR Intents. IntentSwap is the interface: it never holds your funds.</p>,
  },
  {
    id: "cost",
    question: "What does a swap cost?",
    answer: (_contact, privateRouting) => (
      <p>
        IntentSwap takes no fee. The only fee is the provider's 0.20%. Every quote shows it before you confirm, with the network fee of the chain you receive on, and the amount you receive is shown after both. Your wallet also pays the usual network fee of the chain you send from.
        {privateRouting ? <> A privately routed swap shows the same fees, each on its own line.</> : null}
      </p>
    ),
  },
  {
    id: "time",
    question: "How long does it take?",
    answer: () => <p>Each quote shows its own estimate, and the order's page counts the time as it passes. Swaps from Bitcoin and similar chains take longer, because their transactions take longer to confirm.</p>,
  },
  {
    id: "wallet",
    question: "Do I need to connect a wallet?",
    answer: (_contact, privateRouting) => (
      <p>
        No. You can connect a wallet and pay with one transfer, or pay without connecting by sending to the deposit address shown for your order, from any wallet.
        {privateRouting ? <> With Add gas there are two orders, and so two payments: two transfers from a connected wallet, or two deposit addresses to send to.</> : null}
      </p>
    ),
  },
  {
    id: "failed",
    question: "What happens if a swap fails?",
    answer: () => <p>The provider sends your coins back to your refund address automatically, less its refund fee and the network fee. The order's page shows when that has happened.</p>,
  },
  {
    id: "wrong-amount",
    question: "What if I send too little, too much, or too late?",
    answer: () => <p>Too little: the swap does not go ahead and what you sent is returned to your refund address by the deadline. Too much: the swap goes ahead and the extra is returned. After the deadline: your coins may be lost. Send the exact amount shown, on the network shown, before the time shown.</p>,
  },
  {
    id: "exchange",
    question: "Can I receive at an exchange?",
    answer: () => <p>Use a wallet address you control. Some exchanges need a memo or tag with a deposit, and a memo cannot be added to what you receive here.</p>,
  },
  {
    id: "private-routing",
    question: "What is private routing?",
    privateOnly: true,
    answer: () => (
      <p>
        A way of routing a swap so that what you send and what you receive are not tied to each other in public records. NEAR Intents runs it, and calls it confidential routing. Swaps on this site use it. Your deposit and your delivery are still ordinary public transfers. Private routing is not anonymity. <Link href={docHref(PRIVATE_DOC_SLUG)}>How private routing works</Link>
      </p>
    ),
  },
  {
    id: "public",
    question: "Can other people see my swap?",
    answer: (_contact, privateRouting) =>
      privateRouting ? (
        <p>
          In part. Your deposit and your delivery are each recorded on a blockchain, where anyone can see the addresses and the amounts. The link between the two is not in public records. Amounts and timing can still give hints, and the provider's confidential system can see the swap, as can IntentSwap for what is needed to run your order. Private routing is not anonymity. A swap made without private routing is an ordinary public swap: its deposit and its delivery can be matched to each other.
        </p>
      ) : (
        <p>Yes. Every transfer is recorded on its blockchain, where anyone can see the addresses and the amounts.</p>
      ),
  },
  {
    id: "ghost-mode",
    question: "What is Ghost mode?",
    answer: () => (
      <p>
        A switch in the header. While it is on, this site loads no wallet software and keeps nothing in your browser but the switch itself, and the record of an order you make is deleted from its server the moment the order is delivered or refunded. It does not make a swap less public: the deposit and the delivery are still public transfers, the swap service still carries out the swap, and your network and this site's host still see your network address. <Link href={docHref(GHOST_DOC_SLUG)}>How Ghost mode works</Link>
      </p>
    ),
  },
  {
    id: "add-gas",
    question: "What is Add gas?",
    privateOnly: true,
    answer: () => (
      <p>
        A switch on the swap card, shown where gas can be added. A new wallet has none of its chain's own coin to pay network fees with, so a coin that arrives there, such as USDC on Solana, cannot be moved. With Add gas on, a second, small order delivers a little of the chain's own coin to the same receiving address, by the same private route as the swap, so the new wallet needs no funding from an old one. There are two payments: one for the swap, and one for the gas. <Link href={docHref(GAS_DOC_SLUG)}>How Add gas works</Link>
      </p>
    ),
  },
  {
    id: "points",
    question: "What are points?",
    answer: (_contact, privateRouting) => (
      <p>
        Each delivered swap adds points to a rewards address: {REWARDS.pointsPerUsd} for each $1 swapped. A swap that is refunded or fails adds nothing.{privateRouting ? <> A privately routed swap adds points the same way.</> : null} Each week a payout is shared out by points and sent by hand, in NEAR on BNB Chain. Points have no money value, and a payout is at IntentSwap's discretion and can change. <Link href="/docs/rewards">The rules in full</Link>
      </p>
    ),
  },
  {
    id: "signature",
    question: "Why does the Rewards page ask my wallet to sign?",
    answer: () => <p>To show that an address is yours before its points are shown to you. It is one plain message, not a transaction: it moves nothing, approves nothing and costs no network fee. It is the only signature this site ever asks for. Paying for a swap never asks for one.</p>,
  },
  {
    id: "find-order",
    question: "How do I find my order again?",
    answer: () => <p>Each order has its own link. Keep it: it opens the order on any device. Orders made in this browser are also listed on the Track order page. An order made in Ghost mode is on no list: its own link is the only way back to it.</p>,
  },
  {
    id: "help",
    question: "How do I get help?",
    answer: (contact) => (
      <p>
        {contact !== null ? <>Write to {contact.replace(/^https:\/\//, "")}. </> : null}
        Have the order's link, the deposit transaction hash, the chain you sent from and the time.
      </p>
    ),
  },
];

/** The questions as they stand on this site: every one of them where swaps are routed privately, and all but the two asked only there (private routing, Add gas) where they are not. */
export function questions(privateRouting: boolean): readonly Question[] {
  return privateRouting ? FAQ : FAQ.filter((item) => item.privateOnly !== true);
}

function Item({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="faq-item">
      <summary>
        <span>{question}</span>
        <ChevronDown className="fold-chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
      </summary>
      <div className="faq-answer muted">{children}</div>
    </details>
  );
}

/** The questions as one of the home page's sections: its heading to the left where there is room, each question folded. */
export function Faq() {
  const contact = useApp((state) => state.config?.supportContact ?? null);
  const privateOn = useApp((state) => isPrivateMode(state.config));
  const section = useRef<HTMLElement>(null);
  // A link to "/#faq" opened directly, or followed from another page, arrives before this section
  // exists: the browser has nothing to scroll to. So the section brings itself into view.
  useEffect(() => {
    const show = () => {
      if (window.location.hash === "#faq") section.current?.scrollIntoView();
    };
    show();
    window.addEventListener("hashchange", show);
    return () => window.removeEventListener("hashchange", show);
  }, []);
  return (
    <section ref={section} className="faq" id="faq" aria-labelledby="faq-title">
      <SectionHead tag="Help" title="Questions" id="faq-title">
        Asked before a first swap, and answered in plain words.
      </SectionHead>
      <Reveal className="faq-list">
        {questions(privateOn).map((item) => (
          <Item key={item.id} question={item.question}>
            {item.answer(contact, privateOn)}
          </Item>
        ))}
      </Reveal>
    </section>
  );
}
