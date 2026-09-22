"use client";

/** Throws during render, on the client as well as the server. */
export function Thrower(): never {
  throw new Error("GHO-85: deliberate render throw for the error boundary test");
}
