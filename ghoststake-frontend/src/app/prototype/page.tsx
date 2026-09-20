"use client";

import { useState } from "react";

/**
 * A design prototype for GHO-78, on static data.
 *
 * Not wired to anything: no chain, no API, no wallet. The point is to judge
 * the *reading* of the surface — what leads, what recedes, what a number
 * means — before any of it is plumbed. Everything here uses the real faces
 * and the real tokens from GHO-58, so what you see is what the app would be.
 *
 * Delete this route once the design is settled and the real components carry
 * it. It is deliberately one file.
 */

// ---------------------------------------------------------------------------
// Static stand-ins. Real numbers, so the layout is judged at real widths.
// ---------------------------------------------------------------------------

type Market = {
  id: string;
  question: string;
  /** Yes pool and No pool, in whole units of the stake asset. */
  yes: number;
  no: number;
  closesIn: string;
  phase: "open" | "cutoff" | "settled";
  /** Present once settled. */
  won?: "yes" | "no";
  /** Your stake, if any, as [yes, no]. */
  yours?: [number, number];
  thin?: boolean;
};

const RAKE = 0.02;

const MARKETS: Market[] = [
  {
    id: "eth-3400",
    question: "ETH above $3,400 at 14:30",
    yes: 6300,
    no: 3700,
    closesIn: "2:14",
    phase: "open",
  },
  {
    id: "btc-96k",
    question: "BTC above $96,000 at 15:00",
    yes: 820,
    no: 11400,
    closesIn: "11:47",
    phase: "open",
    yours: [0, 120],
  },
  {
    id: "eth-3350",
    question: "ETH above $3,350 at 14:15",
    yes: 4100,
    no: 300,
    closesIn: "0:38",
    phase: "cutoff",
    thin: true,
  },
  {
    id: "eth-3300",
    question: "ETH above $3,300 at 14:00",
    yes: 5200,
    no: 4800,
    closesIn: "—",
    phase: "settled",
    won: "yes",
    yours: [250, 0],
  },
];

/** A side's share of the pool. The crowd's implied probability. */
function share(m: Market, side: "yes" | "no"): number {
  const total = m.yes + m.no;
  if (total === 0) return 0;
  return ((side === "yes" ? m.yes : m.no) / total) * 100;
}

/**
 * What a unit on this side pays if it wins.
 *
 * The same fact as `share`, seen from the other end: a side holding most of
 * the pool pays least. Showing both is the cheapest honest explanation of
 * parimutuel this app can give.
 */
function pays(m: Market, side: "yes" | "no"): number | null {
  const sidePool = side === "yes" ? m.yes : m.no;
  if (sidePool === 0) return null;
  return ((m.yes + m.no) * (1 - RAKE)) / sidePool;
}

const money = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

// ---------------------------------------------------------------------------

export default function PrototypePage() {
  const [ticket, setTicket] = useState<{ id: string; side: "yes" | "no" } | null>({
    id: "eth-3400",
    side: "yes",
  });

  return (
    <div className="min-h-screen bg-ground">
      <div className="mx-auto max-w-md px-4 pt-5 pb-24">
        <Header />
        <MoneyStrip />

        <div className="mt-5 flex flex-col gap-3">
          {MARKETS.map((m) => (
            <QuestionCard
              key={m.id}
              market={m}
              ticket={ticket?.id === m.id ? ticket.side : null}
              onPick={(side) => setTicket({ id: m.id, side })}
              onClose={() => setTicket(null)}
            />
          ))}
        </div>

        <p className="mt-8 text-xs leading-relaxed text-ink-faint">
          Prototype on static numbers. Nothing here touches a wallet or a chain.
        </p>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="flex items-baseline justify-between">
      <span className="display text-xl text-brand">GhostStake</span>
      <span className="text-xs text-ink-faint">Sepolia</span>
    </header>
  );
}

/**
 * The one thing Polymarket cannot render: the same capital doing two jobs.
 *
 * One bar, because it is one pot. The filled head is what is committed to open
 * markets; the tail is what is free. Both halves are earning the whole time,
 * which is the sentence underneath and the reason this protocol exists.
 *
 * This is where the design spends its boldness. Everything below it is quiet
 * on purpose.
 */
