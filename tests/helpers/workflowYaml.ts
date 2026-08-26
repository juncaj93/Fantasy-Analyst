/**
 * Enough of YAML to ask questions of this repository's workflow files.
 *
 * Not a general parser, and not trying to be: it reads the subset GitHub
 * Actions files are written in — nested maps, block sequences, flow sequences,
 * quoted scalars and `|` block scalars — and nothing else. Anchors, multi-line
 * flow collections, tags and documents are not supported, because none of the
 * eight workflows uses them.
 *
 * It exists because the alternative is regex. `workflows.playwrightImage.test.ts`
 * matches container tags with one, and for a single pinned string that is fine.
 * The release path needs to assert *shape* — that Deploy has no `push:` trigger
 * at all, that Rollback's revision input is `required: true`, that Smoke takes
 * an expected revision — and a regex that answers those questions is a regex
 * that will keep answering them after the structure around it has changed. The
 * questions are structural, so the reading has to be too.
 *
 * `parseWorkflowYaml` is checked against a fixture of its own in
 * `release.workflows.test.ts`, and against all eight real files, so a parser
 * that quietly stopped understanding something would be caught by the same
 * suite that depends on it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

/** Strips comments and blank lines, and records each line's indentation. */
function significantLines(source: string): Line[] {
  const out: Line[] = [];
  for (const raw of source.split('\n')) {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') continue;
    out.push({ indent: withoutComment.match(/^ */)![0].length, text: withoutComment.trimEnd() });
  }
  return out;
}

/**
 * A `#` starts a comment unless it is inside quotes or immediately follows a
 * non-space — `foo#bar` is a value, `foo #bar` is a value and a comment.
 */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i);
  }
  return line;
}

function scalar(text: string): YamlValue {
  const value = text.trim();
  if (value === '') return '';
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => scalar(item));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** True for `|`, `|-`, `>`, `>-` and friends — the value is the block below. */
function isBlockScalar(text: string): boolean {
  return /^[|>][+-]?\d*$/.test(text.trim());
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  if (start >= lines.length) return [null, start];
  return lines[start]!.text.trimStart().startsWith('- ') || lines[start]!.text.trim() === '-'
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    const body = line.text.trimStart();
    if (!body.startsWith('-')) break;
    const rest = body.slice(1).trim();
    if (rest === '') {
      // `-` on its own: the item is the block indented beneath it.
      const [value, next] = i + 1 < lines.length && lines[i + 1]!.indent > indent
        ? parseBlock(lines, i + 1, lines[i + 1]!.indent)
        : [null as YamlValue, i + 1];
      items.push(value);
      i = next;
      continue;
    }
    // `- key: value` opens a mapping whose indentation starts at the key, and
    // whose later keys line up with it rather than with the dash.
    const keyed = rest.match(/^([^\s:][^:]*):(\s.*)?$/);
    if (keyed) {
      // The mapping starts where the key does — past the dash and the space
      // after it, which is exactly what `slice(1).trim()` removed.
      const innerIndent = line.indent + (body.length - rest.length);
      const synthesized: Line[] = [{ indent: innerIndent, text: ' '.repeat(innerIndent) + rest }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= innerIndent) {
        synthesized.push(lines[j]!);
        j++;
      }
      const [value] = parseMapping(synthesized, 0, innerIndent);
      items.push(value);
      i = j;
      continue;
    }
    items.push(scalar(rest));
    i++;
  }
  return [items, i];
}

function parseMapping(lines: Line[], start: number, indent: number): [{ [key: string]: YamlValue }, number] {
  const map: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const body = lines[i]!.text.trimStart();
    const match = body.match(/^([^\s:][^:]*):(?:\s+(.*))?$/);
    if (!match) break;
    const key = match[1]!.trim().replace(/^["']|["']$/g, '');
    const inline = (match[2] ?? '').trim();
    i++;

    if (inline !== '' && !isBlockScalar(inline)) {
      map[key] = scalar(inline);
      continue;
    }
    if (isBlockScalar(inline)) {
      // A run of more-indented lines, kept verbatim: `run:` steps are shell,
      // and shell is worth reading as text rather than as YAML.
      const blockIndent = i < lines.length ? lines[i]!.indent : indent + 1;
      const collected: string[] = [];
      while (i < lines.length && lines[i]!.indent > indent) {
        collected.push(lines[i]!.text.slice(blockIndent));
        i++;
      }
      map[key] = collected.join('\n');
      continue;
    }
    if (i < lines.length && lines[i]!.indent > indent) {
      const [value, next] = parseBlock(lines, i, lines[i]!.indent);
      map[key] = value;
      i = next;
      continue;
    }
    // A sequence may sit at the same indentation as its key.
    if (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.trimStart().startsWith('- ')) {
      const [value, next] = parseSequence(lines, i, indent);
      map[key] = value;
      i = next;
      continue;
    }
    map[key] = null;
  }
  return [map, i];
}

export function parseWorkflowYaml(source: string): Record<string, YamlValue> {
  const lines = significantLines(source);
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0]!.indent);
  return (value ?? {}) as Record<string, YamlValue>;
}

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * A workflow, parsed, plus its raw text.
 *
 * The text is kept because some assertions are genuinely about wording — the
 * `::error::` a step prints, the shape of a shell guard — and reparsing shell
 * out of a block scalar to assert on it would be pretending to a structure it
 * does not have.
 */
export function readWorkflow(name: string): { yaml: Record<string, YamlValue>; text: string } {
  const text = readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
  return { yaml: parseWorkflowYaml(text), text };
}

/** `triggers(wf)` — the event names, with YAML's `on:`/`true` quirk handled. */
export function triggers(yaml: Record<string, YamlValue>): Record<string, YamlValue> {
  // `on` is a YAML 1.1 boolean, and some parsers key it as `true`. Ours does
  // not, but reading both costs a line and removes a way to be quietly wrong.
  const on = (yaml['on'] ?? yaml['true']) as YamlValue;
  if (on === null || on === undefined) return {};
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [String(event), null]));
  return on as Record<string, YamlValue>;
}

/** The steps of one job, as a list of maps. */
export function steps(yaml: Record<string, YamlValue>, job: string): Record<string, YamlValue>[] {
  const jobs = (yaml['jobs'] ?? {}) as Record<string, YamlValue>;
  const one = (jobs[job] ?? {}) as Record<string, YamlValue>;
  return ((one['steps'] ?? []) as YamlValue[]) as Record<string, YamlValue>[];
}
