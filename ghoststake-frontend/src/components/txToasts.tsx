import { toast } from "sonner";

import { ExplorerLink } from "@/components/ui/ExplorerLink";

/**
 * A transaction's progress as a toast (GHO-104).
 *
 * The form that sent a transaction shows its status inline (`TxStatus`), but
 * only while that form is on screen. Navigate away while it is pending and
 * the line goes with the form, while the transaction carries on without
 * anyone watching. A toast lives in the app frame, so it follows you: sent,
 * then confirmed or reverted, each with the link to check it.
 *
 * One toast per attempt, updated in place (same `id`) rather than stacked.
 */
/*
 * The words come from the caller, already translated (GHO-120): this runs in
 * `useTransaction`'s callbacks, outside render, where there is no hook to
 * read the catalog with, and the hook that calls it has one.
 */
export const txToast = {
  sent(id: string, hash: `0x${string}`, text: { title: string; link: string }) {
    toast.loading(text.title, {
      id,
      description: <ExplorerLink tx={hash}>{text.link}</ExplorerLink>,
    });
  },
  confirmed(id: string, hash: `0x${string}`, text: { title: string; link: string }) {
    toast.success(text.title, {
      id,
      description: <ExplorerLink tx={hash}>{text.link}</ExplorerLink>,
    });
  },
  failed(id: string, message: string, extra: { hash?: `0x${string}`; link: string }) {
    toast.error(message, {
      id,
      duration: 10_000,
      description: extra.hash ? <ExplorerLink tx={extra.hash}>{extra.link}</ExplorerLink> : undefined,
    });
  },
  /** Rejected in the wallet: nothing was sent, so no toast is left behind. */
  dismiss(id: string) {
    toast.dismiss(id);
  },
};
