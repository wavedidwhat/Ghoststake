/**
 * One value from a Next `searchParams` entry.
 *
 * `?address=a&address=b` arrives as an array. Taking the first rather than
 * joining keeps an attacker-crafted link from producing an address string the
 * page would render and query that no one typed.
 */
export function singleParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first : undefined;
}
