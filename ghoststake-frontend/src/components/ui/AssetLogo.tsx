import { faAmazon } from "@fortawesome/free-brands-svg-icons";
import TokenARB from "@web3icons/react/icons/tokens/TokenARB";
import TokenAVAX from "@web3icons/react/icons/tokens/TokenAVAX";
import TokenBNB from "@web3icons/react/icons/tokens/TokenBNB";
import TokenBTC from "@web3icons/react/icons/tokens/TokenBTC";
import TokenDAI from "@web3icons/react/icons/tokens/TokenDAI";
import TokenDOGE from "@web3icons/react/icons/tokens/TokenDOGE";
import TokenETH from "@web3icons/react/icons/tokens/TokenETH";
import TokenLINK from "@web3icons/react/icons/tokens/TokenLINK";
import TokenMATIC from "@web3icons/react/icons/tokens/TokenMATIC";
import TokenOP from "@web3icons/react/icons/tokens/TokenOP";
import TokenPOL from "@web3icons/react/icons/tokens/TokenPOL";
import TokenSOL from "@web3icons/react/icons/tokens/TokenSOL";
import TokenUSDC from "@web3icons/react/icons/tokens/TokenUSDC";
import TokenUSDT from "@web3icons/react/icons/tokens/TokenUSDT";
import TokenWBTC from "@web3icons/react/icons/tokens/TokenWBTC";
import TokenXRP from "@web3icons/react/icons/tokens/TokenXRP";
import { siAmd, siNetflix, siPalantir, siTesla } from "simple-icons";

/**
 * A company or token logo, by ticker (GHO-97).
 *
 * The app drew its own glyphs and had no icon library (GHO-58). Stock loans
 * changed that: a list of collateral is read by recognising the companies,
 * and a ticker in a box is a worse answer to "which one is Tesla" than
 * Tesla's mark. Three libraries, because no one of them covers the set:
 *
 * - `simple-icons` (CC0): Tesla, AMD, Palantir, Netflix.
 * - `@fortawesome/free-brands-svg-icons` (CC BY 4.0): Amazon. Amazon had its
 *   mark removed from Simple Icons and it is absent from the `logos` set too;
 *   Font Awesome's brand set is the open source that carries it.
 * - `@web3icons/react` (MIT): USDC and ETH, and since GHO-102 the rest of
 *   the crypto bases `lib/marketCategory.ts` recognises (a test holds the
 *   two lists together).
 *
 * All static SVG shipped in the bundle; nothing is fetched at runtime.
 *
 * A symbol with no entry gets its ticker, never a guess. Matching is on the
 * exact symbol the token reports, so a lookalike called "TSLA Test Stock" with
 * symbol TSLA would get Tesla's mark — the logo says which company a token
 * claims to be, not that the token is genuine. The address is what says that.
 *
 * `mUSDC` is our own mintable mock and shows the USDC mark, because it stands
 * in for USDC; the symbol printed next to it still says `mUSDC`.
 */
type Glyph = { viewBox: string; paths: string[]; color: string };

const GLYPHS: Record<string, Glyph> = {
  TSLA: fromSimpleIcon(siTesla),
  AMD: fromSimpleIcon(siAmd),
  PLTR: fromSimpleIcon(siPalantir),
  NFLX: fromSimpleIcon(siNetflix),
  AMZN: {
    viewBox: `0 0 ${faAmazon.icon[0]} ${faAmazon.icon[1]}`,
    paths: ([] as string[]).concat(faAmazon.icon[4]),
    // Amazon's orange. Font Awesome ships shapes, not colours, and a literal
    // hex here would be the palette drift design.test.ts exists to stop.
    color: "var(--color-logo-amazon)",
  },
};

const TOKENS: Record<string, typeof TokenUSDC> = {
  USDC: TokenUSDC,
  MUSDC: TokenUSDC,
  ETH: TokenETH,
  WETH: TokenETH,
  BTC: TokenBTC,
  WBTC: TokenWBTC,
  SOL: TokenSOL,
  LINK: TokenLINK,
  ARB: TokenARB,
  OP: TokenOP,
  USDT: TokenUSDT,
  DAI: TokenDAI,
  AVAX: TokenAVAX,
  BNB: TokenBNB,
  DOGE: TokenDOGE,
  XRP: TokenXRP,
  POL: TokenPOL,
  MATIC: TokenMATIC,
};

function fromSimpleIcon(icon: { path: string; hex: string }): Glyph {
  return { viewBox: "0 0 24 24", paths: [icon.path], color: `#${icon.hex}` };
}

/** Whether a real logo exists for this symbol. Exported for tests. */
export function hasLogo(symbol: string): boolean {
  const key = symbol.toUpperCase();
  return key in GLYPHS || key in TOKENS;
}

// `xs` sits inline beside a unit ("1,000.00 ◉ mUSDC", GHO-102). The white
// tile's padding scales with it: 6px of padding on a 16px tile would leave a
// 4px mark nobody can recognise.
const SIZES = { xs: "size-4", sm: "size-6", md: "size-8", lg: "size-10" } as const;
const TILE_PAD = { xs: "p-0.5", sm: "p-1", md: "p-1.5", lg: "p-1.5" } as const;

export function AssetLogo({
  symbol,
  size = "md",
}: {
  symbol: string;
  size?: keyof typeof SIZES;
}) {
  const key = symbol.toUpperCase();
  const box = SIZES[size];

  const Token = TOKENS[key];
  if (Token) {
    return <Token variant="branded" className={`${box} shrink-0`} aria-hidden="true" />;
  }

  const glyph = GLYPHS[key];
  if (glyph) {
    // On a light tile in both themes: several brand colours (Palantir's is
    // near-black) vanish on the dark ground otherwise, and recolouring a
    // trademark to suit the theme is not ours to do.
    return (
      <span
        className={`${box} inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-white ${TILE_PAD[size]}`}
        aria-hidden="true"
      >
        <svg viewBox={glyph.viewBox} fill={glyph.color} className="size-full">
          {glyph.paths.map((d) => (
            <path key={d.slice(0, 16)} d={d} />
          ))}
        </svg>
      </span>
    );
  }

  return (
    <span
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-raised text-[0.6rem] font-semibold tracking-tight text-ink-muted`}
      aria-hidden="true"
    >
      {symbol.slice(0, 4).toUpperCase()}
    </span>
  );
}
