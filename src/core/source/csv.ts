/**
 * Reading a handful of named columns out of somebody else's very large CSV.
 *
 * ## Why this is not `parseCsv`
 *
 * `core/adp/import.ts` has a correct RFC4180 parser that builds every field of
 * every row. It is the right tool for a file a human uploaded and the wrong one
 * for a published release asset: the 2025 weekly-stats file is 8.3MiB across 150
 * columns, and building all of it costs more than a Workers invocation is
 * allowed in total. Every file this module is pointed at wants between three and
 * fourteen columns, so the work that matters is *skipping* — moving the cursor
 * to the next delimiter without materialising anything between them.
 *
 * ## Why it cannot split on commas
 *
 * Every nflverse file this app reads embeds quoted commas. In the weekly-stats
 * file 19,394 of 19,422 lines contain one, because `headshot_url` carries
 * `f_auto,q_auto` inside quotes and a display name may too (`"Kenneth Murray,
 * Jr."`). A naive `split(',')` yields 151 fields where the header has 150 and
 * shifts every column after index 5 — and not uniformly, which is the dangerous
 * part: a fixed `+1` correction silently corrupts the rows with two quoted
 * commas and the rows with none. Silent corruption of a usage series is worse
 * than no usage series, so every field is read quote-aware.
 *
 * This file was extracted from `core/usage/nflverse.ts`, which measured and
 * tuned it against the live weekly-stats file, when the roster, depth-chart and
 * snap-count parsers arrived and would otherwise have been a third, fourth and
 * fifth copy of it. The behaviour is unchanged; `core/usage/nflverse.ts`
 * re-exports it so its own callers and tests still import it from where it
 * was born.
 */

/**
 * Read the requested column values out of one line, quote-aware, in one pass.
 *
 * ## The bug this signature exists to prevent
 *
 * The single pass can only move forwards, so it must be given its column
 * indices in ascending order. The prototype was handed `[0, 2, 3, 7, 10, 45,
 * 32, 44]` — the natural order of the fields as a human lists them — matched up
 * to 45, and could then never match 32 or 44 again. `carries` and `receptions`
 * came back as empty strings with no error at all: a usage series that is
 * quietly always zero.
 *
 * So the sort happens **here**, and the results are mapped back into the
 * caller's order. A caller cannot reintroduce the bug by listing its columns in
 * a readable order, which is the only way it was ever going to come back.
 */
export function extractFields(line: string, indices: readonly number[]): string[] {
  /*
   * A column the header does not have is asked for as -1, and is dropped here
   * rather than searched for.
   *
   * It cannot simply be sorted with the rest: -1 sorts first, never matches a
   * field index, and — because the scan only moves forwards — the cursor would
   * wait for it forever and return an empty string for *every* column. One
   * absent column would silently empty the whole row, which is precisely the
   * class of failure the sort above exists to prevent.
   */
  const order = indices
    .map((column, position) => ({ column, position }))
    .filter((entry) => entry.column >= 0)
    .sort((a, b) => a.column - b.column);
  const out: string[] = new Array(indices.length).fill('');

  let want = 0;
  let field = 0;
  let start = 0;
  let quoted = false;
  const end = line.length;

  for (let i = 0; i <= end && want < order.length; i++) {
    // Past the last character, the end of the line terminates the final field.
    const ch = i === end ? ',' : line[i]!;
    if (quoted) {
      // A doubled quote inside a quoted field closes and reopens, which lands
      // in the same state — correct for finding delimiters, and the escape is
      // undone in `unquote` where the value is actually built.
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch !== ',') continue;

    // `while` rather than `if`: a caller may ask for the same column twice.
    while (want < order.length && order[want]!.column === field) {
      out[order[want]!.position] = unquote(line.slice(start, i));
      want++;
    }
    field++;
    start = i + 1;
  }

  return out;
}

/** A field may or may not be quoted, so strip only what is actually there. */
export function unquote(raw: string): string {
  // CRLF would leave a stray carriage return on the last field. These files ship
  // LF today; costing one character test to survive the day they do not.
  const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value;
}

/**
 * The header line's column names, lowercased and trimmed, in file order.
 *
 * Read from the header rather than assumed by position, in every parser here:
 * column indices are not stable across seasons, these are somebody else's
 * files, and a column inserted in the middle must not silently shift every
 * value by one. nflverse has done exactly that twice in the seasons this app
 * has been reading them.
 */
export function headerIndex(headerLine: string): Map<string, number> {
  const names: string[] = [];
  let field = '';
  let quoted = false;
  const line = headerLine.endsWith('\r') ? headerLine.slice(0, -1) : headerLine;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      names.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  names.push(field);

  const at = new Map<string, number>();
  // First occurrence wins. A duplicated column name is a source fault, and
  // taking the later one would quietly change which field a name refers to.
  names.forEach((name, index) => {
    const key = name.trim().toLowerCase().replace(/^﻿/, '');
    if (!at.has(key)) at.set(key, index);
  });
  return at;
}

/**
 * A number, or null when the source left the field blank.
 *
 * Blank is not zero anywhere in this codebase and the distinction is load
 * bearing: a receiver with no target-share value is a receiver whose share is
 * not known, and writing 0 for him would invent the strongest possible evidence
 * of a collapsed role out of a missing field.
 */
export function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === '' || text.toUpperCase() === 'NA') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An integer, under the same blank-is-not-zero rule. */
export function int(raw: string | undefined): number | null {
  const value = num(raw);
  return value == null ? null : Math.trunc(value);
}

/** A trimmed string, or null when blank — never the empty string. */
export function text(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return value === '' || value.toUpperCase() === 'NA' ? null : value;
}
