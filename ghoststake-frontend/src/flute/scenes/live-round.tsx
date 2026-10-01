"use client";

import { Surface } from "@webprodigies/flute";
import { FreezeForCapture } from "../FreezeForCapture";
import { RoundScreen } from "@/app/(app)/markets/[market]/[id]/RoundScreen";
import { Sidebar } from "@/components/Sidebar";
import { env } from "@/lib/env";

/** `?film-round=N` picks the round; the demo market opens a new one every few minutes. */
function roundFromUrl(): string {
  if (typeof window === "undefined") return "1";
  const value = new URLSearchParams(window.location.search).get("film-round");
  return value && /^\d+$/.test(value) ? value : "1";
}

/** The real round page for the demo market (ETH / USD, operator-set price). */
export default function LiveRound() {
  return (
    <FreezeForCapture>
      <Surface id="app" style={{ width: 1440, height: 900 }}>
        <div className="flex h-[900px] overflow-hidden bg-ground">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <RoundScreen market={env.demoMarketAddress ?? ""} id={roundFromUrl()} />
          </div>
        </div>
      </Surface>
    </FreezeForCapture>
  );
}
