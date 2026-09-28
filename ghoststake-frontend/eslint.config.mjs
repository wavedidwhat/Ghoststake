import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * UI copy belongs in messages/en.json, not inline (GHO-115).
 *
 * `jsx-no-literals` catches text between tags. It is told to ignore props,
 * because most props are `className` and `href`, so props are matched two
 * other ways: by name, for the ones that always carry words, and by shape —
 * a capital, then a space — for the rest. The name list alone missed
 * `what=` and `empty=` on its first run, and a list will always trail the
 * components; the shape check is what covers the next one.
 *
 * Punctuation, whitespace and the brand name are allowed: they are layout,
 * not copy, and flagging `{" "}` would bury the real findings.
 */
const COPY_PROPS = "aria-label|alt|title|subtitle|placeholder|eyebrow|label|hint|description";

const noInlineCopy = (level) => ({
  "react/jsx-no-literals": [
    level,
    {
      noStrings: true,
      ignoreProps: true,
      allowedStrings: [" ", "·", "—", "–", "…", "/", "%", "(", ")", ":", ",", ".", "+", "→", "←", "↗", "×", "GhostStake"],
    },
  ],
  "no-restricted-syntax": [
    level,
    {
      // A word, not a format hint: "0x…" and "0.00" are placeholders that
      // show a shape, and every language writes them the same way.
      selector: `JSXAttribute[name.name=/^(${COPY_PROPS})$/] > Literal[value=/[A-Za-z]{2,}/]`,
      message: "User-facing text belongs in messages/en.json; read it with t().",
    },
    {
      selector: `JSXAttribute[name.name!=/^(className|${COPY_PROPS})$/] > Literal[value=/^[A-Z][a-z'’]*\\s+\\S/]`,
      message: "This prop reads like a sentence. User-facing text belongs in messages/en.json.",
    },
  ],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/**/__tests__/**", "src/app/e2e/**"],
    // An error everywhere since GHO-120, when the last screen moved. It was a
    // warning with an error list of migrated files while the move was under
    // way, so a migrated screen could not slip back.
    rules: noInlineCopy("error"),
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
