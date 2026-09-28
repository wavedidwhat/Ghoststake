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

/**
 * Which entry this is, and so where its words live: `nav.links.<id>` in
 * `messages/en.json` (GHO-117). Ids rather than labels, because the label is
 * copy and belongs in the catalog.
 */
export type NavId =
  | "markets"
  | "portfolio"
  | "stake"
  | "borrow"
  | "stocks"
  | "activity"
  | "lend"
  | "liquidate"
  | "operator"
  | "howItWorks";

/** The phone tab bar's four, which have their own, shorter words. */
export type TabId = "markets" | "portfolio" | "stake" | "lend";

export type NavLink = {
  href: string;
  id: NavId;
  /**
   * Held at the bottom of the sidebar rather than in the list: the way in for
   * someone new, not a place anyone works (GHO-100).
   *
   * There used to be a `note` here too, a second column of two or three
   * words beside every item ("what you have riding"). None of Polymarket,
   * Kalshi, Limitless or Myriad puts a description beside a nav item. On a
   * laptop the notes collided with longer labels and wrapped, and they made
   * the nav tall enough to scroll.
   */
  pinned?: boolean;
  /**
   * False for a route that isn't built yet: renders as dead text rather than
   * a live link to a 404. Nothing is unbuilt right now (GHO-49 took the last
   * one), but the next scaffolded page will want it.
   */
  ready?: boolean;
  /**
   * Shown in the phone tab bar rather than behind "More". Four, plus More:
   * 390 ÷ 5 = 78px per target, comfortably over the 44px minimum, while all
   * nine destinations would be 43px each before a label is drawn.
   *
   * The tab bar reads its words from `nav.tabs.<id>`, not `nav.links.<id>`:
   * the sidebar's word can be too long for a fifth of a 390px screen.
   * "Positions" truncated to "POSITIO…", which looks broken and reads worse
   * than a shorter word chosen on purpose. A slot with a width limit is a
   * different string from the same idea with room to spare, which is also
   * what a translator needs to be told.
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

/** A heading in the phone's More sheet; its words are `nav.sections.<id>`. */
export type SectionId = "bet" | "yourMoney" | "fundIt" | "runIt" | "learn";

export type NavSection = { section: SectionId; items: NavLink[] };

export const NAV: NavSection[] = [
  {
    section: "bet",
    items: [
      { href: "/", id: "markets", ready: true, tab: true },
      { href: "/portfolio", id: "portfolio", ready: true, tab: true },
    ],
  },
  {
    section: "yourMoney",
    items: [
      { href: "/stake", id: "stake", ready: true, tab: true },
      { href: "/borrow", id: "borrow", ready: true },
      { href: "/stocks", id: "stocks", ready: true },
      { href: "/activity", id: "activity", ready: true },
    ],
  },
  {
    section: "fundIt",
    items: [{ href: "/lend", id: "lend", ready: true, tab: true }],
  },
  {
    section: "runIt",
    items: [
      { href: "/liquidate", id: "liquidate", ready: true },
      { href: "/operator", id: "operator", ready: true, operatorOnly: true },
    ],
  },
  {
    section: "learn",
    items: [{ href: "/how-it-works", id: "howItWorks", ready: true, pinned: true }],
  },
];

export const NAV_LINKS: NavLink[] = NAV.flatMap((section) => section.items);

/** The four destinations in the phone tab bar, before the More tab. */
export const TAB_LINKS = NAV_LINKS.filter((link): link is NavLink & { id: TabId } => Boolean(link.tab));

/**
 * Everything the tab bar doesn't show, under its section heading.
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

/**
 * The sidebar: one flat list, plus the pinned links at the bottom (GHO-100).
 *
 * Flat because the section headings ("Your money", "Run it") were a second
 * layer of text on a nav of nine items, and a nav of nine items is read by
 * its icons and labels alone. The phone's More sheet keeps them, because a
 * sheet is read top to bottom, like a menu.
 */
export function sidebarLinks(isOperator: boolean): { main: NavLink[]; pinned: NavLink[] } {
  const links = NAV_LINKS.filter((link) => visible(link, isOperator));
  return {
    main: links.filter((link) => !link.pinned),
    pinned: links.filter((link) => link.pinned),
  };
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
