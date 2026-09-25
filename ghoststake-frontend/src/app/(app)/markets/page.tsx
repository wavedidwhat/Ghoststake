import { redirect } from "next/navigation";

/**
 * The feed lives at `/` now (GHO-62). This redirect keeps every link that was
 * ever shared to `/markets` working — including the sidebar of an older
 * cached page — rather than serving a 404 to the one route people had learned.
 *
 * Permanent, because the move is permanent: a browser may cache it.
 */
export default function MarketsRedirect() {
  redirect("/");
}
