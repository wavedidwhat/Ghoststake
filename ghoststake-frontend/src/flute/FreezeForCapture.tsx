"use client";

import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";

/**
 * Holds `flute export` until the scene's live data has arrived, then stops it
 * changing (Flute scenes only, development only).
 *
 * Export captures one frame per seek, and on this machine 12 seconds of video
 * takes minutes of wall-clock time. Left alone, the first frames are loading
 * skeletons and the app keeps refetching during capture, so a round opens or
 * a list reorders halfway through a shot that is meant to be one moment.
 *
 * Export waits on whatever `window.__FLUTE_CAPTURE__.seek` returns, so the
 * bridge's first seek is made to wait until nothing is fetching and no
 * skeleton is on screen (held for a beat, capped at a minute). Then React
 * Query is told it is offline, which pauses every refetch and keeps the data
 * it already has. Interactive preview is untouched: the hold only applies to
 * seeks, and only once.
 */
const SETTLE_MS = 1500;
const CAP_MS = 60_000;

type Bridge = { seek(ms: number): unknown; __frozen?: boolean };

export function FreezeForCapture({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let ready: Promise<void> | undefined;
    const settled = () =>
      (ready ??= new Promise<void>((resolve) => {
        const started = Date.now();
        let quietSince = 0;
        const tick = () => {
          const busy =
            queryClient.isFetching() > 0 || document.querySelector(".animate-pulse") !== null;
          const now = Date.now();
          if (busy) quietSince = 0;
          else if (!quietSince) quietSince = now;
          if ((quietSince && now - quietSince >= SETTLE_MS) || now - started >= CAP_MS) {
            onlineManager.setOnline(false);
            resolve();
          } else setTimeout(tick, 100);
        };
        tick();
      }));

    // The bridge is registered by ScenePreview, possibly after this effect.
    const wrap = () => {
      const w = window as unknown as { __FLUTE_CAPTURE__?: Bridge };
      const bridge = w.__FLUTE_CAPTURE__;
      if (!bridge || bridge.__frozen) return;
      const seek = bridge.seek.bind(bridge);
      // A copy, not a patch: the registered bridge may be frozen.
      w.__FLUTE_CAPTURE__ = {
        ...bridge,
        seek: async (ms: number) => {
          await settled();
          return seek(ms);
        },
        __frozen: true,
      };
    };
    wrap();
    const timer = setInterval(wrap, 50);
    return () => {
      clearInterval(timer);
      onlineManager.setOnline(true);
    };
  }, [queryClient]);

  return <>{children}</>;
}
