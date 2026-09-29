import { createTranslator, IntlErrorCode, NextIntlClientProvider, type IntlError } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/en.json";
import RouteError from "../../app/error";
import GlobalError from "../../app/global-error";
import NotFound from "../../app/not-found";

/**
 * The message catalog (GHO-116).
 *
 * `tsc` proves every key a component asks for exists. It cannot see inside
 * a message, and next-intl does not fail on a malformed one either: it logs,
 * and renders the key path ("notFound.body") where the sentence should be.
 * That is the failure worth a test, because it looks deliberate on screen.
 */

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`),
  );
}

const all = leaves(messages);

describe("messages/en.json", () => {
  it("has no empty messages", () => {
    expect(all.filter(([, value]) => value.trim() === "").map(([key]) => key)).toEqual([]);
  });

  it("parses every message as ICU", () => {
    const invalid: string[] = [];
    const t = createTranslator({
      locale: "en",
      messages,
      onError: (error: IntlError) => {
        // A missing argument or an unhandled tag is a formatting error, which
        // is expected here: nothing is passed in. A syntax error is not.
        if (error.code !== IntlErrorCode.FORMATTING_ERROR) invalid.push(error.message);
      },
    });
    // Keys come from the file itself, so they cannot be checked against its
    // type; widening `t` is the price of walking every one.
    for (const [key] of all) (t as (key: string) => string)(key);
    expect(invalid).toEqual([]);
  });

  it("finds messages to check", () => {
    // Guards the check above: a catalog walk that found nothing would pass.
    expect(all.length).toBeGreaterThan(10);
  });

  /**
   * The voice rules that are mechanical enough to hold with a test (GHO-122).
   * An em dash reads as machine-written ("a dead giveaway"), and these words
   * are the stock phrases that make copy sound generated. Both came back
   * every time copy was written quickly, so they're checked, not remembered.
   */
  it("has no em dashes and none of the banned stock phrases", () => {
    const banned = [
      "delve", "testament", "tapestry", "revolutioni", "game-changer", "game changer",
      "buckle up", "elevate", "look no further", "in a world where", "more than just",
      "unlock your potential", "foster", "seamless",
    ];
    const found: string[] = [];
    for (const [key, text] of all) {
      if (/[\u2014\u2013]/.test(text)) found.push(`${key}: dash`);
      for (const word of banned) if (text.toLowerCase().includes(word)) found.push(`${key}: ${word}`);
    }
    expect(found).toEqual([]);
  });

  /**
   * In ICU the ASCII apostrophe is the escape character (GHO-118). Placed
   * before a `{` or `#` it quotes what follows, and the text renders without
   * the apostrophe and with the braces as literal characters. Nothing errors.
   * Copy is full of apostrophes ("didn't", "the protocol's cut"), so every
   * message is rendered and compared: a plain one must come out exactly as
   * written, and any one must keep every apostrophe it had.
   */
  it("renders as written, apostrophes included", () => {
    const t = createTranslator({ locale: "en", messages, onError: () => {} }) as unknown as (
      key: string,
      values?: Record<string, string>,
    ) => string;
    const changed: string[] = [];
    for (const [key, text] of all) {
      const plain = !/[{}<]/.test(text);
      const names = [...text.matchAll(/\{\s*(\w+)/g)].map((m) => m[1]);
      const rendered = t(key, Object.fromEntries(names.map((n) => [n, "X"])));
      const apostrophes = (s: string) => s.split("'").length - 1;
      if (plain ? rendered !== text : apostrophes(rendered) < apostrophes(text)) changed.push(key);
    }
    expect(changed).toEqual([]);
  });
});

/** Migrated screens render their copy from the catalog, not their keys. */
const withMessages = (ui: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe("migrated screens", () => {
  it("not-found", () => {
    const html = withMessages(<NotFound />);
    expect(html).toContain(messages.notFound.title);
    expect(html).toContain(messages.actions.goToMarkets);
    expect(html).not.toContain("notFound.");
  });

  it("route error, with the digest inside the reference", () => {
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    const html = withMessages(<RouteError error={error} retry={() => {}} />);
    expect(html).toContain(messages.routeError.title);
    expect(html).toContain('Reference <code class="font-mono">abc123</code>');
    expect(html).not.toContain("routeError.");
  });

  it("global error, which brings its own messages", () => {
    // No provider around it: the root layout that would supply one is what
    // failed.
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    const html = renderToStaticMarkup(<GlobalError error={error} retry={() => {}} />);
    expect(html).toContain(messages.globalError.title);
    expect(html).toContain(messages.actions.reload);
    expect(html).toContain('Reference <code class="font-mono">abc123</code>');
  });
});
