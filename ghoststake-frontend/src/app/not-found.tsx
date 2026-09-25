import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";

export const metadata: Metadata = { title: "Not found · GhostStake" };

/**
 * Any URL that names nothing (GHO-85): an unmatched path, or a market or round
 * URL whose segment is not an address or a round id — both pages call
 * `notFound()` for that.
 *
 * A well-formed address that simply is not a market is *not* sent here: that
 * page renders its own answer, because it can say something more useful ("the
 * registry does not list it") than a generic 404 can.
 */
export default function NotFound() {
  return (
    <Notice
      eyebrow="404"
      title="Nothing here"
      actions={
        <Link href="/" className={buttonClass({ variant: "outline", size: "lg" })}>
          Go to markets
        </Link>
      }
    >
      <p>
        This link does not point at a market, a round or a page. If someone shared it, the address in
        it may have been cut short.
      </p>
    </Notice>
  );
}
