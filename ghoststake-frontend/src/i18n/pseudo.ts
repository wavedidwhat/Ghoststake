/**
 * A pseudo-locale: every message's text accented, lengthened and bracketed,
 * with its ICU syntax left exactly as it was (GHO-120).
 *
 * "Connect wallet" becomes "[Çöññéçţ ŵåļļéţ ·····]". Run the app with it and
 * three kinds of fault show on sight:
 *
 * - English that is still plain English was never moved to the catalog: the
 *   lint rule cannot see copy in `.ts` files, and this can.
 * - A bracket that is missing its partner was cut off by a layout that
 *   cannot grow. Real translations run 30–40% longer than English.
 * - Accents that render as boxes are a font without the glyphs.
 *
 * Switched on per request by `GHOSTSTAKE_PSEUDO=1` on the server (see
 * `request.ts`), so the same build can show it without a rebuild. Copy read
 * straight from `en.json` outside React — the link-preview image, the PWA
 * manifest, the wallet's app description, the crash page — stays English:
 * those have no request to ask.
 */

const ACCENTS: Record<string, string> = {
  a: "å", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ",
  m: "ɱ", n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "ü", v: "ṽ", w: "ŵ", x: "ẋ",
  y: "ý", z: "ž", A: "Å", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ",
  K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ",
  W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

const BRANCHING = new Set(["plural", "select", "selectordinal"]);

/** One message, text transformed, syntax untouched. */
export function pseudoMessage(message: string): string {
  let i = 0;
  let letters = 0;

  // Text up to the end, or up to the `}` that closes a plural/select branch.
  function text(inBranch: boolean): string {
    let out = "";
    while (i < message.length) {
      const c = message[i];
      if (c === "}" && inBranch) return out;
      if (c === "{") {
        out += argument();
        continue;
      }
      if (c === "<") {
        // A rich-text tag, `<lead>` or `</lead>`: its name is code.
        const end = message.indexOf(">", i);
        out += message.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === "'" || c === "#") {
        // ICU's escape character, and the plural count: both are syntax.
        out += c;
        i++;
        continue;
      }
      if (/[A-Za-z]/.test(c)) letters++;
      out += ACCENTS[c] ?? c;
      i++;
    }
    return out;
  }

  // From `{` to its matching `}`.
  function argument(): string {
    const start = i;
    i++; // {
    const head = readUntil(/[,}]/);
    if (message[i] === "}") {
      i++;
      return message.slice(start, i);
    }
    i++; // ,
    const type = readUntil(/[,}]/).trim();
    if (!BRANCHING.has(type)) {
      // `{n, number}` or `{d, date, short}`: all syntax, copied as it is.
      let depth = 1;
      while (i < message.length && depth > 0) {
        if (message[i] === "{") depth++;
        if (message[i] === "}") depth--;
        i++;
      }
      return message.slice(start, i);
    }
    let out = `{${head},${message.slice(start + head.length + 2, i)}`;
    // Selectors (`one`, `=0`, `other`, `offset:1`) are syntax; the text in
    // each branch is not.
    while (i < message.length && message[i] !== "}") {
      if (message[i] === "{") {
        i++;
        out += `{${text(true)}}`;
        i++; // }
      } else {
        out += message[i];
        i++;
      }
    }
    i++; // closing }
    return `${out}}`;
  }

  function readUntil(stop: RegExp): string {
    const from = i;
    while (i < message.length && !stop.test(message[i])) i++;
    return message.slice(from, i);
  }

  const body = text(false);
  // A message with no words, like "{text}" or "404", is left alone: brackets
  // around a value that is not copy would be noise.
  if (letters === 0) return body;
  return `[${body} ${"·".repeat(Math.max(2, Math.ceil(letters * 0.35)))}]`;
}

type Tree = { [key: string]: string | Tree };

/** The whole catalog, pseudo-localised. Same shape, same keys. */
export function pseudoCatalog<T extends Tree>(tree: T): T {
  return Object.fromEntries(
    Object.entries(tree).map(([key, value]) => [
      key,
      typeof value === "string" ? pseudoMessage(value) : pseudoCatalog(value),
    ]),
  ) as T;
}
