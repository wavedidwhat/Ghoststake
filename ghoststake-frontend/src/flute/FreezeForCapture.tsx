"use client";

import { onlineManager, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
 * bridge's first seek waits for `whenFilmable`, then React Query is told it is
 * offline, which pauses every refetch and keeps the data it already has.
 * Interactive preview is untouched: the hold only applies to seeks.
 */
export const SETTLE_MS = 1500;
export const CAP_MS = 60_000;

/** Skeletons, and anything a scene marks as not ready yet (see WatchWallet). */
const PENDING = ".animate-pulse, [data-film-pending]";

/**
 * Resolves once nothing is fetching and nothing is pending on screen, held
 * for SETTLE_MS. Rejects, so export aborts instead of writing a plausible
 * wrong video, when a query something on screen depends on has failed (an
 * error card would be filmed as if it were the product) or when nothing
 * settles within CAP_MS (the frames would be loading skeletons).
 */
export function whenFilmable(
  queryClient: QueryClient,
  pendingOnScreen: () => boolean,
  now: () => number = Date.now,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = now();
    let quietSince = 0;
    const tick = () => {
      const t = now();
      if (queryClient.isFetching() > 0 || pendingOnScreen()) quietSince = 0;
      else if (!quietSince) quietSince = t;

      if (quietSince && t - quietSince >= SETTLE_MS) {
        const errors = queryClient
          .getQueryCache()
          .getAll()
          .filter((q) => q.state.status === "error" && q.getObserversCount() > 0)
          .map((q) => JSON.stringify(q.queryKey).slice(0, 120));
        if (errors.length > 0) {
          reject(new Error(`Not filming: ${errors.length} on-screen queries failed: ${errors.join(", ")}`));
        } else resolve();
      } else if (t - started >= CAP_MS) {
        reject(new Error(`Not filming: the scene's data did not settle within ${CAP_MS / 1000}s.`));
      } else setTimeout(tick, 100);
    };
    tick();
  });
}

type Bridge = { seek(ms: number): unknown; __frozen?: boolean };

export function FreezeForCapture({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let ready: Promise<void> | undefined;
    const settled = () =>
      (ready ??= whenFilmable(queryClient, () => document.querySelector(PENDING) !== null).then(() => {
        onlineManager.setOnline(false);
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
