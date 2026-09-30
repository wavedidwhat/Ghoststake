import { message, type Message } from "@/i18n/message";
import { claimKey, totalClaimable, type Claimable } from "./claims";
import { healthBand, type Format } from "./format";

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
 *
 * The words are messages, not English (GHO-119): the same alert is shown in
 * the bell, as a toast and as a browser notification, and each of those
 * translates it where it renders.
 */
export type Alert = {
  id: string;
  tone: "positive" | "warning" | "negative";
  title: Message;
  body: Message;
  href: string;
  action: Message;
};

export function alertsFor(input: {
  claims: Claimable[];
  healthFactor: bigint | undefined;
  decimals: number | undefined;
  symbol: string;
  /** Figures in the reader's language (GHO-128). */
  format: Format;
}): Alert[] {
  const alerts: Alert[] = [];
  const { claims, healthFactor, decimals, symbol, format } = input;

  // Safety first: it is the one that costs money if it waits.
  if (healthFactor !== undefined) {
    const band = healthBand(healthFactor);
    const shown = format.formatHealthFactor(healthFactor);
    if ((band === "danger" || band === "caution") && shown) {
      alerts.push({
        id: `health:${band}`,
        tone: band === "danger" ? "negative" : "warning",
        title: message("alerts.health.title", { health: shown }),
        body: band === "danger" ? message("alerts.health.danger") : message("alerts.health.caution"),
        href: "/borrow",
        action: message("alerts.health.action"),
      });
    }
  }

  if (claims.length > 0 && decimals !== undefined) {
    const keys = claims.map(claimKey).sort();
    alerts.push({
      id: `claim:${keys.join(",")}`,
      tone: "positive",
      title: message("alerts.claim.title", { amount: format.formatAmount(totalClaimable(claims), decimals, 2), symbol }),
      body: message("alerts.claim.body", { count: claims.length }),
      href: "/portfolio",
      action: message("alerts.claim.action"),
    });
  }

  return alerts;
}

/** Alerts whose id has not been seen before, in the order given. */
export function unseen(alerts: Alert[], seen: ReadonlySet<string>): Alert[] {
  return alerts.filter((a) => !seen.has(a.id));
}
