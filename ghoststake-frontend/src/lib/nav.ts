/**
 * The one list of destinations, shared by the sidebar and the phone tab bar
 * (GHO-59).
 *
 * It used to live inside `Sidebar.tsx`. Two navs reading two lists is how a
 * route ends up reachable on a desktop and invisible on a phone, so the list
 * moved here the moment there was a second nav.
 *
 * Ordered as the pipeline runs. Stake → Borrow → Markets is the product in
 * three words, and the order is load-bearing: the collateral is staked first
 * and never leaves, borrowing is secured against it, and only the borrowed
 * funds reach a market. A nav that lists these as unrelated destinations
 * describes a lending app that happens to ship a prediction market.
 *
 * On vocabulary: "stake" means the savings deposit here and nowhere else.
 * A side of a market is a "position". The two are opposite ends of the
 * pipeline and the app used the same word for both, which quietly erased the
 * half the product is named after.
 *
 * Activity sits at the end of the pipeline because that is what it is: the
 * record of having been through it. Positions sits beside it, and the pair is
 * named by what each one holds rather than by how old it is — Activity is the
 * lending ledger, Positions is the market ledger.
 *
 * Lend sits under its own heading rather than as a fourth pipeline step,
 * because it is not one. A lender funds the borrow, is paid by it, and never
 * stakes or takes a view.
 *
 * Liquidate and Operator are last, separated by what they are rather than by
 * a permission check: liquidation is fully permissionless, and the contracts
 * say so louder than a hidden link would.
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
   * Shown in the phone tab bar rather than behind "More". Five is the limit:
   * past that the targets drop under 44px on a 390px screen.
   *
   * Which five is GHO-62's decision, not this issue's. The set below is the
   * pipeline's three verbs plus where your money is, which is the smallest
   * set that lets someone bet and then check on it without opening More.
   */
  tab?: boolean;
};

export type NavSection = { section: string; items: NavLink[] };

export const NAV: NavSection[] = [
  {
    section: "Overview",
    items: [{ href: "/", label: "Overview", ready: true, tab: true }],
  },
  {
    section: "Take a view",
    items: [
      { href: "/stake", label: "Stake", note: "earn", ready: true, tab: true },
      { href: "/borrow", label: "Borrow", note: "against it", ready: true },
      { href: "/markets", label: "Markets", note: "take a view", ready: true, tab: true },
      { href: "/positions", label: "Positions", note: "how they went", ready: true, tab: true },
      { href: "/activity", label: "Activity", note: "everything you did", ready: true },
    ],
  },
  {
    section: "Fund it",
    items: [{ href: "/lend", label: "Lend", note: "earn the spread", ready: true }],
  },
  {
    section: "Run it",
    items: [
      { href: "/liquidate", label: "Liquidate", note: "close bad positions", ready: true },
      { href: "/operator", label: "Operator", note: "run rounds", ready: true },
    ],
  },
];

export const NAV_LINKS: NavLink[] = NAV.flatMap((section) => section.items);

/** The four destinations in the phone tab bar, before the More tab. */
export const TAB_LINKS: NavLink[] = NAV_LINKS.filter((link) => link.tab);

/** Everything the tab bar doesn't show, grouped as the sidebar groups it. */
export const MORE_SECTIONS: NavSection[] = NAV.map((section) => ({
  ...section,
  items: section.items.filter((link) => !link.tab),
})).filter((section) => section.items.length > 0);

/**
 * Whether a nav entry is the current page.
 *
 * Prefix match for everything except Overview, whose href is `/` and would
 * otherwise be current on every page. The prefix matters for markets: a round
 * lives at `/markets/0x…/3`, and a tab bar showing nothing selected while you
 * stare at a market reads as "you are lost" rather than as "this is a
 * subpage".
 */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
