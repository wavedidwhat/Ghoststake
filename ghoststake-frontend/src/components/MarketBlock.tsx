"use client";

import { useState } from "react";
import { erc20Abi } from "viem";
import { useReadContract } from "wagmi";
import { AmountField, TxStatus } from "@/components/AmountField";
import { parseAmount } from "@/lib/amount";
import { sideLabel } from "@/lib/question";
import { Card } from "@/components/ui/Card";
import { ConnectButton } from "@/components/ConnectButton";
import { RoundCard } from "@/components/RoundCard";
import type { MarketFeed } from "@/hooks/useMarketFeeds";
import type { Spot } from "@/hooks/useSpot";
import type { MarketRound } from "@/hooks/useRounds";
import { useTransaction } from "@/hooks/useTransaction";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { borrowToPositionRouterAbi, collateralVaultAbi, parimutuelRoundAbi } from "@/lib/abis";
import { env } from "@/lib/env";
import { formatAmount, formatHealthFactor, healthBand } from "@/lib/format";
import { SideArrow } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/Sheet";
import type { Market } from "@/lib/markets";
import { Phase, Side, type PhaseValue, type SideValue } from "@/lib/rounds";
import { activeChain } from "@/lib/wagmi";
import { Button, TextButton } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Badge } from "@/components/ui/Badge";
import { MarketMark } from "@/components/MarketMark";
import { ExplorerLink } from "@/components/ui/ExplorerLink";

/**
 * One market and its rounds, with the forms to enter and to claim.
 *
 * Lifted out of `app/markets/page.tsx` by GHO-41, unchanged. It was already
 * the whole of a market view; it just could not be reached from a URL, because
 * which market you were looking at lived in React state on the list page. Two
 * routes now render it — the list's own inline view is gone, and
 * `/markets/[market]` and `/markets/[market]/[id]` are what remain — and a
 * second copy of this would have been two markets pages disagreeing about what
 * a market looks like within a week.
 */
