import { getAlbumTracksByAlbumMbid } from "./providers/brainzmashProvider.ts";
import { getMusicbrainzReleaseTrackCredits } from "./apiClients/musicbrainz.ts";
import { chooseLibraryRelease } from "./releaseResolver.ts";
import { findTrackArtistCredit, type TrackArtistCredit } from "../../lib/artistCredit.ts";

// Per-track artist credits for the release the library would pick for a release
// group. Empty when the metadata or MusicBrainz lookup fails.
export async function getReleaseGroupTrackCredits(
  releaseGroupMbid: string | null | undefined,
): Promise<TrackArtistCredit[]> {
  if (!releaseGroupMbid) return [];
  const tracks = await getAlbumTracksByAlbumMbid(releaseGroupMbid, {
    chooseRelease: chooseLibraryRelease,
  }).catch(() => []);
  return getMusicbrainzReleaseTrackCredits(tracks[0]?.releaseMbid);
}

// Starts the MusicBrainz lookup when a download begins, so tagging its files
// later never waits on the MusicBrainz rate limit.
export function warmReleaseTrackCredits(releaseMbid: string | null | undefined) {
  if (releaseMbid) void getMusicbrainzReleaseTrackCredits(releaseMbid);
}

// How long tagging waits for a release's credits lookup that is still running.
const TAGGING_CREDITS_WAIT_MS = 5000;

// Reads only credits a download already looked up for its release, waiting
// briefly when that lookup has not finished yet.
export async function getCachedTrackArtistCredit({
  releaseMbid,
  trackMbid,
  recordingMbidAliases,
  trackName,
}: {
  releaseMbid?: string | null;
  trackMbid?: string | null;
  recordingMbidAliases?: string[] | null;
  trackName?: string | null;
}) {
  const credits = await getMusicbrainzReleaseTrackCredits(releaseMbid, {
    cachedOnly: true,
    waitMs: TAGGING_CREDITS_WAIT_MS,
  });
  for (const mbid of [trackMbid, ...(recordingMbidAliases || [])]) {
    const credit = mbid ? findTrackArtistCredit(credits, { mbid }) : null;
    if (credit) return credit;
  }
  return findTrackArtistCredit(credits, { title: trackName });
}
