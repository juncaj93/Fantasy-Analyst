-- League status, so the app can tell a drafted league from a playing one.
--
-- Sleeper reports `status` on the league itself -- pre_draft, drafting,
-- in_season, complete -- and it is the second witness the Draft tab's
-- visibility is decided from, behind /state/nfl. Nullable because every league
-- already stored predates this column, and an unknown status is read as
-- "not known", never as "not in season".

ALTER TABLE leagues ADD COLUMN status TEXT;
