/**
 * Where a walker is in a value, kept as a chain and written out only when
 * something is reported there (Round 34).
 *
 * The snapshot checks (`findRedactionViolations`, `findLossyValues`,
 * `SnapshotAliases.leaks`) visit every node of a file that can hold forty
 * thousand strings, and building each node's path as a string was a large
 * part of what a capture cost, for paths that are almost never printed. The
 * text written out is exactly the text the walkers built before: `a.b`, `a[0]`,
 * and a bare key at the root.
 */

export type PathRef = string | { readonly up: PathRef; readonly key: string } | { readonly up: PathRef; readonly index: number };

export function pathOf(ref: PathRef): string {
  if (typeof ref === 'string') return ref;
  const at = pathOf(ref.up);
  return 'key' in ref ? (at === '' ? ref.key : `${at}.${ref.key}`) : `${at}[${ref.index}]`;
}
