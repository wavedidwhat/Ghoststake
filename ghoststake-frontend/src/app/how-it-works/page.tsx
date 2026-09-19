"use client";

import { AppShell } from "@/components/AppShell";
import { Landing } from "@/components/Landing";

/**
 * The explainer, on its own page (GHO-62).
 *
 * It used to be the disconnected state of `/`, which meant two things: a
 * first-time visitor met an explanation instead of the product, and anyone
 * who connected a wallet could never read it again. The pipeline — stake
 * earns, borrow against it, take a view without unwinding — is the least
 * obvious thing about this protocol, and hiding it behind "are you logged
 * out?" was exactly backwards.
 */
export default function HowItWorksPage() {
  return (
    <AppShell title="How it works" subtitle="Stake earns. Borrow against it. Take a view.">
      <Landing />
    </AppShell>
  );
}
