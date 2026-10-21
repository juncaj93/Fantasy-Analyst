/**
 * Every word the app shows is spelled the American way.
 *
 * The league is a US league and Alex reads American English, so "practise",
 * "defence" and "favourite" on a card read as mistakes. They crept in through
 * engine notes as much as through the screens, so this reads every string the
 * code can hand to a person: string and template literals and JSX text across
 * `src`, plus the visible text of the stylesheet and the page shell.
 *
 * Comments and identifiers are not read. `DEFENCE_POSITIONS` and a doc comment
 * about the defence planner never reach a screen, and renaming them would be
 * churn with no reader. Code values that happen to be strings (a union member,
 * a request field) are the allowlist below, each with its reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/** The development server and its seed data are never deployed. */
const SKIPPED_DIRS = new Set([join(SRC, 'devserver')]);

const BRITISH = new RegExp(
  [
    'practis(?:e|es|ed|ing)\\b',
    '\\b(?:de|of)fences?\\b',
    '\\b(?:colour|favourit|behaviour|honour|neighbour|flavour|labour)\\w*',
    '\\b(?:centre|metre|theatre|fibre|litre)[sd]?\\b',
    // "analyses" is also the plural of analysis, so only the verb forms.
    'analys(?:e|ed|ing)\\b',
    '(?:organis|recognis|prioritis|optimis|summaris|customis|minimis|maximis|normalis|realis|apologis|utilis|categoris)(?:e|es|ed|er|ers|ing|ation|ations)\\b',
    '\\blicence\\b',
    '\\bcheques?\\b',
    '\\bprogrammes?\\b',
    '\\b(?:catalogue|dialogue)s?\\b',
    '(?:travell|cancell|labell|modell|signall)(?:ed|ing)\\b',
    '\\bfuelled\\b',
    '\\bcounsellors?\\b',
    '\\bgrey(?:ed)?\\b',
    '\\bjudgements?\\b',
    '\\bageing\\b',
    '\\blearnt\\b',
    '\\bwhilst\\b',
    '\\bamongst\\b',
    '\\bfulfil\\b',
    '\\benrol\\b',
    '\\bper cent\\b',
    '\\bmaths\\b',
    '\\bfixtures?\\b',
  ].join('|'),
  'i',
);

/**
 * Strings that must keep a British spelling, matched exactly. Each is a code
 * value, never text a person reads.
 */
const ALLOWED: Record<string, string> = {
  not_practising: 'practice-trend code; the screens show the label beside it',
  favourite: 'posture code sent to /api/startsit/compare; never rendered',
  substantial_favourite: 'mode-suggestion state code; never rendered',
  defence_planner: 'pickup audit status code for the support snapshot; never rendered',
  'fixture-chip': 'CSS class name and test id on the Team screen',
  'fixture-chip-verdict': 'test id on the Team screen',
  fixtures: 'a support snapshot field name, the test-data sense of the word',
  'demo fixtures': 'Demo Mode names its canned test data, not a game',
  'tests/fixtures/support': 'a directory path',
};

/** Files whose every "fixture" means canned test data, not a game. */
const FIXTURE_SENSE_FILES = new Set([
  'src/core/demo/fixtures/build.ts',
  'src/core/demo/fixtures/world.ts',
  'src/core/demo/runtime/handlers.ts',
  'src/core/newsletter/source.ts',
  'src/core/support/fixture.ts',
]);

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIPPED_DIRS.has(path)) filesUnder(path, out);
    } else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  word: string;
  text: string;
}

function stringsOf(file: string): { line: number; text: string }[] {
  const source = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    // Module paths are file names, not words.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function britishIn(file: string, strings: { line: number; text: string }[]): Finding[] {
  const rel = relative(ROOT, file);
  const found: Finding[] = [];
  for (const { line, text } of strings) {
    const match = BRITISH.exec(text);
    if (!match) continue;
    if (ALLOWED[text.trim()] != null) continue;
    if (/^fixtures?$/i.test(match[0]) && (FIXTURE_SENSE_FILES.has(rel) || /demo fixture/i.test(text))) continue;
    found.push({ file: rel, line, word: match[0], text: text.trim().slice(0, 80) });
  }
  return found;
}

function report(found: Finding[]): string {
  return found.map((f) => `"${f.word}" in ${f.file}:${f.line} — ${JSON.stringify(f.text)}`).join('\n');
}

describe('American spelling in user-visible text', () => {
  it('no string in src uses a British spelling', () => {
    const found = filesUnder(SRC).flatMap((file) => britishIn(file, stringsOf(file)));
    expect(found, `British spelling shown to users; use the American form or allowlist a code value:\n${report(found)}`).toEqual([]);
  });

  it('no CSS content string or page-shell text uses one', () => {
    const css = join(SRC, 'web', 'styles.css');
    const cssStrings = [...readFileSync(css, 'utf8').matchAll(/content:\s*(['"])(.*?)\1/g)].map((m) => ({ line: 0, text: m[2]! }));
    const html = join(SRC, 'web', 'index.html');
    const shell = readFileSync(html, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '');
    const found = [...britishIn(css, cssStrings), ...britishIn(html, [{ line: 0, text: shell }])];
    expect(found, `British spelling shown to users:\n${report(found)}`).toEqual([]);
  });

  it('still catches the words it was written for', () => {
    for (const word of ['did not practise', 'a defence', 'Favourite', 'not recognised', 'greyed out', 'per cent', 'labelled']) {
      expect(BRITISH.test(word), word).toBe(true);
    }
    for (const word of ['did not practice', 'a defense', 'otherwise', 'precise', 'analyses', 'Greyson', 'DEF']) {
      expect(BRITISH.test(word), word).toBe(false);
    }
  });
});
