import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { Card } from "./Card";

/**
 * A read that failed, with a way to try it again (GHO-96).
 *
 * Five screens had their own copy of this, in two layouts and three button
 * styles. What stays per screen is the copy, because that is the part that
 * matters: say what could not be read, and — where it is true — that nothing
 * the person owns has changed, only this screen's view of it.
 */
export function LoadFailed({
  title,
  children,
  detail,
  onRetry,
  className = "",
}: {
  title: string;
  /** The reassurance: what is and is not affected. */
  children?: ReactNode;
  /** The raw error, for someone reporting it. Shown small. */
  detail?: string;
  onRetry: () => void;
  /** Layout only, e.g. centring when this stands in for the whole screen. */
  className?: string;
}) {
  const actions = useTranslations("actions");
  return (
    <Card className={className}>
      <h2 className="text-base font-medium text-warning">{title}</h2>
      {children && <p className="mt-2 text-sm leading-relaxed text-ink-muted">{children}</p>}
      {detail && <p className="mt-2 text-xs break-words text-ink-faint">{detail}</p>}
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-4">
        {actions("tryAgain")}
      </Button>
    </Card>
  );
}
