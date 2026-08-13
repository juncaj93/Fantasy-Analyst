-- The recent-evidence window becomes 30 days.
--
-- Twenty-one days was arbitrary. Thirty is the window trade decisions are
-- actually made on, and one recent window shared by every mode beats two that
-- nearly agree. The stored values stay valid: they are a derived cache, and the
-- next aggregation rewrites them against the new window.

ALTER TABLE player_signal_cache RENAME COLUMN recent21_net TO recent30_net;
ALTER TABLE player_signal_cache RENAME COLUMN recent21_items TO recent30_items;
