import { chainProblems } from "./chains";
import { envProblems, type ConfigProblem } from "./env";

/**
 * Everything wrong with the configuration this deployment was built with
 * (GHO-85). Empty on a healthy deployment.
 *
 * Its own module because the problems come from two: `env.ts` finds values
 * that do not parse, and `chains.ts` finds a chain id that parses but is not
 * supported. Anything that must not act on a placeholder — the root layout,
 * server-side chain reads — checks this.
 */
export const configProblems: readonly ConfigProblem[] = [...envProblems, ...chainProblems];

export const configured = configProblems.length === 0;
