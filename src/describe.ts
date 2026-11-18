// Songs in the Strava description. For those who turn it on, each run or ride
// with music gets a few lines added under whatever its description already
// says: the song they went fastest to, and a link
// that opens the activity in Cadence. Written once, after the songs settle,
// and never again, so later edits on Strava are left alone.

import { rankSongs, SETTLE_S, units } from './emails';
import { accessToken, setStravaDescription, Sport, stravaDescription } from './providers';
import { Budget, Env, now, RateLimited, User } from './util';

/** The short link written into descriptions; it opens the activity in the app. */
export const activityShortLink = (env: Env, origin: string, stravaId: number) => `${origin}${env.BASE_PATH}/a/${stravaId}`;

interface DueRun {
  run_id: number;
  strava_id: number;
  sport: Sport;
  distance_m: number;
}

// One of these leads each description, picked by the activity, so each run or ride wears a different one and a retry keeps it.
const MARKS = ['🎧', '🎵', '🎶', '🎸', '🥁', '🎤', '🎹', '🎷', '🎺', '📻', '🪩', '💿'];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The lines Cadence adds, for one run or ride. */
export async function descriptionLines(env: Env, origin: string, user: User & { email_units?: string | null }, run: DueRun): Promise<string | null> {
  const songs = (
    await env.DB.prepare(
      `SELECT rs.start_s, rs.end_s, rs.distance_m, rs.moving_s, t.name, t.artist, t.image
       FROM run_songs rs JOIN tracks t ON t.id = rs.track_id WHERE rs.run_id = ? ORDER BY rs.idx`,
    )
      .bind(run.run_id)
      .all<{ start_s: number; end_s: number; distance_m: number; moving_s: number; name: string; artist: string; image: string | null }>()
  ).results;
  if (!songs.length) return null;
  const u = units(user.units === 'mi' || user.units === 'km' ? user.units : user.email_units === 'mi' ? 'mi' : 'km');
  const { ranked, fastest } = rankSongs(songs);
  // Led by the fastest song; without one, by how many songs there were.
  const mark = MARKS[Math.abs(run.strava_id) % MARKS.length];
  const lead = fastest
    ? `${mark} ${run.sport === 'ride' ? 'Rode' : 'Ran'} fastest to ${fastest.name} by ${fastest.artist} (${u.rate(fastest.speed!, run.sport)})\n`
    : `${mark} ${plural(ranked.length, 'song')} over ${u.dist(run.distance_m)}. `;
  return `${lead}See where each song played on the map:\n${activityShortLink(env, origin, run.strava_id)}`;
}

/** Cron step: writes the songs into the Strava description of each new run or ride with music, for those who asked. */
export async function describeActivities(env: Env, origin: string): Promise<void> {
  const due = await env.DB.prepare(
    `SELECT r.id AS run_id, r.strava_id, r.sport, r.distance_m, u.* FROM runs r JOIN users u ON u.id = r.user_id
     WHERE u.is_demo = 0 AND u.strava_descriptions = 1 AND u.strava_write = 1
       AND r.described_at IS NULL AND r.stream_state = 'ok' AND r.matched_at IS NOT NULL
       AND r.start_time >= COALESCE(u.strava_descriptions_since, 0) AND r.start_time > ?1 - 2 * 86400
       AND r.start_time + r.elapsed_s < ?1 - ?2
       AND EXISTS (SELECT 1 FROM run_songs WHERE run_id = r.id)
     ORDER BY r.start_time LIMIT 5`,
  )
    .bind(now(), SETTLE_S)
    .all<User & DueRun & { email_units: string | null }>();
  // Each one costs a token refresh at most, a read and a write.
  const budget: Budget = { n: 20 };
  const done = (runId: number) => env.DB.prepare(`UPDATE runs SET described_at = ? WHERE id = ?`).bind(now(), runId).run();
  const lostPermission = (userId: number) => env.DB.prepare(`UPDATE users SET strava_write = 0 WHERE id = ?`).bind(userId).run();
  for (const row of due.results) {
    try {
      const lines = await descriptionLines(env, origin, row, row);
      if (!lines) {
        await done(row.run_id);
        continue;
      }
      const token = await accessToken(env, row.id, 'strava', budget);
      if (!token) continue;
      const current = await stravaDescription(token, row.strava_id, budget);
      if (current === 'gone') {
        await done(row.run_id);
        continue;
      }
      if (current === 'denied') {
        await lostPermission(row.id);
        continue;
      }
      // Already there (a write that landed before the row was marked): nothing to add.
      if (!current.includes(activityShortLink(env, origin, row.strava_id))) {
        const result = await setStravaDescription(token, row.strava_id, current.trim() ? `${current.trimEnd()}\n\n${lines}` : lines, budget);
        if (result === 'denied') {
          await lostPermission(row.id);
          continue;
        }
      }
      await done(row.run_id);
    } catch (err) {
      if (err instanceof RateLimited) return;
      console.error(`strava description run ${row.run_id}:`, err);
    }
  }
}
