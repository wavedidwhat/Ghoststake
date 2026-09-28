"use client";

import Link from "next/link";
import { useState } from "react";
import { Bell } from "@phosphor-icons/react";

import { useAlerts, useBrowserNotifications } from "@/hooks/useAlerts";
import { useWallet } from "@/hooks/useWallet";
import { Sheet } from "@/components/ui/Sheet";
import { Button, buttonClass } from "@/components/ui/Button";

/**
 * The bell in the header (GHO-104): what needs you right now.
 *
 * Only for a connected wallet, because every alert is about an address.
 * The count is a plain figure, not a red dot: red is the brand's, and a
 * count says how much, where a dot only says "something". It turns
 * `negative` only when one of the alerts is danger.
 */
export function AlertBell() {
  const { address } = useWallet();
  const alerts = useAlerts();
  const browser = useBrowserNotifications();
  const [open, setOpen] = useState(false);

  if (!address) return null;
  const count = alerts.length;
  const urgent = alerts.some((a) => a.tone === "negative");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={count === 0 ? "Notifications, none" : `Notifications, ${count}`}
        className="relative flex size-11 cursor-pointer items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      >
        <Bell aria-hidden="true" weight={count > 0 ? "fill" : "regular"} className="size-5" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className={`tabular absolute top-1 right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold text-ground ${
              urgent ? "bg-negative" : "bg-ink"
            }`}
          >
            {count}
          </span>
        )}
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Notifications">
        {count === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing needs you right now. Winnings to claim and a falling safety factor show up here.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {alerts.map((a) => (
              <li
                key={a.id}
                className={`rounded-card border p-4 ${
                  a.tone === "negative"
                    ? "border-negative/50 bg-negative-soft"
                    : a.tone === "warning"
                      ? "border-warning/50 bg-warning-soft"
                      : "border-border bg-raised"
                }`}
              >
                <p className="font-medium text-ink">{a.title}</p>
                <p className="mt-1 text-sm text-ink-muted">{a.body}</p>
                <Link
                  href={a.href}
                  onClick={() => setOpen(false)}
                  className={buttonClass({ size: "sm", className: "mt-3" })}
                >
                  {a.action}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Asked here, when someone opens the bell and chooses to, never on
            arrival (GHO-71). Background tabs only; an open tab gets the toast. */}
        {browser.supported && browser.permission !== "granted" && (
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-xs text-ink-muted">
              {browser.permission === "denied"
                ? "Browser notifications are blocked for this site. They can be allowed in the browser's site settings."
                : "Get these as browser notifications while this tab is in the background."}
            </p>
            {browser.permission !== "denied" && (
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void browser.request()}>
                Turn on browser notifications
              </Button>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