export function MarketBlock({
  market,
  params,
  feed,
  spot,
  rounds,
  address,
  position,
  decimals,
  now,
  taking,
  setTaking,
  refetch,
}: {
  market: Market;
  params: { entryCutoff: bigint; minSidePool: bigint; rake: bigint } | undefined;
  feed: MarketFeed | undefined;
  /** The live price, for the card's "which side is ahead" line (GHO-64). */
  spot: Spot | undefined;
  rounds: MarketRound[];
  /** Undefined when nobody is connected: the market still reads, and only
   *  the actions need an address. See GHO-44. */
  address: `0x${string}` | undefined;
  position: ReturnType<typeof useVaultPosition>;
  /** The asset's scale, known. Its own prop rather than `position.decimals!`
   *  (GHO-86): the caller has to have narrowed it, so a figure can never be
   *  formatted against a scale nobody read. */
  decimals: number;
  now: bigint | undefined;
  taking: { key: string; id: bigint; side: SideValue } | null;
  setTaking: (v: { key: string; id: bigint; side: SideValue } | null) => void;
  refetch: () => void;
}) {
  // A market whose immutables could not be read used to render as nothing at
  // all — no message, no skeleton, no error (GHO-82). That was reachable for
  // anyone hitting the RPC ceiling, and an empty space is the one outcome a
  // user cannot act on or report. Say what is missing instead.
  //
  // Not an error state: the rounds themselves are fine and come from the
  // indexer. What is unavailable is the rake and the entry cutoff, and without
  // those the odds and the phase would be guesses.
  if (!params) {
    return (
      <section className="flex flex-col gap-4">
        <MarketHeader market={market} feed={feed} />
        <Card>
          <p className="text-sm text-ink-muted">
            This market&rsquo;s terms could not be read, so its odds and countdown are not
            shown. Nothing about your position has changed.
          </p>
          <p className="mt-2 text-xs text-ink-faint">
            The rake and entry cutoff are read from the contract, and that read is failing.
            This usually clears on its own.
          </p>
        </Card>
      </section>
    );
  }

  const live = rounds.filter((r) => r.phase !== Phase.Resolved && r.phase !== Phase.Void);
  const done = rounds.filter((r) => r.phase === Phase.Resolved || r.phase === Phase.Void);

  const card = (r: MarketRound, withClaim: boolean) => (
    <RoundCard
      key={`${market.key}-${r.id}`}
      id={r.id}
      round={r.round}
      phase={(r.phase ?? Phase.None) as PhaseValue}
      href={`/markets/${market.address}/${r.id}`}
      entryCutoff={params.entryCutoff}
      minSidePool={params.minSidePool}
      rake={params.rake}
      decimals={decimals}
      symbol={position.symbol}
      feed={feed?.description}
      isQuestion={feed?.isQuestion}
      feedAddress={feed?.feed}
      // A question is not settled by a price, so there is no "ahead" to show:
      // its oracle answers the sentinel strike and nothing else (GHO-91).
      spot={feed?.isQuestion ? undefined : spot}
      now={now}
      yourUp={r.up}
      yourDown={r.down}
      onStake={withClaim ? undefined : (side) => setTaking({ key: market.key, id: r.id, side })}
    >
      {withClaim ? (
        // Nothing to claim without an address, and a claim row for a
        // settled round a visitor was never in would be a control that
        // cannot do anything.
        address && (
          <ClaimRow
            market={market}
            roundId={r.id}
            claimable={r.claimable}
            claimed={r.isClaimed}
            positionSize={(r.up ?? 0n) + (r.down ?? 0n)}
            decimals={decimals}
            symbol={position.symbol}
            address={address}
            onDone={() => {
              refetch();
              position.refetch();
            }}
          />
        )
      ) : (
        taking?.key === market.key &&
        taking.id === r.id &&
        // The side buttons stay live for a visitor, and answer with the
        // connect prompt rather than being disabled. A disabled control
        // explains nothing; this says what is missing at the moment they
        // reached for it, which is the moment the ask makes sense.
        (address ? (
          <PositionForm
            market={market}
            roundId={r.id}
            side={taking.side}
            address={address}
            position={position}
            decimals={decimals}
            onClose={() => setTaking(null)}
            onDone={() => {
              setTaking(null);
              refetch();
              position.refetch();
            }}
          />
        ) : (
          <ConnectToTake onClose={() => setTaking(null)} />
        ))
      )}
    </RoundCard>
  );

  return (
    <section className="flex flex-col gap-4">
      <MarketHeader market={market} feed={feed} />

      {rounds.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-muted">
            No rounds have been opened on this market yet. Rounds are scheduled by the keeper
            (GHO-24); until it runs, the owner opens them by hand.
          </p>
        </Card>
      ) : (
        <>
          <Section title="Live" empty="Nothing open right now.">
            {live.map((r) => card(r, false))}
          </Section>
          <Section title="Settled" empty="Nothing has settled yet.">
            {done.map((r) => card(r, true))}
          </Section>
        </>
      )}
    </section>
  );
}

