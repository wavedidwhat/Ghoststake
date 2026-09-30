import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { locales } from "@/i18n/locale";

/**
 * Every catalog besides English (GHO-128).
 *
 * English is the source: it types every key, and the other catalogs are laid
 * over it at runtime, so a missing string shows in English. That keeps a
 * gap from rendering as a raw key, but it also hides the gap, so the tests
 * here are what keep a translation complete and structurally the same.
 *
 * "Structurally the same" is the part a reviewer can't see. A translated
 * sentence that dropped `{amount}` still reads fine, just without the
 * number; one that renamed `<figure>` loses its styling; one that answers a
 * `select` with a branch English doesn't have renders the fallback. None of
 * those throw.
 */

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out.set(`${prefix}${key}`, value);
    else for (const [k, v] of leaves(value, `${prefix}${key}.`)) out.set(k, v);
  }
  return out;
}

const DIR = join(__dirname, "../../../messages");
const source = leaves(en);
const others = locales.filter((l) => l !== "en");

/** Arguments, tags and select branches: what a translation must keep. */
function shape(elements: MessageFormatElement[], out = new Set<string>()): Set<string> {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        out.add(`arg:${el.value}`);
        break;
      case TYPE.tag:
        out.add(`tag:${el.value}`);
        shape(el.children, out);
        break;
      case TYPE.select:
        out.add(`arg:${el.value}`);
        for (const [option, { value }] of Object.entries(el.options)) {
          out.add(`select:${el.value}=${option}`);
          shape(value, out);
        }
        break;
      case TYPE.plural:
        // Plural categories differ by language (Chinese has only "other"),
        // so only the argument is compared, and "other" is required below.
        out.add(`arg:${el.value}`);
        for (const { value } of Object.values(el.options)) shape(value, out);
        break;
    }
  }
  return out;
}

function pluralsWithoutOther(elements: MessageFormatElement[]): string[] {
  const found: string[] = [];
  for (const el of elements) {
    if (el.type === TYPE.plural) {
      if (!("other" in el.options)) found.push(el.value);
      for (const { value } of Object.values(el.options)) found.push(...pluralsWithoutOther(value));
    } else if (el.type === TYPE.select) {
      for (const { value } of Object.values(el.options)) found.push(...pluralsWithoutOther(value));
    } else if (el.type === TYPE.tag) {
      found.push(...pluralsWithoutOther(el.children));
    }
  }
  return found;
}

/**
 * Strings that are the same in every language: the brand, tickers, symbols
 * and other proper nouns, and messages that are only an argument. Anything
 * else identical to English is almost certainly untranslated.
 */
function sameEverywhere(text: string): boolean {
  const words = text.replace(/\{[^}]*\}|<\/?[a-z]+>/gi, "").replace(/[^A-Za-z]+/g, " ").trim();
  if (words === "") return true;
  return /^(GhostStake|Chainlink|Robinhood( Chain)?|mUSDC|USDC|ETH|TSLA|AMZN|AMD|PLTR|NFLX|UTC|APR|LTV|ICU|Blockscout|Etherscan|Coinbase( Wallet)?|WalletConnect|MetaMask|Tesla|Amazon|Palantir|Netflix|OK|x|gsCOL)( (GhostStake|Chainlink|mUSDC|USD|ETH|UTC|Chain))*$/.test(words);
}

/**
 * Words spelled the same in English and in that language, so a translation
 * that matches English is correct rather than forgotten. Kept per language
 * and short on purpose: every entry is a claim a reviewer can check.
 */
const COGNATES: Partial<Record<(typeof locales)[number], string[]>> = {
  es: ["No", "no", "Total"],
  "pt-BR": ["Total", "Status"],
};

describe("the other catalogs", () => {
  it("covers every language the app offers, and nothing else", () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".json") && f !== "en.json" && f !== "descriptions.json")
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(files).toEqual([...others].sort());
  });

  describe.each(others)("%s", (locale) => {
    const catalog = leaves(JSON.parse(readFileSync(join(DIR, `${locale}.json`), "utf8")) as Tree);

    it("has every English key and no others", () => {
      const missing = [...source.keys()].filter((k) => !catalog.has(k));
      const extra = [...catalog.keys()].filter((k) => !source.has(k));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it("parses every message as ICU", () => {
      const invalid: string[] = [];
      for (const [key, text] of catalog) {
        try {
          parse(text);
        } catch (error) {
          invalid.push(`${key}: ${(error as Error).message}`);
        }
      }
      expect(invalid).toEqual([]);
    });

    it("keeps each message's arguments, tags and select branches", () => {
      const differ: string[] = [];
      for (const [key, text] of catalog) {
        const english = source.get(key);
        if (english === undefined) continue;
        let theirs: Set<string>;
        try {
          theirs = shape(parse(text));
        } catch {
          continue; // reported by the ICU test
        }
        const ours = shape(parse(english));
        const lost = [...ours].filter((x) => !theirs.has(x));
        const added = [...theirs].filter((x) => !ours.has(x));
        if (lost.length || added.length) differ.push(`${key}: lost [${lost}] added [${added}]`);
      }
      expect(differ).toEqual([]);
    });

    it("gives every plural an 'other' branch", () => {
      const bad: string[] = [];
      for (const [key, text] of catalog) {
        try {
          const missing = pluralsWithoutOther(parse(text));
          if (missing.length) bad.push(`${key}: ${missing}`);
        } catch {
          // reported by the ICU test
        }
      }
      expect(bad).toEqual([]);
    });

    it("has nothing left in English", () => {
      const untranslated = [...catalog]
        .filter(([key, text]) => text === source.get(key) && !sameEverywhere(text) && !COGNATES[locale]?.includes(text))
        .map(([key]) => key);
      expect(untranslated).toEqual([]);
    });

    /** The voice rule that holds in every language (GHO-122). */
    it("has no em or en dashes", () => {
      expect([...catalog].filter(([, text]) => /[—–]/.test(text)).map(([key]) => key)).toEqual([]);
    });
  });
});
