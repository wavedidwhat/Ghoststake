import { useTranslations } from "next-intl";
import { Notice } from "@/components/ui/Notice";
import type { ConfigProblem } from "@/lib/env";

/**
 * What the app renders instead of itself when it was built with a variable it
 * cannot use (GHO-85).
 *
 * Names the variable and the value, which are public — every `NEXT_PUBLIC_`
 * value is inlined into the JavaScript this page would have shipped — and are
 * the only two things whoever deployed this needs to fix it. No retry button:
 * these are baked in at build time, so nothing short of a rebuild changes them.
 *
 * Each problem's `reason` stays English, from `lib/env.ts` (GHO-117): it is
 * a diagnostic for whoever deployed the app, beside a variable name and a raw
 * value, not copy for someone using it.
 */
export function Misconfigured({ problems }: { problems: readonly ConfigProblem[] }) {
  const t = useTranslations("misconfigured");
  return (
    <Notice eyebrow={t("eyebrow")} title={t("title")}>
      <p>{t("body", { count: problems.length })}</p>
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
      <p className="text-xs text-ink-faint">{t("rebuild")}</p>
    </Notice>
  );
}
