import { UUID_REGEX } from "./uuid.ts";

export type ArtistCreditEntry = { name: string; mbid: string | null; joinPhrase: string };
export type ArtistCredit = ArtistCreditEntry[];

type MusicBrainzCreditInput = {
  name?: string | null;
  joinphrase?: string | null;
  artist?: { id?: string | null; name?: string | null } | null;
};

const FEATURED_JOIN = /\s+(?:feat\.?|ft\.?|featuring)\s+/iu;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const mbid = (value: unknown) =>
  typeof value === "string" && UUID_REGEX.test(value.trim()) ? value.trim().toLowerCase() : null;
const textList = (value: unknown) =>
  (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).map(text);

export function formatArtistCredit(credit: ArtistCredit | null | undefined) {
  if (!Array.isArray(credit)) return "";
  return credit
    .map((entry) => `${entry.name}${entry.joinPhrase}`)
    .join("")
    .trim();
}

export function artistCreditFromMusicBrainz(
  raw: MusicBrainzCreditInput[] | null | undefined,
): ArtistCredit | null {
  if (!Array.isArray(raw)) return null;
  const credit = raw
    .map((entry) => ({
      name: text(entry?.name) || text(entry?.artist?.name),
      mbid: mbid(entry?.artist?.id),
      joinPhrase: typeof entry?.joinphrase === "string" ? entry.joinphrase : "",
    }))
    .filter((entry) => entry.name);
  return credit.length > 0 ? credit : null;
}

function splitFeaturedCredit(display: string, ids: (string | null)[]): ArtistCredit {
  const match = FEATURED_JOIN.exec(display);
  const guests =
    match && match.index > 0 ? display.slice(match.index + match[0].length).trim() : "";
  if (!match || !guests) return [{ name: display, mbid: ids[0] || null, joinPhrase: "" }];
  return [
    { name: display.slice(0, match.index).trim(), mbid: ids[0] || null, joinPhrase: match[0] },
    { name: guests, mbid: ids.length === 2 ? ids[1] : null, joinPhrase: "" },
  ];
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Finds a whole artist name, case-insensitively, so "Bob" does not match inside "Bobby".
function findName(display: string, name: string, from: number) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu");
  pattern.lastIndex = from;
  const match = pattern.exec(display);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

export function artistCreditFromTags({
  artist,
  artists,
  mbids,
}: {
  artist?: unknown;
  artists?: unknown;
  mbids?: unknown;
}): ArtistCredit | null {
  const display = text(artist);
  const names = textList(artists).filter(Boolean);
  const ids = textList(mbids).map(mbid);
  const idFor = (index: number) => (ids.length === names.length ? ids[index] || null : null);

  // music-metadata fills ARTISTS from ARTIST when the file has none.
  if (names.length === 0 || (names.length === 1 && names[0] === display)) {
    return display ? splitFeaturedCredit(display, ids) : null;
  }
  const listJoin = (index: number) =>
    index >= names.length - 1 ? "" : index === names.length - 2 ? " & " : ", ";

  // Recover the join phrases by walking the artist names through the display string.
  // Taggers often keep only the main artist in ARTIST and list guests in ARTISTS, so
  // names missing from the display string are appended as a plain list.
  const found: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const name of names) {
    const match = findName(display, name, cursor);
    if (!match) break;
    found.push(match);
    cursor = match.end;
  }
  return names.map((name, index) => {
    if (index >= found.length) return { name, mbid: idFor(index), joinPhrase: listJoin(index) };
    const { start, end } = found[index];
    const next = index + 1 < found.length ? found[index + 1].start : display.length;
    const between = display.slice(end, next);
    const appendsNext = index === found.length - 1 && index < names.length - 1;
    return {
      name: display.slice(start, end),
      mbid: idFor(index),
      joinPhrase: appendsNext
        ? between.trim()
          ? `${between}${listJoin(index)}`
          : listJoin(index)
        : between,
    };
  });
}

export function isSoleAlbumArtistCredit(
  credit: ArtistCredit | null | undefined,
  albumArtist: { mbid?: string | null; name?: string | null } | null | undefined,
) {
  if (!Array.isArray(credit) || credit.length === 0) return true;
  if (credit.length > 1) return false;
  const [entry] = credit;
  if (entry.joinPhrase.trim()) return false;
  const albumMbid = mbid(albumArtist?.mbid);
  if (entry.mbid && albumMbid) return entry.mbid === albumMbid;
  return entry.name.toLowerCase() === text(albumArtist?.name).toLowerCase();
}

export type TrackArtistCredit = { recordingId: string; title: string; artistCredit: ArtistCredit };

const titleKey = (value: unknown) =>
  text(value)
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ");

// Matches by recording MBID, then by title when exactly one track has it.
export function findTrackArtistCredit(
  credits: TrackArtistCredit[] | null | undefined,
  track: { mbid?: string | null; title?: string | null },
) {
  if (!Array.isArray(credits) || credits.length === 0) return null;
  const recordingId = mbid(track.mbid);
  const byId = recordingId && credits.find((entry) => mbid(entry.recordingId) === recordingId);
  if (byId) return byId.artistCredit;
  const key = titleKey(track.title);
  const byTitle = key ? credits.filter((entry) => titleKey(entry.title) === key) : [];
  return byTitle.length === 1 ? byTitle[0].artistCredit : null;
}

// Fills in credits for tracks whose own tags name only the album artist.
export function withFallbackArtistCredits<
  T extends { mbid?: string | null; title?: string | null; artistCredit?: ArtistCredit | null },
>(
  tracks: T[],
  credits: TrackArtistCredit[] | null | undefined,
  albumArtist: { mbid?: string | null; name?: string | null } | null | undefined,
): T[] {
  if (!Array.isArray(credits) || credits.length === 0) return tracks;
  return tracks.map((track) => {
    if (!isSoleAlbumArtistCredit(track.artistCredit, albumArtist)) return track;
    const artistCredit = findTrackArtistCredit(credits, track);
    return artistCredit && !isSoleAlbumArtistCredit(artistCredit, albumArtist)
      ? { ...track, artistCredit }
      : track;
  });
}
