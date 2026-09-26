import {
  Bank,
  Briefcase,
  Buildings,
  ChartLineUp,
  DotsThree,
  Gavel,
  HandCoins,
  Question,
  Receipt,
  SlidersHorizontal,
  Vault,
  type Icon,
} from "@phosphor-icons/react";

/**
 * One icon per destination, shared by the sidebar and the phone tab bar
 * (GHO-100).
 *
 * Phosphor, pinned exact, because DESIGN.md already named it as the one
 * family to reach for when our own glyphs stopped being enough — and a nav
 * of nine items read by icon and label is that point. Our own glyphs in
 * `ui/icons.tsx` stay for our own concepts (the Yes/No arrows).
 *
 * Keyed by route here, not stored on the nav data, so `lib/nav.ts` stays
 * plain data that a test can import without React.
 */
const ICONS: Record<string, Icon> = {
  "/": ChartLineUp,
  "/portfolio": Briefcase,
  "/stake": Vault,
  "/borrow": HandCoins,
  "/stocks": Buildings,
  "/activity": Receipt,
  "/lend": Bank,
  "/liquidate": Gavel,
  "/operator": SlidersHorizontal,
  "/how-it-works": Question,
  more: DotsThree,
};

export function NavIcon({
  href,
  current,
  className = "",
}: {
  href: string;
  current: boolean;
  className?: string;
}) {
  const Glyph = ICONS[href];
  if (!Glyph) return null;
  // The current item's icon fills in. That, plus the panel behind it, marks
  // the page without leaning on colour alone.
  return <Glyph aria-hidden="true" weight={current ? "fill" : "regular"} className={className} />;
}
