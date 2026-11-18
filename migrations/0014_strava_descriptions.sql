-- Songs in the Strava description: after each run or ride with music, a short
-- line of what played and a link back to it in Cadence, for those who ask.
--   strava_write                whether Strava last granted activity:write
--   strava_descriptions         whether they asked for it
--   strava_descriptions_since   only activities that start after this are written
ALTER TABLE users ADD COLUMN strava_write INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN strava_descriptions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN strava_descriptions_since INTEGER;
-- When this run or ride's description was written, so it is written once.
ALTER TABLE runs ADD COLUMN described_at INTEGER;
