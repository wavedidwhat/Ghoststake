import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "../api";

/**
 * `request` is the one place "the API was unreachable" and "the API said no"
 * are told apart, and every read client in the app goes through it. It was
 * untested while this file tested the SIWE session parsing instead — and the
 * session is gone (GHO-84), so this is what the file is about now.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchReturning(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response as Response));
}

describe("request", () => {
  it("gives a reachability failure status 0, so a caller can tell it apart", async () => {
    // The browser only ever reports "Failed to fetch", which is true of a
    // dead server, a wrong port and a CORS refusal alike.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(request("/api/v1/rounds")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
  });

  it("prefers the server's own error message over a synthesised one", async () => {
    fetchReturning({
      ok: false,
      status: 503,
      json: async () => ({ error: "the chain is temporarily unreachable" }),
    });

    // GHO-81 made the API answer 503 with a reason. Discarding it here would
    // put the endpoint back to reporting somebody else's quota as our bug.
    await expect(request("/api/v1/rounds")).rejects.toMatchObject({
      message: "the chain is temporarily unreachable",
      status: 503,
    });
  });

  it("falls back to the status when the body carries no reason", async () => {
    fetchReturning({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });

    const error = await request("/api/v1/rounds").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).message).toContain("500");
  });

  it("returns the parsed body on success", async () => {
    fetchReturning({ ok: true, status: 200, json: async () => ({ rounds: [] }) });

    await expect(request<{ rounds: unknown[] }>("/api/v1/rounds")).resolves.toEqual({
      rounds: [],
    });
  });
});
