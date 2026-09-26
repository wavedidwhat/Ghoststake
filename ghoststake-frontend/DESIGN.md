# GhostStake design rules

Written for whoever (or whatever) writes the next PR against this frontend.
Decided in GHO-58; the reasoning is in ADR 0052 and runbook Part 7.64. If a
change here breaks one of these rules, the rule is what's wrong — say so and
change it deliberately, rather than working around it in one component.

## Who this is for

A degen on a phone, usually arriving from a link someone shared, often inside
a wallet's in-app browser. They know Up, Down, a multiplier, a countdown and a
wallet. They do not know "lien", "LTV ceiling" or "observation phase" (GHO-57).

Design for 390px first.

## Type

Three faces, each with exactly one job. All three are from
[Fontshare](https://www.fontshare.com) and self-hosted via `next/font/local`.

| Role | Face | Used for | Never |
|---|---|---|---|
| `font-display` (or the `.display` class) | **Nippo** | the wordmark, market names, side labels (Up / Down), buttons that commit money | body text, anything over a few words |
| `font-sans` (the default) | **Technor** | everything that gets read: explanations, labels, warnings, terms | figures |
| `font-mono` | **Tabular** | every figure, countdown, multiple, address, hash | prose |

Nippo was drawn from sports-jersey lettering. Technor is a squared technical
sans. Tabular is a monospace built for financial tables: each digit has the
same advance width, so a number that updates in place does not reflow the
layout around it. Pair any figure with the `tabular` class, which also turns
on `slashed-zero` so 0 can't be read as O.

**Banned:** Inter, Geist, Space Grotesk, Satoshi. Each is instantly
recognisable as a default, and Geist is what this app shipped with.

### Licence, which constrains what you may do to the files

The three faces are under the **ITF Free Font License 2.0**
(`src/fonts/ITF-FFL-LICENSE.txt`). Commercial use and self-hosting are
explicitly allowed. Three things are not:

- **No subsetting, format conversion or any modification** of the files. Don't
  run them through a subsetter, don't convert woff2 → woff, don't rename the
  families. (`Nippo-Bold.woff` is not a conversion; the foundry ships it, and
  `opengraph-image.tsx` needs it because Satori cannot read woff2.)
- **No redistribution**, which includes a publicly readable git repository.
  This repo is private. If it is ever made public, the font files have to come
  out of it first and be fetched at build time instead.
- **Don't offer the fonts to third parties** to design with.

## Colour

Near-black ground; the only saturated colour on a screen belongs to a
decision. The tokens live in `src/app/globals.css` and nowhere else — **no
component hardcodes a hex value.**

| Token | Value | Meaning |
|---|---|---|
| `ground` / `surface` / `raised` | `#0d0f0e` / `#161a18` / `#1f2522` | grounds, darkest first |
| `brand` | `#e8394f` | wordmark, live countdown, phase chip. Never a button. |
| `brand-ink` | `#ffffff` | text on a brand-filled chip |
| `action` | `#2fd07a` | buttons that are not a market side: stake, borrow, repay, supply |
| `up` / `down` | `#2fd07a` / `#ff5470` | the two sides of a market |
| `up-ink` / `down-ink` | `#04140b` / `#1e0409` | text on a filled side |
| `up-edge` / `down-edge` | `#1c9c59` / `#c93a52` | the solid edge under a pressable button |
| `positive` / `negative` | same pair as the sides | P/L and deltas, so a won round and a positive balance agree |
| `warning` | `#ffc233` | thin sides, stale feeds, health |
| `focus` | `#ffc233` | focus rings, which must never be mistaken for a side |
| `ink` / `ink-muted` / `ink-faint` | `#f2f4f2` / `#a0aaa5` / `#6f7a75` | `faint` is for units and decimal tails, not content |

**What this replaced, and why.** GHO-58 shipped Sanzo Wada's plate 332 — a
slate-olive ground with a sage/salmon pair. It was defensible on paper and
wrong on a phone: the ground and both side colours sat within a few points of
the same lightness, so nothing separated from anything and the screen read as
one soft murk. Dropping the ground to near-black and saturating the pair fixed
it without changing a single rule below.

Three rules that are not obvious:

1. **Red is the brand and never fills a button.** A red button on a betting
   screen reads as "you lost". The button that spends money takes the colour
   of the side being taken, or `action`.
2. **Green is not the brand.** Green is the loud colour on every sportsbook,
   and if the brand were green then "Take Up" and "Up is winning" would look
   like the same statement. Red and green avoid reading as Christmas because
   neither one is ever the ground: they sit on near-black, far apart in
   lightness, and never touch each other.
3. **Colour is never the only signal.** Up and Down always carry an arrow
   (`src/components/icons.tsx`) and the word. The two colours also differ in
   lightness, so the pair survives greyscale and colour blindness.

## Shape

- `rounded-card` (`1.125rem`) for a card; `rounded-control` (`0.875rem`) for
  something you press. Nothing else gets a radius by default.
- **Not every surface is a bordered card.** Vary density: a rule and plain
  type beat a card, and tables are allowed.
- **No gradients, no blur, no glassmorphism, no glow.** Every surface is one
  flat colour.
- The **only** depth in the design is `.pressable`: a 4px solid edge under a
  button, which moves down 3px when pressed. It is a hard offset, not a
  blurred shadow, and it exists on things you press and nowhere else.

GHO-58 set the radius near-square, arguing that a printed slip has corners.
The layout that followed (GHO-59) is built on big pressable blocks, and a
near-square block does not read as pressable at that size. The AI tell was
never the radius on its own — it was one radius and one blurred shadow
stamped on every surface.

## Layout

The phone screen is the design; the desktop is the same components with more
room. Market screens follow one shape:

0. **A market is a question, answered Yes or No** (GHO-78). "ETH above $2,690
   at 14:30", not "ETH / USD" with an arrow. Up and Down stay in the
   contracts, where they are the enum the pools are keyed by; nothing above
   `lib/question.ts` uses those words. A market with no strike yet asks the
   weaker question honestly — "ETH higher at 14:30" — rather than inventing a
   level.
1. **The belief leads, the bar illustrates it, the multiple follows.**
   `63% say yes` is the hero figure, with a slim bar beside it and
   `pays 1.55×` on the button. ~~The odds bar is the card: where the split
   sits *is* the information, and it reads before any figure.~~ That was
   right when a side was a direction, and it is what shipped in GHO-58 — but
   the split and the payout are one fact seen from two ends, and stating both
   is the cheapest honest explanation of parimutuel this app can give. An
   empty round still draws no bar: a half-and-half bar would invent a crowd.
2. **Each side is a button**, with what it pays *and what the crowd thinks*
   on the button rather than beside it. Tinted, not filled — eight saturated
   slabs a screen fight the figures that matter, and a filled 7% Yes reads
   heavier than the 93% No next to it. A side you already hold fills, because
   then the colour reports a fact about you rather than competing for a
   decision.
3. **The countdown fills with the brand colour only inside the entry cutoff**,
   because that is the one moment the urgency is real.
4. **The loss is stated at the same size as the win.** Losses weigh about
   twice what gains do, so hiding the downside is both dishonest and less
   convincing.
5. **One decision per sheet**, with the consequence (a safety factor moving,
   for instance) shown before the wallet opens.

## Icons

Our own glyphs, in `src/components/ui/icons.tsx`, for our own concepts (the
Up and Down arrows). ~~Still no general icon set: an icon set in the signing
path is a supply-chain decision (GHO-68), not a styling one. If one becomes
necessary, use one human-drawn family (Phosphor) and add it deliberately.~~

**Phosphor, for navigation (GHO-100).** The navs became icon + label, as on
Myriad and Limitless. Nine destinations is past what we should hand-draw, so
this is the moment the rule above anticipated. `@phosphor-icons/react`,
pinned exact (2.1.10: MIT, zero dependencies). Every use goes through
`src/components/NavIcon.tsx`, keyed by route. `regular` weight normally and
`fill` for the current page, so the current page reads without colour. Don't
import Phosphor anywhere else without adding the use here first, and never
mix in a second icon family.

### Logos (GHO-97)

~~Token and chain logos come from the issuer's official brand kit.~~ Company
and token logos come from three open libraries, through one component,
`src/components/AssetLogo.tsx`. That was the user's call once stock loans made
the app a list of companies, and a list of companies is read by recognising
their marks:

| Library | Licence | Covers |
|---|---|---|
| `simple-icons` | CC0 | Tesla, AMD, Palantir, Netflix |
| `@fortawesome/free-brands-svg-icons` | CC BY 4.0 | Amazon (absent from Simple Icons and `logos` at Amazon's request) |
| `@web3icons/react` | MIT | USDC, ETH |

These are faithful community reproductions of the marks, not the issuers' own
brand kits. The rules:

- **Never redraw a logo**, never recolour one to suit the theme, never use an
  AI-generated one. A mark goes on a white disc in every theme, because some
  brand colours (Palantir's is near-black) vanish on our ground.
- **Static SVG in the bundle only.** No logo CDN, no runtime fetch.
- **A symbol with no entry gets its ticker**, in a plain circle. That is a
  label, not a logo, so it does not fall under the slop list's "letter in a
  rounded square". Never substitute a similar company's mark.
- Matching is by the token's reported symbol, so the logo says which company
  a token *claims* to be. The address is what says it is genuine.
- A brand colour that is not carried as data (Amazon's orange) is a
  `--color-logo-*` token in `globals.css`, used nowhere but `AssetLogo`.

## Components

**The frame** (sidebar, phone tab bar, network banner) is
`src/app/(app)/layout.tsx`, mounted once and kept across navigations. A
screen renders `<Page title subtitle>` for its header and body, and never
the frame itself. The sidebar is pinned to the window and the document
scrolls past it. Don't make `<main>` the scroller: that loses the phone's
collapsing address bar, pull-to-refresh and back/forward scroll restoration.

The sidebar is **icon + label and nothing else** (GHO-100): no notes beside
items, no section headings, no tagline. It has to fit a 1366×650 window
without scrolling, and a browser test holds it to that. A tenth destination
is a reason to move something behind the phone's More sheet and the
sidebar's bottom group, not a reason to let the sidebar scroll.

`src/components/ui/` holds the primitives (GHO-96). They take props and
render; none of them reads wagmi, a hook with data, or the network. Feature
components (`MarketBlock`, `FeesPanel`, `ConnectButton`) and screens build on
them.

| Primitive | Use it for |
|---|---|
| `Button` / `buttonClass` | every button that is not a market side. `action` (green, default), `outline`, `warning` (amber, for fix-it steps like switching network). Sizes `sm`, `md`, `lg` (44px). `buttonClass()` styles a `<Link>` the same way. |
| `TextButton` | a small underlined action inside copy: "stop waiting", "change" |
| `SegmentedControl` | the modes of one form: Supply / Withdraw |
| `Eyebrow` | the small uppercase label. Pass `as` so it stays the right element: `h2` for a section, `label` for a field, `dt` in a list |
| `Card`, `Stat` | a bordered surface, and a label over a figure |
| `Figure` | every number |
| `Skeleton` | a placeholder the size of what is loading |
| `Badge` | a short warning chip, e.g. "Demo feed" |
| `LoadFailed` | a read that failed: what couldn't be read, what is unaffected, Try again |
| `RowList` / `RowCard` / `RowField` | a table's phone form |
| `Sheet` | the one decision a screen asks for |
| `Notice` | a screen that stands in for the app: crash, 404, misconfigured |
| `icons` | our glyphs |

`src/lib/__tests__/design.test.ts` fails the build when a screen writes an
action button, an uppercase label or a loading pulse by hand, or adds a raw
`<button>` outside the short list of deliberate exceptions (the market sides,
the tab bar, the wallet menu). If yours really is different, add it to that
list with the reason. It then shows up in review as a decision rather than
slipping through as a copy.

`className` on a primitive is for layout (margin, width, alignment). There is
no class merger, so a colour or padding passed in may or may not beat the
primitive's own. If you need a new look, add a variant.

## The AI-slop list (from GHO-57)

Don't ship any of these, even if a component library hands them over for free:
purple or indigo gradients, glassmorphism, glowing or animated borders,
shimmer, spotlight-follows-cursor, aurora backgrounds, gradient text, sparkle
or magic-wand icons, emoji in the UI, a letter in a rounded square as a logo,
or a centred hero with three feature cards under it.

## What is still a placeholder

The wordmark is **Nippo set in caps** and is meant to look like exactly that
until Enoch's logo lands. The app icon is our Up/Down glyph. Neither is a
finished mark. When the real one arrives, replace:

- `src/app/icon.svg` (favicon)
- `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`
- the wordmark in `src/components/Sidebar.tsx`
- the mark and wordmark in `src/app/opengraph-image.tsx`
