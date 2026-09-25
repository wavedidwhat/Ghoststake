"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A bottom sheet on a phone, a centred panel from `sm` up (GHO-59).
 *
 * Built on `<dialog>` rather than a div with a high z-index, because the
 * platform already does the parts that are easy to get wrong: the top layer
 * (so nothing can paint over it), focus trapping, Escape to close, and
 * `aria-modal` semantics. Nothing here needs a modal library.
 *
 * Deliberately not draggable. A drag-to-dismiss gesture on the sheet that
 * confirms a transaction is a way to lose a bet to a stray thumb; the close
 * button and the backdrop are enough.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // `showModal()` is what puts the dialog in the top layer and traps focus;
    // the `open` attribute alone does neither.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Escape fires `cancel`, and the browser closes the dialog itself, so
      // React's state has to be told or the sheet cannot be reopened.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      // A click that lands on the dialog element itself is a click on the
      // backdrop: the content sits in the inner div, which stops propagation
      // by being the actual target.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      aria-label={title}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none overflow-y-auto border-t border-border bg-surface text-ink backdrop:bg-black/60 sm:m-auto sm:max-w-lg sm:border sm:border-border"
    >
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <h2 className="display text-base uppercase">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          // 44px minimum target: this is the control someone reaches for in a
          // hurry, on a moving train, with one thumb.
          className="flex size-11 cursor-pointer items-center justify-center text-ink-muted transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          <span aria-hidden="true" className="text-xl leading-none">
            ×
          </span>
          <span className="sr-only">Close</span>
        </button>
      </div>

      {/* The bottom inset keeps the last row clear of the iOS home bar. */}
      <div className="px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">{children}</div>
    </dialog>
  );
}
