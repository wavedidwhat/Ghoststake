import { NextResponse, type NextRequest } from "next/server";
import { activeRpcUrl } from "@/lib/chains";
import { buildCsp } from "@/lib/csp";
import { env } from "@/lib/env";

/**
 * A fresh nonce and CSP per page request.
 *
 * Next reads the nonce back out of the request's CSP header and stamps it on
 * its own scripts, which is why the header is set on the request as well as
 * the response. It only works on dynamically rendered pages: the root layout
 * calls `connection()` so nothing is prerendered without one.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    apiUrl: env.apiUrl,
    rpcUrl: activeRpcUrl,
    walletConnect: Boolean(env.walletConnectProjectId),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Static files carry no scripts to protect; prefetches are not documents.
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