function MoneyStrip() {
  const staked = 250;
  const riding = 80;
  const committed = (riding / staked) * 100;

  return (
    <section className="mt-4 rounded-card border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="tabular text-3xl text-ink">{money(staked)}</span>
        <span className="tabular text-sm text-up">+{money(0.42)} today</span>
      </div>

      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-up" style={{ width: `${committed}%` }} />
      </div>

      <p className="mt-2.5 text-sm leading-relaxed text-ink-muted">
        <span className="tabular text-ink">{money(riding)}</span> of your stake is riding on{" "}
        <span className="tabular text-ink">3</span> markets. All of it is still earning{" "}
        <span className="tabular text-ink">5.0%</span>.
      </p>

      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <span className="text-xs text-ink-muted">Safety</span>
        <span className="tabular text-sm text-up">2.40</span>
        <span className="text-xs text-ink-faint">· liquidated below 1.00</span>
      </div>
    </section>
  );
}

function QuestionCard({
  market,
  ticket,
  onPick,
  onClose,
}: {
  market: Market;
  ticket: "yes" | "no" | null;
  onPick: (side: "yes" | "no") => void;
  onClose: () => void;
}) {
  const yesShare = share(market, "yes");
  const settled = market.phase === "settled";
  const open = market.phase === "open";

  return (
    <article className="rounded-card border border-border bg-surface p-4">
      <h2 className="display text-base leading-snug text-ink">{market.question}</h2>

      {/* The percentage leads and the bar sits with it, because they are the
          same fact. A figure beside its own picture needs no legend. */}
      <div className="mt-3 flex items-center gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="tabular text-2xl text-ink">{yesShare.toFixed(0)}%</span>
          <span className="text-xs text-ink-muted">say yes</span>
        </div>

        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-down">
          <div className="h-full bg-up" style={{ width: `${yesShare}%` }} />
        </div>

        {settled ? (
          <span className="text-xs text-ink-faint">Settled</span>
        ) : (
          <span className="tabular text-sm text-brand">{market.closesIn}</span>
        )}
      </div>

      {settled ? (
        <Settled market={market} />
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <SideButton market={market} side="yes" disabled={!open} onPick={onPick} />
          <SideButton market={market} side="no" disabled={!open} onPick={onPick} />
        </div>
      )}

      {market.thin && (
        <p className="mt-3 text-xs leading-relaxed text-warning">
          Almost nobody has taken No. If that holds, the market voids at close and every
          position is refunded in full.
        </p>
      )}

      {market.phase === "cutoff" && !market.thin && (
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Betting closed early so nobody can answer a question they can already see.
        </p>
      )}

      {ticket && open && <BetTicket market={market} side={ticket} onClose={onClose} />}
    </article>
  );
}

/**
 * One answer, with what the crowd thinks and what that pays.
 *
 * Tinted, not filled. Filled slabs were the first draft and they were wrong
 * twice over: eight saturated blocks per screen fight the money strip, which
 * is the one thing here worth being loud; and a side's colour area stopped
 * tracking its probability, so a 7% Yes read heavier than a 93% No sitting
 * beside it. The bar and the figure carry the odds. The button only has to
 * look pressable and say which answer it is.
 *
 * A side you already hold fills, because then the colour is reporting a fact
 * about you rather than competing for a decision.
 */
function SideButton({
  market,
  side,
  disabled,
  onPick,
}: {
  market: Market;
  side: "yes" | "no";
  disabled: boolean;
  onPick: (side: "yes" | "no") => void;
}) {
  const pct = share(market, side);
  const multiple = pays(market, side);
  const yours = market.yours?.[side === "yes" ? 0 : 1] ?? 0;
  const up = side === "yes";
  const held = yours > 0;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(side)}
      className={`flex flex-col items-start gap-0.5 rounded-control border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${
        held
          ? up
            ? "border-transparent bg-up text-up-ink"
            : "border-transparent bg-down text-down-ink"
          : up
            ? "border-up/35 bg-up-soft text-up hover:bg-up/20 disabled:border-border disabled:bg-transparent disabled:text-ink-faint"
            : "border-down/35 bg-down-soft text-down hover:bg-down/20 disabled:border-border disabled:bg-transparent disabled:text-ink-faint"
      }`}
    >
      <span className="display text-sm">{up ? "Yes" : "No"}</span>
      <span className="tabular text-lg leading-none">{pct.toFixed(0)}%</span>
      <span className={`tabular text-xs ${held ? "opacity-75" : "text-ink-muted"}`}>
        {multiple ? `pays ${multiple.toFixed(2)}×` : "no pool yet"}
      </span>
      {held && <span className="tabular text-xs opacity-75">you have {money(yours, 0)}</span>}
    </button>
  );
}

