/**
 * A projection this app estimated rather than priced, drawn so it cannot be
 * read as a negative number.
 *
 * It was a leading `~`, on the argument that a tilde was the one mark that
 * survives at 0.68rem. It did not survive the owner's phone: on 24 September
 * 2026 Drake Maye's `~21.7` on the Matchup screen was read as `-21.7`. At that
 * size a tilde is a short horizontal stroke, and a short horizontal stroke in
 * front of a number is a minus sign to anybody glancing.
 *
 * So the mark is a word. `EST`, in small capitals in the warning tone, is not a
 * glyph a number can carry, and it is the second signal the rule for colour
 * asks for: the word says it, the tone lets a glance find it. The dashed rule
 * stays on the figure, under the number only, as the corroboration it always
 * was. The claim in full is still the container's title and accessible name;
 * the tag is `aria-hidden` so a screen reader hears it once, in those words.
 *
 * `digits` is the caller's, because the rows and the Compare sheet differ. The
 * Matchup column is 42px, which fits `EST 22` and not `EST 21.7` — and a whole
 * number is the honest precision for a preseason season total over a full
 * season of games anyway. Compare has the room and keeps its tenth.
 */
export function Estimated({ value, digits }: { value: number; digits: 0 | 1 }) {
  return (
    <>
      <span className="est-tag" aria-hidden="true" data-testid="estimate-tag">
        est
      </span>
      <span className="est-value">{value.toFixed(digits)}</span>
    </>
  );
}
