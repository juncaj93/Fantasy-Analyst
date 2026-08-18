-- Height, weight, age and experience: stored, and almost never shown.
--
-- Sleeper publishes all four for every player and this app has been discarding
-- them on every sync. They are the most tempting bad inputs in the dataset --
-- objective, complete, numeric, and explanatory of very little. A 5'9"
-- receiver is not worse than a 6'3" one; a 29-year-old back is not finished.
--
-- They are stored anyway, because a handful of genuine conjunctions cannot be
-- expressed without them: a light frame projected into an outside role, an
-- unusually large receiving back, an older back whose usage is falling. Those
-- are questions worth asking and none of them can be asked from a position and
-- a name.
--
-- What stops this becoming a body-type column is enforced in code rather than
-- here: `core/players/profileFlags.ts` fires only where a measurement meets a
-- role it is in tension with, returns `weight: 'context'` and `scoreDelta: 0`,
-- and sets `showMeasurements` false unless a flag actually fired. Nothing may
-- turn any of these numbers into a ranking penalty.
--
-- NULL means Sleeper did not say. It never becomes a zero: a receiver of
-- unknown weight is not a receiver weighing nothing, and a rookie flag keyed on
-- `years_exp === 0` must not fire for a player whose experience is unrecorded.
--
-- Written with line comments only, like every migration here -- see 0013.

-- Inches, as a whole number. Sleeper sends either `"71"` or `"5'11\""`, and
-- `parseHeight` in core normalises both on the way in.
ALTER TABLE players ADD COLUMN height_inches INTEGER;

-- Pounds.
ALTER TABLE players ADD COLUMN weight_pounds INTEGER;

-- Years, as Sleeper reports it. Not derived from a birth date, because Sleeper
-- publishes the age directly and computing it from a date this app does not
-- store would be a second source of the same fact that could disagree.
ALTER TABLE players ADD COLUMN age INTEGER;

-- Completed NFL seasons. 0 is a rookie and is meaningful -- which is exactly
-- why NULL has to stay distinguishable from it.
ALTER TABLE players ADD COLUMN years_exp INTEGER;
