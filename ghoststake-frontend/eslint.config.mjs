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
      allowedStrings: [" ", "·", "—", "–", "…", "/", "%", "(", ")", ":", ",", ".", "→", "←", "↗", "GhostStake"],
    },
  ],
  "no-restricted-syntax": [
    level,
    {
      selector: `JSXAttribute[name.name=/^(${COPY_PROPS})$/] > Literal[value=/[A-Za-z]/]`,
      message: "User-facing text belongs in messages/en.json; read it with t().",
    },
    {
      selector: `JSXAttribute[name.name!=/^(className|${COPY_PROPS})$/] > Literal[value=/^[A-Z][a-z'’]*\\s+\\S/]`,
      message: "This prop reads like a sentence. User-facing text belongs in messages/en.json.",
    },
  ],
});

/**
 * Files whose copy has moved to the catalog, where inline text is now an
 * error. Everything else warns until its screen is migrated; add the file
 * here in the PR that migrates it, and once every file is listed the
 * split goes and the rule is an error everywhere.
 */
const MIGRATED = ["src/app/not-found.tsx", "src/app/error.tsx", "src/app/global-error.tsx"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/**/__tests__/**", "src/app/e2e/**"],
    rules: noInlineCopy("warn"),
  },
  { files: MIGRATED, rules: noInlineCopy("error") },
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
