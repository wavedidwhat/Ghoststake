/**
 * The two palette values that have to exist outside CSS (GHO-58, GHO-59).
 *
 * Everything else reads a token from `globals.css`, and the design test fails
 * a component that hardcodes a hex. These two cannot: the browser reads
 * `themeColor` before any stylesheet to tint the status bar, and the manifest
 * is read by the operating system to paint a splash screen. Both would show a
 * white band above an olive app if they were missing.
 *
 * Keep in step with `--color-ground`.
 */
export const THEME_COLOR = "#0d0f0e";
export const BACKGROUND_COLOR = "#0d0f0e";
