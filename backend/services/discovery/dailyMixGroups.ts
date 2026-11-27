import { db } from "../../config/db-sqlite.ts";
import type { LibraryArtistsRow } from "../../db/rows.ts";
import { getCachedArtistsByMbid } from "../providers/metadataProvider.ts";
import { similarScoreToMatch } from "../providers/metadataMappers.ts";
import { discoverLinks } from "./discoverLinks.ts";

type DailyArtist = Pick<LibraryArtistsRow, "id" | "name" | "mbid">;

const DAILY_GROUPS = 12;
export const DAILY_SEED_ARTISTS = 4;

const nameKey = (name: string) => name.trim().toLowerCase();
const mbidKey = (mbid: string | null | undefined) => mbid?.trim().toLowerCase() || null;
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",");

function artistGenres(artistIds: number[]) {
  const genres = new Map<number, Set<string>>();
  if (!artistIds.length) return genres;
  const rows = db
    .prepare<number[], { artistId: number; genre: string }>(
      `SELECT entity_id AS artistId, genre_key AS genre FROM library_entity_genres
       WHERE entity_kind = 'artists' AND entity_id IN (${placeholders(artistIds)})
       UNION
       SELECT album.artist_id, genres.genre_key FROM library_entity_genres AS genres
       JOIN library_albums AS album ON album.id = genres.entity_id
       WHERE genres.entity_kind = 'albums' AND album.artist_id IN (${placeholders(artistIds)})`,
    )
    .all(...artistIds, ...artistIds);
  for (const row of rows) {
    genres.set(row.artistId, (genres.get(row.artistId) ?? new Set()).add(row.genre));
  }
  return genres;
}

export function genreGroups(artists: DailyArtist[]) {
  const genres = artistGenres(artists.map((artist) => artist.id));
  const weights = new Map<string, number>();
  for (const [rank, artist] of artists.entries()) {
    for (const genre of genres.get(artist.id) ?? []) {
      weights.set(genre, (weights.get(genre) ?? 0) + 1 / (rank + 1));
    }
  }
  const assigned = new Set<number>();
  const groups: DailyArtist[][] = [];
  for (const [genre] of [...weights].sort(([, left], [, right]) => right - left)) {
    if (groups.length >= DAILY_GROUPS) break;
    const members = artists.filter(
      (artist) => !assigned.has(artist.id) && genres.get(artist.id)?.has(genre),
    );
    if (members.length < 2) continue;
    const seeds = members.slice(0, DAILY_SEED_ARTISTS);
    for (const artist of seeds) assigned.add(artist.id);
    groups.push(seeds);
  }
  return groups;
}

async function listedSimilar(artists: DailyArtist[]) {
  const records = await getCachedArtistsByMbid(
    artists.flatMap((artist) => (artist.mbid ? [artist.mbid] : [])),
  );
  return new Map(
    artists.map((artist) => [
      artist.id,
      ((artist.mbid && records.get(artist.mbid)?.similar) || []).map((entry) => ({
        mbid: mbidKey(entry.id),
        name: entry.name,
        match: similarScoreToMatch(entry.score),
      })),
    ]),
  );
}

// Reads only cached AurralBrainz records and stored Discover data, so building
// Daily Mixes never sends a request.
export async function dailyMixGroups(userId: number, artists: DailyArtist[]) {
  const discover = discoverLinks(userId);
  const listed = await listedSimilar(artists);
  const lists = (left: DailyArtist, right: DailyArtist) => {
    const mbid = mbidKey(right.mbid);
    return Boolean(mbid) && (listed.get(left.id) ?? []).some((entry) => entry.mbid === mbid);
  };
  const linked = (left: DailyArtist, right: DailyArtist) =>
    lists(left, right) || lists(right, left) || discover.linked(left.name, right.name);
  const hasData = (artist: DailyArtist) =>
    Boolean(listed.get(artist.id)?.length) || discover.has(artist.name);

  const assigned = new Set<number>();
  const similarGroups: DailyArtist[][] = [];
  for (const head of artists) {
    if (similarGroups.length >= DAILY_GROUPS) break;
    if (assigned.has(head.id) || !hasData(head)) continue;
    const members = [
      head,
      ...artists.filter(
        (artist) => artist !== head && !assigned.has(artist.id) && linked(head, artist),
      ),
    ].slice(0, DAILY_SEED_ARTISTS);
    for (const artist of members) assigned.add(artist.id);
    similarGroups.push(members);
  }

  const byName = new Map(artists.map((artist) => [nameKey(artist.name), artist]));
  const similarTo = async ({ name }: { name?: string | null }) => {
    if (!name) return [];
    const artist = byName.get(nameKey(name));
    return [...discover.similarTo(name), ...(artist ? (listed.get(artist.id) ?? []) : [])];
  };
  return { similarGroups, similarTo };
}
