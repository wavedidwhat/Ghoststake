/**
 * The Content-Security-Policy, as a pure function so its promises are tested
 * rather than trusted.
 *
 * What each directive is for, in the order an attacker would try them:
 *
 * - `frame-ancestors 'none'` — nobody may put this app in an iframe. The
 *   clickjacking drainer (our real "Approve" button under a fake one) needs a
 *   frame; this is the single most valuable line here.
 * - `script-src` with a per-request nonce and `'strict-dynamic'` — only scripts
 *   our own server rendered can run, plus what they load. An injected
 *   `<script>` has no nonce. No host allowlist: `'strict-dynamic'` ignores one.
 * - `connect-src` — where script may send data. A script that did get in still
 *   cannot post a session or an address anywhere not listed.
 * - `base-uri 'none'`, `object-src 'none'`, `form-action 'self'` — the three
 *   classic CSP bypasses, closed.
 *
 * `style-src` allows `'unsafe-inline'` on purpose: React renders `style={...}`
 * as attributes (`HealthFactor`'s marker) and WalletConnect's modal injects
 * `<style>`. Style injection cannot run code or move money; script injection
 * can, and that half stays strict.
 */

export type CspInput = {
  nonce: string;
  isDev: boolean;
  /** Our Go API. Its websocket origin is derived from it. */
  apiUrl: string;
  /** The active chain's RPC. */
  rpcUrl: string;
  walletConnect: boolean;
};

/**
 * Hosts WalletConnect needs.
 *
 * `api.web3modal.org` was observed in headless Chrome: the modal will not list
 * wallets without it. The relay and verify hosts were *not* observed, because
 * no pairing was completed in testing; they are WalletConnect's documented
 * requirements for pairing and domain verification, and removing either
 * breaks connecting a real wallet.
 *
 * Deliberately absent, and observed being blocked with the modal still
 * working: `pulse.walletconnect.org` (its analytics, sent on every page load)
 * and `fonts.reown.com` (the modal falls back to our font stack; a font CDN is
 * one more party that sees every visitor).
 */
/**
 * Hosts the Coinbase Wallet SDK needs.
 *
 * Unconditional, unlike the WalletConnect block: `wagmi.ts` registers
 * `coinbaseWallet()` on every build, with no env flag to turn it off, so the
 * connector is always offered and these are always needed. Leaving them out is
 * what GHO-77 was — picking Coinbase blocked the relay socket, and the SDK's
 * `Communicator.onMessage` has no timeout, so the connect never resolved and
 * the button sat on "Connecting…" for good.
 *
 * - `www.walletlink.org` over both schemes — the relay. `WalletLinkConnection`
 *   opens `${linkAPIUrl}/rpc` as a websocket (the SDK rewrites `http` to `ws`
 *   itself) and `WalletLinkHTTP` fetches `${linkAPIUrl}/events` beside it, so
 *   the `https:` and `wss:` forms are both load-bearing.
 * - `rpc.wallet.coinbase.com` — `fetchRPCRequest`, for `wallet_getCallsStatus`.
 *
 * Deliberately absent: `keys.coinbase.com`. The signer-selection step opens it
 * with `window.open`, and a popup is its own document — `connect-src` does not
 * govern one, so listing it would only widen what our page may talk to.
 */
const COINBASE = {
  connect: [
    "https://www.walletlink.org",
    "wss://www.walletlink.org",
    "https://rpc.wallet.coinbase.com",
  ],
};

const WALLETCONNECT = {
  connect: [
    "https://api.web3modal.org",
    "wss://relay.walletconnect.org",
    "wss://relay.walletconnect.com",
    "https://verify.walletconnect.org",
    "https://verify.walletconnect.com",
  ],
  img: ["https://api.web3modal.org"],
  frame: ["https://verify.walletconnect.org", "https://verify.walletconnect.com"],
};

export function buildCsp(input: CspInput): string {
  const api = new URL(input.apiUrl);
  const apiSocket = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
  const rpc = new URL(input.rpcUrl).origin;

  const connect = ["'self'", api.origin, apiSocket, rpc, ...COINBASE.connect];
  const img = ["'self'", "data:", "blob:"];
  const frame: string[] = [];
  if (input.walletConnect) {
    connect.push(...WALLETCONNECT.connect);
    img.push(...WALLETCONNECT.img);
    frame.push(...WALLETCONNECT.frame);
  }

  // Upgrading only makes sense when everything we talk to is already HTTPS.
  // Against the local stack (http://localhost:8080, anvil on :8545) it would
  // rewrite every request to a port that does not speak TLS.
  const allHttps = api.protocol === "https:" && new URL(input.rpcUrl).protocol === "https:";

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      [
        "'self'",
        `'nonce-${input.nonce}'`,
        "'strict-dynamic'",
        // React reconstructs server error stacks with eval in development only.
        ...(input.isDev ? ["'unsafe-eval'"] : []),
      ],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", img],
    ["font-src", ["'self'"]],
    ["connect-src", unique(connect)],
    ["frame-src", frame.length > 0 ? frame : ["'none'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];

  const policy = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (allHttps) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/** Headers with nothing per-request in them, set on every response from `next.config.ts`. */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  // Two years, subdomains, preload-eligible. Only honoured over HTTPS, so
  // harmless on a local http server.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // For browsers too old to read `frame-ancestors`.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Addresses live in our URLs (/markets/0x…). Other sites get our origin only.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
