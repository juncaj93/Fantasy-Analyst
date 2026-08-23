-- Rotowire's published weekly projections, as distributed by Sleeper.
--
-- Display-only data: it fills the projection column on Team when no betting
-- market has priced a player, and it is read by nothing that ranks, simulates or
-- recommends. See core/startsit/projection.ts for the rule and the reason.
--
-- All three published totals are stored on one row rather than one row per
-- scoring format. The feed hands over std, half-PPR and PPR together, which
-- league a deployment is serving can change, and storing the pair we happen to
-- need today means re-fetching the whole week to answer a different league
-- tomorrow. Each is nullable because a row can carry some and not others.
--
-- `publisher` is recorded rather than assumed. Every row this app has read says
-- `rotowire`, and the day that changes is a day the screen's label is wrong —
-- which is only detectable if the answer was written down.
create table if not exists sleeper_weekly_projections (
  season text not null,
  week integer not null,
  player_id text not null,
  pts_std real,
  pts_half_ppr real,
  pts_ppr real,
  publisher text,
  fetched_at text not null,
  primary key (season, week, player_id)
);

-- The one query this table answers: every stored figure for one week, which the
-- lineup route then narrows to the roster in memory. The primary key's leading
-- columns already serve it, so there is no second index here on purpose.
