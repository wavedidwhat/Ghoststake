"use client";

import { Surface } from "@webprodigies/flute";
import { FreezeForCapture } from "../FreezeForCapture";

/**
 * The closing card. The mark is the app's own icon (src/app/icon.svg, served
 * at /icon.svg) and the wordmark is set exactly as the sidebar sets it, in
 * the app's display face, so nothing here is drawn for the video.
 */
export default function EndCard() {
  return (
    <FreezeForCapture>
      <div style={{ position: "relative", width: 1440, height: 900 }}>
        <Surface id="mark" style={{ position: "absolute", left: 640, top: 210, width: 160, height: 160 }}>
          <svg viewBox="0 0 64 64" width={160} height={160} aria-label="GhostStake">
            <path d="M32 8 52 30H12z" fill="#2fd07a" />
            <path d="M32 56 12 34h40z" fill="#ff5470" />
          </svg>
        </Surface>
        <Surface id="wordmark" style={{ position: "absolute", left: 320, top: 400, width: 800, height: 90 }}>
          <div className="display text-center text-6xl tracking-wide text-brand uppercase">GhostStake</div>
        </Surface>
        <Surface id="address" style={{ position: "absolute", left: 420, top: 440, width: 600, height: 40 }}>
          <div className="text-center text-lg tracking-wide text-ink-muted">testnet.ghoststake.xyz</div>
        </Surface>
      </div>
    </FreezeForCapture>
  );
}
