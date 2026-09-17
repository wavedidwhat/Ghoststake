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

The palette is Sanzo Wada's combination **332** from *A Dictionary of Color
Combinations* (1933): Scarlet, Coral Red, Deep Slate Olive, Dusky Green. The
tokens live in `src/app/globals.css` and nowhere else — **no component hardcodes
a hex value.**

| Token | Value | Meaning |
|---|---|---|
| `ground` / `surface` / `raised` | `#1d2719` / `#253122` / `#2e3b29` | slate-olive grounds, darkest first |
| `brand` | `#cb2f43` | Scarlet. Wordmark, phase chips, "you're in". |
| `action` | `#96d1aa` | buttons that are not a market side: stake, borrow, repay, supply |
| `up` / `down` | `#96d1aa` / `#f58e84` | the two sides of a market |
| `positive` / `negative` | same pair | P/L and deltas, so a won round and a positive balance agree |
| `warning` | `#e2b540` | Yellow Ocher. Thin sides, stale feeds, health. |
| `focus` | `#e2b540` | focus rings, which must never be mistaken for a side |
| `ink` / `ink-muted` / `ink-faint` | `#f1eadb` / `#b3b8a4` / `#8b9182` | `faint` is for units and decimal tails, not content |

Three rules that are not obvious:

1. **Red is the brand and never fills a button.** A red button on a betting
   screen reads as "you lost". The button that spends money takes the colour
   of the side being taken, or `action`.
2. **Green is not the brand.** Green is the loud colour on every sportsbook,
   and if the brand were green then "Take Up" and "Up is winning" would look
   like the same statement. Wada pairs red with greens that are nearly grey,
   which is also what stops red-and-green reading as Christmas.
3. **Colour is never the only signal.** Up and Down always carry an arrow
   (`src/components/icons.tsx`) and the word. The two colours also differ in
   lightness, so the pair survives greyscale and colour blindness.

## Shape

- `rounded-card` is `0.25rem`. Near-square: a printed slip has corners.
- Radius is `rounded-sm` or nothing. `rounded-full` is for dots and meter
  bars only, never a pill button.
- **Not every surface is a bordered card.** Vary density: a rule and plain
  type beat a card, and tables are allowed.
- No shadows, no blur, no glassmorphism, no gradient fills.

## Icons

Our own glyphs, in `src/components/icons.tsx`. There is no icon library
dependency: the app needs two triangles, and an icon set in the signing path
is a supply-chain decision (GHO-68), not a styling one. If a real set becomes
necessary, use one human-drawn family (Phosphor) and add it deliberately.

Token and chain logos come from the issuer's official brand kit. Never
redraw them, and never use an AI-generated illustration or avatar.

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
