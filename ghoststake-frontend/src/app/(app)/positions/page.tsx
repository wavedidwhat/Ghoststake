import { PositionsScreen } from "./PositionsScreen";
import { singleParam } from "@/lib/searchParams";

/**
 * `?address=` is read here, on the server, not with `useSearchParams`.
 *
 * `useSearchParams` needs a Suspense boundary, and once every page renders per
 * request (the CSP nonce, GHO-66) that boundary hydrates after the rest of the
 * page — by which time wagmi has begun reconnecting, so the connect button
 * inside it no longer matches the server HTML. React #418 on every load.
 */
export default async function PositionsPage({ searchParams }: PageProps<"/positions">) {
  return <PositionsScreen requested={singleParam((await searchParams).address)} />;
}
