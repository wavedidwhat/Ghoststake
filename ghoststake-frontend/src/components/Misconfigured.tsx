import { Notice } from "./Notice";
import type { ConfigProblem } from "@/lib/env";

/**
 * What the app renders instead of itself when it was built with a variable it
 * cannot use (GHO-85).
 *
 * Names the variable and the value, which are public — every `NEXT_PUBLIC_`
 * value is inlined into the JavaScript this page would have shipped — and are
 * the only two things whoever deployed this needs to fix it. No retry button:
 * these are baked in at build time, so nothing short of a rebuild changes them.
 */
export function Misconfigured({ problems }: { problems: readonly ConfigProblem[] }) {
  return (
    <Notice eyebrow="Configuration" title="This deployment is misconfigured">
      <p>
        It was built with {problems.length === 1 ? "a setting" : "settings"} the app cannot use, so
        it is not running rather than showing figures read from the wrong place. Nothing on chain is
        affected.
      </p>
      <ul className="space-y-3">
        {problems.map((p) => (
          <li key={p.variable} className="rounded-control border border-border bg-raised/40 px-3 py-2">
            <code className="font-mono text-xs break-all text-ink">{p.variable}</code>
            <p className="mt-1 text-xs">
              <code className="font-mono break-all text-warning">{JSON.stringify(p.value)}</code>{" "}
              {p.reason}.
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-faint">
        These are read when the app is built, so fixing one means rebuilding it.
      </p>
    </Notice>
  );
}
