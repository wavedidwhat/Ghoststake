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
export const txToast = {
  sent(id: string, hash: `0x${string}`) {
    toast.loading("Sent. Waiting for confirmation…", {
      id,
      description: <ExplorerLink tx={hash}>Track it on the explorer</ExplorerLink>,
    });
  },
  confirmed(id: string, hash: `0x${string}`) {
    toast.success("Confirmed", {
      id,
      description: <ExplorerLink tx={hash}>View it on the explorer</ExplorerLink>,
    });
  },
  failed(id: string, message: string, hash?: `0x${string}`) {
    toast.error(message, {
      id,
      duration: 10_000,
      description: hash ? <ExplorerLink tx={hash}>See it on the explorer</ExplorerLink> : undefined,
    });
  },
  /** Rejected in the wallet: nothing was sent, so no toast is left behind. */
  dismiss(id: string) {
    toast.dismiss(id);
  },
};
