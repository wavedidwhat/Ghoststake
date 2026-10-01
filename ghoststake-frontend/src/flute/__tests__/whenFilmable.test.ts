import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP_MS, SETTLE_MS, whenFilmable } from "../FreezeForCapture";

/**
 * The gate in front of `flute export`. Each case is a way a video could come
 * out looking finished while showing the wrong thing.
 */
describe("whenFilmable", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = (p: Promise<unknown>) => {
    p.catch(() => {});
    return vi.advanceTimersByTimeAsync(SETTLE_MS + 200);
  };

  it("films once nothing is fetching or pending, held for the settle time", async () => {
    const client = new QueryClient();
    let done = false;
    const p = whenFilmable(client, () => false).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 200);
    expect(done).toBe(false);
    await settle(p);
    expect(done).toBe(true);
  });

  it("waits while a skeleton (or an unconnected watch wallet) is on screen", async () => {
    const client = new QueryClient();
    let pending = true;
    let done = false;
    const p = whenFilmable(client, () => pending).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(done).toBe(false);
    pending = false;
    await settle(p);
    expect(done).toBe(true);
  });

  it("refuses to film an on-screen query that failed, naming it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      queryKey: ["rounds", "demo"],
      queryFn: () => Promise.reject(new Error("api down")),
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const p = whenFilmable(client, () => false);
    await settle(p);
    await expect(p).rejects.toThrow(/1 on-screen queries failed: \["rounds","demo"\]/);
    unsubscribe();
  });

  it("ignores a failed query nothing on screen is using", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.prefetchQuery({ queryKey: ["unused"], queryFn: () => Promise.reject(new Error("x")) });
    let done = false;
    const p = whenFilmable(client, () => false).then(() => (done = true));
    await settle(p);
    expect(done).toBe(true);
  });

  it("refuses rather than film skeletons when nothing settles in time", async () => {
    const client = new QueryClient();
    const p = whenFilmable(client, () => true);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(CAP_MS + 200);
    await expect(p).rejects.toThrow(/did not settle within 60s/);
  });
});
