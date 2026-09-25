/**
 * The one list of destinations, shared by the sidebar and the phone tab bar
 * (GHO-59), ordered for the person who came to bet (GHO-62).
 *
 * It used to live inside `Sidebar.tsx`. Two navs reading two lists is how a
 * route ends up reachable on a desktop and invisible on a phone, so the list
 * moved here the moment there was a second nav.
 *
 * ## Why this order
 *
 * The old one followed the pipeline — Overview, Stake, Borrow, Markets,
 * Positions, Activity, Lend, Liquidate, Operator. That order is the right
 * explanation of the protocol and the wrong front door for a visitor: it led
 * with a lending dashboard nobody disconnected could read, put Markets fourth,
 * and listed Operator and Liquidate beside it for everyone.
 *
 * What the pipeline argument got right is kept: staking and borrowing are one
 * subject, and they sit together under "Your money". What it got wrong was
 * treating the order of the *mechanism* as the order of the *screens*.
 *
 * - **Markets** is home. It is the product, and it is readable with no wallet.
 * - **Portfolio** is what you have riding: stake, borrow, health, positions.
 * - **Stake** and **Borrow** are the money behind the bets.
 * - **Lend** is the other side of the market, for people who never bet.
 * - **Liquidate** and **Operator** are running the thing, not using it.
 *
 * Nothing was removed: everything outside the four tabs is one tap away
 * behind More, and every route stays reachable by URL.
 */

export type NavLink = {
  href: string;
  label: string;
  /** The sidebar's second column: what you do there, in two or three words. */
  note?: string;
  /**
   * False for a route that isn't built yet: renders as dead text rather than
   * a live link to a 404. Nothing is unbuilt right now (GHO-49 took the last
   * one), but the next scaffolded page will want it.
   */
  ready?: boolean;
  /**
   * What the phone tab bar calls this, when the sidebar's word is too long
   * for a fifth of a 390px screen. "Positions" truncated to "POSITIO…", which
   * looks broken and reads worse than a shorter word chosen on purpose.
   */
  short?: string;
  /**
   * Shown in the phone tab bar rather than behind "More". Four, plus More:
   * 390 ÷ 5 = 78px per target, comfortably over the 44px minimum, while all
   * nine destinations would be 43px each before a label is drawn.
   */
  tab?: boolean;
  /**
   * Hidden from both navs unless the connected wallet owns a market (GHO-62).
   *
   * Hidden, not blocked. Half of what the operator console does is
   * permissionless and the page says so itself (GHO-28), so the route stays
   * reachable by URL for anyone who wants to read it — what does not belong
   * is an admin console sitting in a bettor's navigation.
   */
  operatorOnly?: boolean;
};

export type NavSection = { section: string; items: NavLink[] };

export const NAV: NavSection[] = [
  {
    section: "Bet",
    items: [
      { href: "/", label: "Markets", note: "live rounds", ready: true, tab: true },
      {
        href: "/portfolio",
        label: "Portfolio",
        short: "Bets",
        note: "what you have riding",
        ready: true,
        tab: true,
      },
    ],
  },
  {
    section: "Your money",
    items: [
      { href: "/stake", label: "Stake", note: "earns while it sits", ready: true, tab: true },
      { href: "/borrow", label: "Borrow", note: "against your stake", ready: true },
      { href: "/stocks", label: "Stock loans", note: "against shares", ready: true },
      { href: "/activity", label: "Activity", note: "the raw ledger", ready: true },
    ],
  },
  {
    section: "Fund it",
    items: [{ href: "/lend", label: "Lend", note: "earn the spread", ready: true, tab: true }],
  },
  {
    section: "Run it",
    items: [
      { href: "/liquidate", label: "Liquidate", note: "close bad positions", ready: true },
      {
        href: "/operator",
        label: "Operator",
        note: "run rounds",
        ready: true,
        operatorOnly: true,
      },
    ],
  },
  {
    section: "Learn",
    items: [{ href: "/how-it-works", label: "How it works", note: "the pipeline", ready: true }],
  },
];

export const NAV_LINKS: NavLink[] = NAV.flatMap((section) => section.items);

/** The four destinations in the phone tab bar, before the More tab. */
export const TAB_LINKS: NavLink[] = NAV_LINKS.filter((link) => link.tab);

/**
 * Everything the tab bar doesn't show, grouped as the sidebar groups it.
 *
 * `isOperator` decides whether the operator console is listed. It is false
 * for every visitor, including while the owner check is still loading: a
 * console that appears a second after the page settles is worse than one that
 * appears on the next navigation.
 */
export function moreSections(isOperator: boolean): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((link) => !link.tab && visible(link, isOperator)),
  })).filter((section) => section.items.length > 0);
}

/** The sidebar's sections, with the same visibility rule applied. */
export function sidebarSections(isOperator: boolean): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((link) => visible(link, isOperator)),
  })).filter((section) => section.items.length > 0);
}

function visible(link: NavLink, isOperator: boolean): boolean {
  return !link.operatorOnly || isOperator;
}

/**
 * Whether a nav entry is the current page.
 *
 * Prefix match for everything except Markets, whose href is `/` and would
 * otherwise be current on every page. The prefix matters for markets: a round
 * lives at `/markets/0x…/3`, and a tab bar showing nothing selected while you
 * stare at a market reads as "you are lost" rather than as "this is a
 * subpage".
 */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/markets");
  return pathname === href || pathname.startsWith(`${href}/`);
}
