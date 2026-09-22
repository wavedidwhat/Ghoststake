import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Thrower } from "./Thrower";

/**
 * A page that throws while rendering, so a test can prove the error boundary
 * catches (GHO-85). Nothing in the app throws on demand, and a boundary nobody
 * exercises is a boundary nobody knows is there.
 *
 * Exists only when the server is started with `GHOSTSTAKE_E2E=1`, which the
 * Playwright web server does. Read at request time — a server variable, not a
 * `NEXT_PUBLIC_` one — so a production image built from the same code answers
 * this path with the ordinary 404.
 */
export default async function ThrowPage() {
  await connection();
  if (process.env.GHOSTSTAKE_E2E !== "1") notFound();
  return <Thrower />;
}
