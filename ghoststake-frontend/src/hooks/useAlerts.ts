"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import type { Message } from "@/i18n/message";
import { alertsFor, unseen, type Alert } from "@/lib/alerts";
import { useClaimables } from "@/hooks/useClaimables";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { useWallet } from "@/hooks/useWallet";

/**
 * The bell's contents, and the one-time announcement of anything new
 * (GHO-104).
 *
 * Reads the same hooks the pages do, so react-query shares the requests and
 * the bell never shows a figure the page it links to disagrees with.
 *
 * "Seen" is remembered per address in this browser's storage. It's a
 * convenience, not a record: a private window or cleared storage just
 * announces current alerts once more, which is the right way to be wrong.
 */
export function useAlerts() {
  const t = useTranslations();
  const { address } = useWallet();
  const position = useVaultPosition();
  const { claims } = useClaimables();

  const alerts: Alert[] = address
    ? alertsFor({
        claims,
        healthFactor: position.healthFactor,
        decimals: position.decimals,
        symbol: position.symbol ?? "",
      })
    : [];

  const ids = alerts.map((a) => a.id).join("|");

  useEffect(() => {
    if (!address || alerts.length === 0) return;
    const key = `ghoststake:seen-alerts:${address.toLowerCase()}`;
    const seen = readSeen(key);
    const fresh = unseen(alerts, seen);
    if (fresh.length === 0) return;

    for (const alert of fresh) {
      announce(alert, (m) => t(m.key, m.values));
      seen.add(alert.id);
    }
    writeSeen(key, seen);
    // `ids` stands for `alerts`: a new array every render, the same content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, ids]);

  return alerts;
}

function announce(alert: Alert, text: (m: Message) => string) {
  const show = alert.tone === "negative" ? toast.error : alert.tone === "warning" ? toast.warning : toast.success;
  show(text(alert.title), {
    id: alert.id,
    description: text(alert.body),
    // Danger stays until dismissed: it is the one that costs money if missed.
    duration: alert.tone === "negative" ? Infinity : 10_000,
    action: { label: text(alert.action), onClick: () => window.location.assign(alert.href) },
  });

  // In the background, and only if this browser was told it may: an open
  // tab already has the toast.
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden" &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    const n = new Notification(text(alert.title), { body: text(alert.body), tag: alert.id });
    n.onclick = () => {
      window.focus();
      window.location.assign(alert.href);
    };
  }
}

/**
 * Browser notifications: whether they can be asked for, whether they're on,
 * and the ask itself. Asked only from the bell, when someone chooses to;
 * never on arrival (GHO-71).
 */
export function useBrowserNotifications() {
  // Read through `useSyncExternalStore`: the server can't know the browser's
  // permission, so its snapshot is `undefined` and hydration matches. The
  // client then reads the real value, with no effect-then-setState render.
  const current = useSyncExternalStore(
    noSubscription,
    () => (typeof Notification === "undefined" ? undefined : Notification.permission),
    () => undefined,
  );
  // What the prompt just answered. The permission has no change event to
  // subscribe to, so the answer is held here until the next read.
  const [answered, setAnswered] = useState<NotificationPermission | undefined>(undefined);
  const supported = current !== undefined;

  const request = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    setAnswered(await Notification.requestPermission());
  }, []);

  return { supported, permission: answered ?? current, request };
}

function noSubscription() {
  return () => {};
}

function readSeen(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSeen(key: string, seen: Set<string>) {
  try {
    // Bounded: the ids of winnings change as rounds settle, and a list that
    // only grows would outlive any use.
    window.localStorage.setItem(key, JSON.stringify([...seen].slice(-50)));
  } catch {
    // Storage blocked or full: the cost is one repeated toast, not a failure.
  }
}
