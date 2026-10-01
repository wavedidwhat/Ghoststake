"use client";

import { Surface } from "@webprodigies/flute";
import { FreezeForCapture } from "../FreezeForCapture";
import { MarketsScreen } from "@/components/MarketsScreen";
import { Sidebar } from "@/components/Sidebar";

/** The real home screen: frame and market feed, as `(app)/layout.tsx` composes them. */
export default function MarketsSurvey() {
  return (
    <FreezeForCapture>
      <Surface id="app" style={{ width: 1440, height: 900 }}>
        <div className="flex h-[900px] overflow-hidden bg-ground">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <MarketsScreen />
          </div>
        </div>
      </Surface>
    </FreezeForCapture>
  );
}
