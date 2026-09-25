/**
 * Our own glyphs, drawn here rather than pulled from an icon library (GHO-58).
 *
 * The issue asked for one human-drawn set plus a few custom glyphs for our
 * own concepts. These are the custom ones, and they are the only icons the
 * app has so far — nothing else in the UI had an icon, so importing a whole
 * set (Phosphor, Lucide) would have added a signing-path dependency (GHO-68)
 * to draw two triangles.
 *
 * The side arrows exist because colour must never be the only signal for Up
 * and Down: every side carries an arrow and a word as well, so the pair still
 * reads for a colour-blind user and in a greyscale screenshot.
 */

export function ArrowUp({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 2 14.5 10.5H1.5z" />
    </svg>
  );
}

export function ArrowDown({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 14 1.5 5.5h13z" />
    </svg>
  );
}

/** Up or Down, picked by the side. */
export function SideArrow({ up, className = "" }: { up: boolean; className?: string }) {
  return up ? <ArrowUp className={className} /> : <ArrowDown className={className} />;
}
