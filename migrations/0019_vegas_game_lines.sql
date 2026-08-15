-- The game's own two numbers, which the app was already paying for.
--
-- Every event response from the odds provider carries its whole board: the
-- player props the app stores, and the game total and spread it did not. The
-- bill is one entity per event either way, so these have been bought and
-- discarded on every refresh since the Vegas pipeline was written.
--
-- Start/Sit needs them. A total and a spread imply a team total, and a team
-- total is the closest free thing to "how many chances will this offence get";
-- the spread on its own says which way the afternoon is likely to run, which
-- means opposite things to a running back and to a receiver. See
-- core/startsit/gameScript.ts.
--
-- Nullable, and nullable is the ordinary case rather than an error state: a
-- game the provider has not priced yet, or a provider that names its spread
-- field something this adapter does not read, both land here as NULL, and the
-- game-script component then contributes nothing and says "no game line". A
-- DEFAULT 0 would turn "unpriced" into "pick'em in a zero-point game", which is
-- a confident claim about a game nobody has quoted.

-- The over/under on the two teams' combined score.
ALTER TABLE vegas_events ADD COLUMN game_total REAL;

-- The handicap, and whose it is. Kept as a (team, number) pair rather than as
-- "the home spread", because "home" is a position in somebody else's payload
-- and the sign of a spread is the one thing that must never be inferred: a
-- game-script model fed a handicap backwards is worse than one fed nothing.
-- Reading it for the other team is a negation against a team code that is
-- stored, not against a column order that is assumed.
ALTER TABLE vegas_events ADD COLUMN spread REAL;
ALTER TABLE vegas_events ADD COLUMN spread_team TEXT;

-- When these two numbers were last seen, which is not the same as when the
-- event row was last touched: a refresh that finds no game lines must not make
-- last week's spread look current.
ALTER TABLE vegas_events ADD COLUMN lines_seen_at TEXT;
