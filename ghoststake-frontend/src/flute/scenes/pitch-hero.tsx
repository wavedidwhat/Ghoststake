"use client";

import { Surface } from "@webprodigies/flute";
import { FreezeForCapture } from "../FreezeForCapture";
import { Landing } from "@/components/Landing";

/** The real landing pitch from How it works: headline, the three steps and the risks. */
export default function PitchHero() {
  return (
    <FreezeForCapture>
      <Surface id="landing" style={{ width: 1100, height: 900 }}>
        <div className="h-[900px] overflow-hidden rounded-card bg-ground px-10 py-6">
          <Landing />
        </div>
      </Surface>
    </FreezeForCapture>
  );
}
