/**
 * Round 30, item 5: say it once, plainly.
 *
 * Round 29 audit (S3, S4, S8): one Doubtful player read "D", "OUT", "who is
 * Out" and "Out" depending on the screen; every player card carried a
 * "Not known yet" line; developer text showed on Matchup, Data health and
 * Review. Doubtful counts as Out, so it now reads Out (chip: OUT) on every
 * in-season screen. The draft board keeps Sleeper's own letter.
 */

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InjuryTag } from '../src/web/components/common.tsx';
import { injuryLetter as chipLetter } from '../src/web/components/chipPicker.tsx';
import { injuryLetter as waiverLetter } from '../src/web/waiverCard.ts';
import { availabilityPenalty } from '../src/core/injury/startsit.ts';
import { availabilityConfidence } from '../src/core/startsit/availabilityConfidence.ts';
import { DESIGNATION_CODE, DESIGNATION_LABEL, NO_INJURY_INFORMATION } from '../src/core/injury/model.ts';

const tag = (status: string, draft = false) => renderToStaticMarkup(createElement(InjuryTag, { status, draft }));

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('Doubtful reads Out everywhere in season', () => {
  it('the row chip on Team, Compare and Players says OUT, as Matchup does', () => {
    expect(tag('Doubtful')).toContain('>OUT<');
    expect(tag('Out')).toContain('>OUT<');
    expect(tag('Questionable')).toContain('>Q<');
  });

  it('the draft board keeps Sleeper’s letter', () => {
    expect(tag('Doubtful', true)).toContain('>D<');
  });

  it('the Compare and Waivers chips say OUT for Doubtful and Out alike', () => {
    expect(chipLetter('Doubtful')).toBe('OUT');
    expect(chipLetter('Out')).toBe('OUT');
    expect(waiverLetter('Doubtful')).toBe('OUT');
    expect(waiverLetter('Out')).toBe('OUT');
  });

  it('an empty slot whose player is Doubtful says he is out', () => {
    expect(read('src/core/startsit/lineup.ts')).toMatch(/raw === 'doubtful' \? 'out'/);
  });

  it('the start/sit label, the player page and the availability line say Out', () => {
    const doubtful = { ...NO_INJURY_INFORMATION, designation: 'doubtful' as const };
    const penalty = availabilityPenalty(doubtful);
    expect(penalty.display).toMatch(/^Out\b/);
    expect(penalty.note).not.toMatch(/doubtful/i);
    expect(DESIGNATION_LABEL.doubtful).toBe('Out');
    expect(DESIGNATION_CODE.doubtful).toBe('OUT');
    const view = availabilityConfidence(doubtful);
    expect(`${view.label} ${view.detail}`).not.toMatch(/doubtful/i);
  });
});

describe('no standing disclaimers or developer text', () => {
  it('no "Not known yet" line on the player card', () => {
    expect(read('src/web/components/weekly.tsx')).not.toMatch(/Not known yet/);
  });

  it('no model name or simulation count on Matchup', () => {
    const matchup = read('src/web/screens/MatchupScreen.tsx');
    expect(matchup).not.toMatch(/simulated\s+afternoons/);
    expect(matchup).not.toMatch(/Model \{forecast\.modelVersion\}/);
  });

  it('no file path on Data health, no thresholds on Review, no schema talk on Setup', () => {
    expect(read('src/core/health/quota.ts')).not.toMatch(/docs\/DATA_HEALTH\.md\./);
    expect(read('src/web/screens/ReviewScreen.tsx')).not.toMatch(/non-mixed|≥0\.6/);
    expect(read('src/server/services/playerDetailService.ts')).not.toMatch(/'[^'\n]*GraphQL schema/);
  });
});
