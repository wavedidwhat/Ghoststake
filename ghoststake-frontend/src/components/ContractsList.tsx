"use client";

import { deployedContracts } from "@/lib/contracts";
import { useMarkets } from "@/hooks/useMarkets";
import { activeChain } from "@/lib/wagmi";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { ExplorerLink } from "@/components/ui/ExplorerLink";

/**
 * "Check it yourself": every contract that holds or decides money, each one
 * a link to the explorer (GHO-103).
 *
 * The app says a lot of things, like "your stake keeps earning" or "settles
 * on Chainlink". This is where each one can be checked against the chain,
 * by someone who doesn't trust the page telling them.
 */
export function ContractsList() {
  const configured = deployedContracts();
  const { markets } = useMarkets();

  // Markets from the registry, less any already listed from configuration.
  const known = new Set(configured.map((c) => c.address.toLowerCase()));
  const listed = markets.filter((m) => !known.has(m.key));

  return (
    <section aria-labelledby="contracts-heading" className="mt-8 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Eyebrow as="h2" id="contracts-heading">
          Check it yourself
        </Eyebrow>
        <span className="h-px flex-1 bg-border" />
      </div>
      <p className="text-sm leading-relaxed text-ink-muted">
        Every contract this app uses on {activeChain.name}, and what it does. Each links to the
        chain&rsquo;s explorer, where the code and every transaction are public.
      </p>

      <ul className="divide-y divide-border rounded-card border border-border bg-surface">
        {configured.map((c) => (
          <li key={c.address} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <p className="text-sm text-ink">{c.name}</p>
              <p className="text-xs leading-relaxed text-ink-muted">{c.role}</p>
            </div>
            <ExplorerLink address={c.address} className="shrink-0 text-xs text-ink-muted" />
          </li>
        ))}
        {listed.map((m) => (
          <li key={m.key} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <p className="text-sm text-ink">Market</p>
              <p className="text-xs leading-relaxed text-ink-muted">
                Listed in the registry{m.enabled ? "" : ", now delisted"}. Holds the pools for each
                round and pays out when it settles.
              </p>
            </div>
            <ExplorerLink address={m.address} className="shrink-0 text-xs text-ink-muted" />
          </li>
        ))}
      </ul>
    </section>
  );
}
