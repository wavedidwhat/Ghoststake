import type { Metadata } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { buttonClass } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("notFound");
  return { title: t("metaTitle") };
}

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
  const t = useTranslations("notFound");
  const actions = useTranslations("actions");

  return (
    <Notice
      eyebrow={t("eyebrow")}
      title={t("title")}
      actions={
        <Link href="/" className={buttonClass({ variant: "outline", size: "lg" })}>
          {actions("goToMarkets")}
        </Link>
      }
    >
      <p>{t("body")}</p>
    </Notice>
  );
}