function Settled({ market }: { market: Market }) {
  const won = market.won === "yes" ? "Yes" : "No";
  const yourSide = (market.yours?.[0] ?? 0) > 0 ? "yes" : "no";
  const youWon = yourSide === market.won;
  const stake = Math.max(market.yours?.[0] ?? 0, market.yours?.[1] ?? 0);
  const payout = youWon ? stake * (pays(market, yourSide) ?? 1) : 0;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-control bg-raised px-3 py-2.5">
      <p className="text-sm text-ink-muted">
        {won} won.{" "}
        {youWon ? (
          <>
            You take <span className="tabular text-up">{money(payout)}</span>.
          </>
        ) : (
          <>Your {money(stake, 0)} stays with the market.</>
        )}
      </p>
      {youWon && (
        <button
          type="button"
          className="display rounded-control bg-action px-3.5 py-1.5 text-sm text-ground shadow-[inset_0_-3px_0_#1c9c59]"
        >
          Collect
        </button>
      )}
    </div>
  );
}

/**
 * The ticket.
 *
 * Two sources of money, and the second is the product: borrowing against a
 * stake that keeps earning. The consequence of borrowing is stated on the same
 * screen as the choice, above the button and not after it.
 */
function BetTicket({
  market,
  side,
  onClose,
}: {
  market: Market;
  side: "yes" | "no";
  onClose: () => void;
}) {
  const [wallet, setWallet] = useState("25");
  const [borrow, setBorrow] = useState("50");

  const w = Number(wallet) || 0;
  const b = Number(borrow) || 0;
  const total = w + b;
  const multiple = pays(market, side) ?? 1;
  const safetyAfter = b > 0 ? 2.4 - b * 0.011 : 2.4;

  return (
    <div className="mt-4 rounded-control border border-border-strong bg-raised/60 p-3.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm text-ink">
          Backing{" "}
          <span className={`display ${side === "yes" ? "text-up" : "text-down"}`}>
            {side === "yes" ? "Yes" : "No"}
          </span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-ink-faint transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-2.5">
        <Field label="From your wallet" value={wallet} onChange={setWallet} note="120.00 free" />
        <Field
          label="Borrowed against your stake"
          value={borrow}
          onChange={setBorrow}
          note="150.00 available"
        />
      </div>

      {b > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Your stake never leaves the vault and keeps earning. Safety drops{" "}
          <span className="tabular text-ink">2.40</span> →{" "}
          <span className={`tabular ${safetyAfter < 1.5 ? "text-warning" : "text-ink"}`}>
            {safetyAfter.toFixed(2)}
          </span>
          . If this market goes against you the debt stands.
        </p>
      )}

      <button
        type="button"
        disabled={total === 0}
        className="display mt-3 w-full rounded-control bg-action px-4 py-3 text-ground shadow-[inset_0_-3px_0_#1c9c59] transition-colors hover:bg-action-strong disabled:cursor-not-allowed disabled:opacity-45"
      >
        Back {side === "yes" ? "Yes" : "No"} with {money(total)}
      </button>

      <p className="mt-2 text-center text-xs text-ink-faint">
        Returns <span className="tabular">{money(total * multiple)}</span> if it lands, at
        today&rsquo;s odds
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  note,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  note: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-xs text-ink-muted">{label}</label>
        <span className="tabular text-xs text-ink-faint">{note}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 rounded-control border border-border bg-ground px-3 py-2 focus-within:border-border-strong">
        <input
          value={value}
          inputMode="decimal"
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          className="tabular w-full bg-transparent text-lg text-ink outline-none"
        />
        <span className="text-sm text-ink-faint">USDC</span>
      </div>
    </div>
  );
}
