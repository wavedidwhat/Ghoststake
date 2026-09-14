import { ActivityScreen } from "./ActivityScreen";
import { singleParam } from "@/lib/searchParams";

/** `?address=` is read on the server; see `positions/page.tsx` for why. */
export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  return <ActivityScreen requested={singleParam((await searchParams).address)} />;
}
