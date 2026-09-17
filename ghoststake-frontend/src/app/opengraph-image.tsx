import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * The card a shared link shows in a wallet browser, a group chat or a tweet
 * (GHO-58). Every market and round is shareable (GHO-41), so this is the
 * first thing most people will see of the app.
 *
 * Set in Nippo, from the .woff the foundry ships: `ImageResponse` renders
 * through Satori, which reads TTF/OTF/WOFF and not WOFF2. That's the one
 * reason a second Nippo file exists in `src/fonts`.
 */
export const alt = "GhostStake — stake, borrow against it, and take a position";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const nippo = await readFile(join(process.cwd(), "src/fonts/Nippo-Bold.woff"));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#253122",
          padding: 72,
          fontFamily: "Nippo",
          color: "#f1eadb",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <path d="M32 2 60 32H4z" fill="#96d1aa" />
            <path d="M32 62 4 32h56z" fill="#f58e84" />
          </svg>
          <span style={{ fontSize: 44, letterSpacing: 1, color: "#cb2f43" }}>GHOSTSTAKE</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 76, lineHeight: 1.05 }}>Your stake keeps earning</span>
          <span style={{ fontSize: 76, lineHeight: 1.05, color: "#96d1aa" }}>
            while it backs your call
          </span>
        </div>

        <div style={{ display: "flex", gap: 40, fontSize: 30, color: "#b3b8a4" }}>
          <span>Stake earns</span>
          <span>Borrow against it</span>
          <span>Take a side — without unwinding</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Nippo", data: nippo, style: "normal", weight: 700 }],
    },
  );
}
