import { claimKey, totalClaimable, type Claimable } from "./claims";
import { formatAmount, formatHealthFactor, healthBand } from "./format";

/**
 * What needs someone's attention right now (GHO-104, the in-app half of
 * GHO-71).
 *
 * Derived from state, not collected from events: winnings waiting to be
 * claimed, and a safety factor in the caution or danger band. So the bell
 * can never disagree with the pages it links to, because it reads the same
 * figures they do.
 *
 * Each alert has an `id` that changes when the situation meaningfully
 * changes. That is what decides whether to toast: a new id is news, and
 * the same id seen again is not. Winnings are keyed by the exact set of
 * rounds, so a newly settled round is news even with others already
 * waiting. Safety is keyed by band, so dropping from caution to danger is
 * news, while drifting inside a band is not.
 */
export type Alert = {
  id: string;
  tone: "positive" | "warning" | "negative";
  title: string;
  body: string;
  href: string;
  action: string;
};

export function alertsFor(input: {
  claims: Claimable[];
  healthFactor: bigint | undefined;
  decimals: number | undefined;
  symbol: string;
}): Alert[] {
  const alerts: Alert[] = [];
  const { claims, healthFactor, decimals, symbol } = input;

  // Safety first: it is the one that costs money if it waits.
  if (healthFactor !== undefined) {
    const band = healthBand(healthFactor);
    const shown = formatHealthFactor(healthFactor);
    if ((band === "danger" || band === "caution") && shown) {
      alerts.push({
        id: `health:${band}`,
        tone: band === "danger" ? "negative" : "warning",
        title: `Safety ${shown}`,
        body:
          band === "danger"
            ? "Close to 1.00, where anyone may liquidate you. Add stake or repay now."
            : "Below 1.5. Interest alone moves it down, so add stake or repay while it is cheap to.",
        href: "/borrow",
        action: "Add stake or repay",
      });
    }
  }

  if (claims.length > 0 && decimals !== undefined) {
    const keys = claims.map(claimKey).sort();
    const rounds = claims.length === 1 ? "a round" : `${claims.length} rounds`;
    alerts.push({
      id: `claim:${keys.join(",")}`,
      tone: "positive",
      title: `${formatAmount(totalClaimable(claims), decimals, 2)} ${symbol} to claim`,
      body: `You won ${rounds}. It stays yours until you collect it.`,
      href: "/portfolio",
      action: "Claim",
    });
  }

  return alerts;
}

/** Alerts whose id has not been seen before, in the order given. */
export function unseen(alerts: Alert[], seen: ReadonlySet<string>): Alert[] {
  return alerts.filter((a) => !seen.has(a.id));
}
