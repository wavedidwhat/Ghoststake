import { createTranslator, IntlErrorCode, type IntlError } from "next-intl";
import { describe, expect, it } from "vitest";
import messages from "../../../messages/en.json";
import { pseudoCatalog, pseudoMessage } from "../../i18n/pseudo";

/**
 * The pseudo-locale (GHO-120). It is only useful if it breaks nothing but
 * the words: a transform that touched an argument name or a plural keyword
 * would show errors on screen and hide the faults it exists to show.
 */

type Tree = { [key: string]: string | Tree };
const leaves = (tree: Tree, prefix = ""): [string, string][] =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[`${prefix}${key}`, value] as [string, string]] : leaves(value, `${prefix}${key}.`),
  );

describe("pseudoMessage", () => {
  it("accents, lengthens and brackets the text", () => {
    expect(pseudoMessage("Connect wallet")).toBe("[Çöññéçţ ŵåļļéţ ·····]");
  });

  it("leaves arguments, tags and plural syntax alone", () => {
    expect(pseudoMessage("Switch to {chain}")).toBe("[Šŵîţçĥ ţö {chain} ···]");
    expect(pseudoMessage("<lead>Wrong network.</lead> Hi")).toBe("[<lead>Ŵŕöñĝ ñéţŵöŕķ.</lead> Ĥî ·····]");
    expect(pseudoMessage("{count, plural, one {# round} other {# rounds}}")).toBe(
      "[{count, plural, one {# ŕöüñð} other {# ŕöüñðš}} ····]",
    );
    expect(pseudoMessage("{side, select, yes {Yes} other {No}} ahead")).toBe(
      "[{side, select, yes {Ýéš} other {Ñö}} åĥéåð ····]",
    );
  });

  it("leaves a message with no words alone", () => {
    expect(pseudoMessage("{text}")).toBe("{text}");
    expect(pseudoMessage("404")).toBe("404");
  });
});

describe("the pseudo catalog", () => {
  const pseudo = pseudoCatalog(messages);

  it("has exactly the catalog's keys", () => {
    expect(leaves(pseudo).map(([k]) => k)).toEqual(leaves(messages).map(([k]) => k));
  });

  it("parses, every message, as ICU", () => {
    const invalid: string[] = [];
    const t = createTranslator({
      locale: "en",
      messages: pseudo,
      onError: (error: IntlError) => {
        if (error.code !== IntlErrorCode.FORMATTING_ERROR) invalid.push(error.message);
      },
    }) as unknown as (key: string) => string;
    for (const [key] of leaves(pseudo)) t(key);
    expect(invalid).toEqual([]);
  });

  it("renders every argument each message had", () => {
    // Rendered, not pattern-matched: a regex cannot tell the argument in
    // `{count, plural, …}` from the branch text in `one {Yes}`. Both catalogs
    // get the same numbered value for every name that could be an argument,
    // and every value the English shows must show in the pseudo too.
    const markup = (tree: Tree) =>
      createTranslator({ locale: "en", messages: tree, onError: () => {} }).markup as unknown as (
        key: string,
        values: Record<string, unknown>,
      ) => string;
    const english = markup(messages);
    const accented = markup(pseudo);
    const lost: string[] = [];
    for (const [key, text] of leaves(messages)) {
      const values: Record<string, unknown> = {};
      [...new Set(text.match(/\w+/g))].forEach((name, n) => (values[name] = 9000 + n));
      for (const [, tag] of text.matchAll(/<(\w+)>/g)) values[tag] = (chunks: string) => chunks;
      const shown = (s: string) => (s.match(/9\d{3}/g) ?? []).sort().join();
      if (shown(english(key, values)) !== shown(accented(key, values))) lost.push(key);
    }
    expect(lost).toEqual([]);
  });
});