export function MarketHeader({ market, feed }: { market: Market; feed: MarketFeed | undefined }) {
  // Either source saying "demo" is enough. The chain is the authority, but
  // until it has answered the configured slot is the safer guess: erring
  // towards the demo label costs a Chainlink market a badge for a second,
  // while erring the other way tells someone a hand-set price is a Chainlink
  // one.
  const demo = market.kindHint === "demo" || feed?.isDemo === true;
  const knownFeed = feed !== undefined;

  // The feed's own description — "ETH / USD" on a Chainlink aggregator. The
  // demo feed prefixes its label with a shout, which the badge already says,
  // so only the asset half is kept here.
  // The feed's own description — "ETH / USD" on a Chainlink aggregator. There
  // is no fallback label to fall back to: the registry deliberately stores
  // none, so an unread feed is "reading", not a guess.
  const label = feed ? (feed.description.split(" - ").pop() ?? "Market") : "Reading feed…";

  return (
    <div
      className={`rounded-card border p-4 ${
        demo ? "border-warning/50 bg-warning/5" : "border-border bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <MarketMark feed={feed} size="lg" />
        <h2 className="display text-lg text-ink">{label}</h2>
        {demo ? (
          <Badge>
            Demo feed
          </Badge>
        ) : knownFeed ? (
          <span className="rounded-sm bg-brand-soft px-2.5 py-0.5 text-xs font-medium text-brand">
            Chainlink
          </span>
        ) : (
          <span className="rounded-sm bg-raised px-2.5 py-0.5 text-xs text-ink-faint">
            reading feed…
          </span>
        )}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        {demo ? (
          <>
            <span className="font-medium text-warning">
              The price on this market is set by hand by the operator.
            </span>{" "}
            The contracts, the staking and the settlement are the real ones — only the feed is
            not. It exists because a round cannot resolve until its feed publishes after the
            close, and a real feed&rsquo;s heartbeat runs to tens of minutes; here a round can be
            watched all the way through.
          </>
        ) : knownFeed ? (
          <>
            Settlement is pinned to a Chainlink feed nobody here controls: the price is the last
            one the feed published at or before the close, and the round after it proves that.
          </>
        ) : (
          <>Reading this market&rsquo;s price feed from the chain.</>
        )}
      </p>

      {/* The two contracts that decide this market, so each claim above can
          be checked against the chain rather than taken from us (GHO-103). */}
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
        <span>
          Market <ExplorerLink address={market.address} />
        </span>
        {feed?.isQuestion
          ? feed.oracle && (
              <span>
                Oracle <ExplorerLink address={feed.oracle} />
              </span>
            )
          : feed?.feed && (
              <span>
                Price feed <ExplorerLink address={feed.feed} />
              </span>
            )}
      </p>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Eyebrow as="h2">{title}</Eyebrow>
        <span className="h-px flex-1 bg-border" />
      </div>
      {children.length === 0 ? (
        <p className="text-sm text-ink-faint">{empty}</p>
      ) : (
        <div className="flex flex-col gap-3">{children}</div>
      )}
    </section>
  );
}

/**
 * Stake into a round, from the wallet or against collateral.
 *
 * Borrowing routes through `BorrowToPositionRouter.openPosition`, which is one
 * transaction: the funds go vault → router → round and are never spendable in
 * between. The health factor preview below is the number that decides whether
 * someone should do it, so it is shown before the button, not after.
 */
function PositionForm({
  market,
  roundId,
  side,
  address,
  position,
  decimals,
  onClose,
  onDone,
}: {
  market: Market;
  roundId: bigint;
  side: SideValue;
  address: `0x${string}`;
  position: ReturnType<typeof useVaultPosition>;
  decimals: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [own, setOwn] = useState("");
  const [borrow, setBorrow] = useState("");
  const tx = useTransaction();

  const wallet = useReadContract({
    address: position.assetAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: activeChain.id,
    query: { enabled: Boolean(position.assetAddress) },
  });

  const routerAllowance = useReadContract({
    address: position.assetAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address, market.router],
    chainId: activeChain.id,
    query: { enabled: Boolean(position.assetAddress) },
  });

  const delegation = useReadContract({
    address: env.vaultAddress!,
    abi: collateralVaultAbi,
    functionName: "borrowAllowance",
    args: [address, market.router],
    chainId: activeChain.id,
  });

  // An empty field is zero; an unparseable one is *not* (GHO-86). This was
  // `parseAmount(own || "0", decimals) ?? 0n`, which turned seven decimal
  // places on a six-decimal token into zero: the field showed your number,
  // the button read "Take Up · 0.00", and nothing said why. AmountField now
  // says why; this keeps the refusal from being swallowed on the way.
  const ownParsed = own === "" ? 0n : parseAmount(own, decimals);
  const borrowParsed = borrow === "" ? 0n : parseAmount(borrow, decimals);
  const invalid = ownParsed === null || borrowParsed === null;
  const ownAmount = ownParsed ?? 0n;
  const borrowAmount = borrowParsed ?? 0n;
  const total = ownAmount + borrowAmount;

  const overWallet = wallet.data !== undefined && ownAmount > wallet.data;
  const overCapacity =
    position.maxBorrowable !== undefined && borrowAmount > position.maxBorrowable;

  const needsTokenApproval =
    ownAmount > 0n && (routerAllowance.data ?? 0n) < ownAmount;
  const needsDelegation = borrowAmount > 0n && (delegation.data ?? 0n) < borrowAmount;

  const preview = previewHealth(position, borrowAmount);

  const busy = tx.state.status === "signing" || tx.state.status === "pending";
  const disabled = busy || invalid || total === 0n || overWallet || overCapacity;

  async function submit() {
    if (needsTokenApproval) {
      const ok = await tx.send({
        address: position.assetAddress!,
        abi: erc20Abi,
        functionName: "approve",
        args: [market.router, ownAmount],
      });
      if (!ok) return;
      await routerAllowance.refetch();
    }

    if (needsDelegation) {
      // Approved for exactly this borrow rather than unlimited. An unlimited
      // delegation hands the router the whole LTV headroom for as long as it
      // stands, which is more than this one action needs.
      const ok = await tx.send({
        address: env.vaultAddress!,
        abi: collateralVaultAbi,
        functionName: "approveBorrowDelegate",
        args: [market.router, borrowAmount],
      });
      if (!ok) return;
      await delegation.refetch();
    }

    const ok = await tx.send({
      address: market.router,
      abi: borrowToPositionRouterAbi,
      functionName: "openPosition",
      args: [roundId, side, borrowAmount, ownAmount],
    });
    if (ok) onDone();
  }

  const answer = sideLabel(side);

  /*
   * The ticket is a sheet, not an inline block (GHO-59).
   *
   * Inline, it appeared below the market and pushed the action off a phone
   * screen: you tapped "Take Up", the form opened somewhere under your thumb,
   * and the button that actually spends the money was below the fold. As a
   * sheet it comes up from the bottom edge, where the thumb already is, and
   * the same component centres itself on a desktop.
   *
   * `open` is always true because this component only mounts once a side has
   * been chosen; closing it is the parent dropping it.
   */
  return (
    <Sheet open onClose={onClose} title={`${answer} · round ${roundId.toString()}`}>
      <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-ink">
        {/* The side is named with its arrow and its colour here too, so the
            confirm step cannot be read as the other side (GHO-58). */}
        <span
          className={`display flex items-center gap-1 text-base uppercase ${
            side === Side.Up ? "text-up" : "text-down"
          }`}
        >
          <SideArrow up={side === Side.Up} className="size-3" />
          {answer}
        </span>
        <span className="text-ink-muted">on round {roundId.toString()}</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <AmountField
          label="From your wallet"
          value={own}
          onChange={setOwn}
          max={wallet.data}
          decimals={decimals}
          symbol={position.symbol}
          maxLabel="Wallet"
          disabled={busy}
        />
        <AmountField
          label="Borrowed against your stake"
          value={borrow}
          onChange={setBorrow}
          max={position.maxBorrowable}
          decimals={decimals}
          symbol={position.symbol}
          maxLabel="Capacity"
          disabled={busy}
          hint="Goes straight from your stake into the market. It never reaches your wallet, and your stake keeps earning."
        />
      </div>

      {borrowAmount > 0n && preview && (
        <HealthPreview
          before={position.healthFactor}
          after={preview}
          decimals={decimals}
          borrowAmount={borrowAmount}
          symbol={position.symbol}
        />
      )}

      {overWallet && <p className="text-xs text-negative">More than your wallet holds.</p>}
      {overCapacity && (
        <p className="text-xs text-negative">
          Above your borrowing capacity. The vault would refuse this at the LTV ceiling.
        </p>
      )}

      {/*
       * The commit button takes the colour of the side being taken, never the
       * brand red (GHO-58), and it is the last thing in the sheet so it sits
       * closest to the thumb. `min-h-12` keeps it well over the 44px minimum
       * even with one line of label.
       */}
      <button
        onClick={submit}
        disabled={disabled}
        className={`display min-h-12 cursor-pointer rounded-sm px-4 py-3 text-base text-ground uppercase transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
          side === Side.Up ? "bg-up hover:bg-action-strong" : "bg-down hover:brightness-110"
        }`}
      >
        {busy
          ? "Working…"
          : invalid
            ? `Take ${answer}`
            : needsTokenApproval || needsDelegation
            ? `Approve and take ${answer}`
            : `Take ${answer} · ${formatAmount(total, decimals, 2)} ${position.symbol}`}
      </button>

      <TxStatus tx={tx} />
      </div>
    </Sheet>
  );
}

/**
 * What the health factor becomes if this borrow goes through.
 *
 * Computed the same way the vault does — `collateral × threshold ÷ debt` —
 * rather than approximated. A preview that disagrees with the contract is
 * worse than no preview, because it is the number someone decides on.
 *
 * Returns null when there is nothing to divide by.
 */
function previewHealth(
  position: ReturnType<typeof useVaultPosition>,
  borrowAmount: bigint,
): bigint | null {
  const { collateralValue, lien, liquidationThreshold } = position;
  if (collateralValue === undefined || lien === undefined || liquidationThreshold === undefined) {
    return null;
  }
  const debt = lien + borrowAmount;
  if (debt === 0n) return null;
  return (collateralValue * liquidationThreshold) / debt;
}

function HealthPreview({
  before,
  after,
  decimals,
  borrowAmount,
  symbol,
}: {
  before: bigint | undefined;
  after: bigint;
  decimals: number;
  borrowAmount: bigint;
  symbol: string;
}) {
  const band = healthBand(after);
  const tone =
    band === "danger" ? "text-negative" : band === "caution" ? "text-warning" : "text-positive";

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">Health factor after borrowing</span>
        <span className="flex items-baseline gap-2">
          {before !== undefined && (
            <span className="tabular text-xs text-ink-faint">
              {formatHealthFactor(before) ?? "—"} →
            </span>
          )}
          <span className={`tabular text-base font-medium ${tone}`}>
            {formatHealthFactor(after) ?? "—"}
          </span>
        </span>
      </div>
      <p className="text-xs text-ink-muted">
        Borrowing {formatAmount(borrowAmount, decimals, 2)} {symbol} against your stake, which
        keeps earning throughout. If the round loses, the debt stands and is settled from your
        stake.
      </p>
      {band === "danger" && (
        <p className="text-xs text-negative">
          This leaves you close to the liquidation line before the round has even started.
        </p>
      )}
    </div>
  );
}

/**
 * The claim row on a settled round.
 *
 * A win states the amount and offers the claim. A loss states the size of
 * the position and stops — no encouragement to try again, and nothing dressed up.
 */
/**
 * What a disconnected visitor gets when they reach for a side.
 *
 * Deliberately at the point of action rather than at the door. The old
 * behaviour put "Connect a wallet" in front of the whole page, so the ask came
 * before any reason to say yes; here it arrives after they have seen the pool,
 * the multiple and the countdown — with the ask itself stating the one thing
 * that makes this protocol unusual.
 */
function ConnectToTake({ onClose }: { onClose: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-raised/40 px-4 py-3">
      <p className="text-xs leading-relaxed text-ink-muted">
        Taking a side needs a wallet. Your stake keeps earning while the position is open — it
        is borrowed against, not sold.
      </p>
      <div className="flex items-center gap-2">
        <ConnectButton />
        <TextButton
          onClick={onClose}
        >
          Not now
        </TextButton>
      </div>
    </div>
  );
}

function ClaimRow({
  market,
  roundId,
  claimable,
  claimed,
  positionSize,
  decimals,
  symbol,
  address,
  onDone,
}: {
  market: Market;
  roundId: bigint;
  claimable: bigint | undefined;
  claimed: boolean | undefined;
  positionSize: bigint;
  decimals: number;
  symbol: string;
  address: `0x${string}`;
  onDone: () => void;
}) {
  const tx = useTransaction();
  const busy = tx.state.status === "signing" || tx.state.status === "pending";

  if (positionSize === 0n) return null;

  if (claimed) {
    return <p className="mt-3 text-xs text-ink-muted">Claimed.</p>;
  }

  if (claimable === undefined || claimable === 0n) {
    return (
      <p className="mt-3 text-xs text-ink-muted">
        Your position on this round was{" "}
        <span className="tabular">{formatAmount(positionSize, decimals, 2)}</span> {symbol}.
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-ink">
        <span className="tabular font-medium text-positive">
          {formatAmount(claimable, decimals, 2)} {symbol}
        </span>{" "}
        to claim. Debt is settled first; the rest reaches your wallet.
      </p>
      <div className="flex items-center gap-3">
        <TxStatus tx={tx} />
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            const ok = await tx.send({
              address: market.address,
              abi: parimutuelRoundAbi,
              functionName: "claim",
              args: [roundId, address],
            });
            if (ok) onDone();
          }}
        >
          {busy ? "Claiming…" : "Claim"}
        </Button>
      </div>
    </div>
  );
}
