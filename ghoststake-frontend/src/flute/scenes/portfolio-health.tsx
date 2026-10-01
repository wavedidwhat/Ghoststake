"use client";

import { Surface } from "@webprodigies/flute";
import { FreezeForCapture } from "../FreezeForCapture";
import PortfolioPage from "@/app/(app)/portfolio/page";
import { Sidebar } from "@/components/Sidebar";
import { WatchWallet } from "../WatchWallet";

/** The real portfolio screen, connected watch-only to the filming wallet. */
export default function PortfolioHealth() {
  return (
    <FreezeForCapture>
      <WatchWallet>
        <Surface id="app" style={{ width: 1440, height: 900 }}>
          <div className="flex h-[900px] overflow-hidden bg-ground">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <PortfolioPage />
            </div>
          </div>
        </Surface>
      </WatchWallet>
    </FreezeForCapture>
  );
}
