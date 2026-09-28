import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import messages from "../../messages/en.json";

/**
 * The card a shared link shows in a wallet browser, a group chat or a tweet
 * (GHO-58). Every market and round is shareable (GHO-41), so this is the
 * first thing most people will see of the app.
 *
 * Set in Nippo, from the .woff the foundry ships: `ImageResponse` renders
 * through Satori, which reads TTF/OTF/WOFF and not WOFF2. That's the one
 * reason a second Nippo file exists in `src/fonts`.
 */
// Read from the catalog directly (GHO-120): an image route renders outside
// the provider, and at build time, where there is no request to ask for a
// locale. With one locale there is nothing to choose.
const copy = messages.og;

export const alt = copy.alt;
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
          background: "#0d0f0e",
          padding: 72,
          fontFamily: "Nippo",
          color: "#f2f4f2",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <path d="M32 2 60 32H4z" fill="#2fd07a" />
            <path d="M32 62 4 32h56z" fill="#ff5470" />
          </svg>
          <span style={{ fontSize: 44, letterSpacing: 1, color: "#e8394f" }}>
            {messages.app.title.toUpperCase()}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ fontSize: 76, lineHeight: 1.05 }}>{copy.headline}</span>
          <span style={{ fontSize: 76, lineHeight: 1.05, color: "#2fd07a" }}>{copy.headlineAccent}</span>
        </div>

        <div style={{ display: "flex", gap: 40, fontSize: 30, color: "#a0aaa5" }}>
          <span>{copy.stepStake}</span>
          <span>{copy.stepBorrow}</span>
          <span>{copy.stepSide}</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Nippo", data: nippo, style: "normal", weight: 700 }],
    },
  );
}
