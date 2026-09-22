// Runs a command with the variables in an env file set, overriding whatever
// the shell or a .env file would have supplied (GHO-87).
//
//   node scripts/with-env.mjs tests/e2e.env next build
//
// Not `node --env-file`: Next copies the parent's execArgv into NODE_OPTIONS
// for its build workers, and Node refuses --env-file there, so the build dies
// before it starts. Not `process.loadEnvFile` either: it will not override a
// variable that is already set, and overriding is the point — a developer's
// .env.local must not leak real addresses into the test build.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const [file, command, ...args] = process.argv.slice(2);
if (!file || !command) {
  console.error("usage: with-env.mjs <env-file> <command> [args...]");
  process.exit(2);
}

const vars = parseEnv(readFileSync(file, "utf8"));
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: { ...process.env, ...vars },
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
