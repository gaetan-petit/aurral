import { asAppError } from "../../lib/errors.ts";
import { releasedSince } from "../../lib/releaseDate.ts";
import { getLibraryForAlbumReferences } from "./libraryQueryService.ts";
import { chooseLibraryAlbumEdition } from "./libraryMediaStore.ts";
import { logger } from "./logger.ts";
import type { NormalizedAlbum, NormalizedRelease } from "./providers/brainzmashMappers.ts";
import { getAlbumByMbid } from "./providers/brainzmashProvider.ts";
import { listsEveryTrack } from "./providers/brainzmashRanking.ts";
import { chooseRequestedRelease } from "./releaseResolver.ts";
import {
  isSilenceTrack,
  isUnknownTitle,
  isVariousArtistsCredit,
  UNKNOWN_TITLE_WAIT_MS,
} from "./trackMatching/titleText.ts";

const albumLibrary = (albumId: number) =>
  getLibraryForAlbumReferences({ source: "all", availableOnly: false, references: [albumId] });

export function storeAlbumEdition(
  albumId: number,
  group: NormalizedAlbum,
  release: NormalizedRelease,
  edition: string,
) {
  const artists = new Map<string | null | undefined, string>(
    group.artists.map((artist) => [artist.id, artist.name]),
  );
  const compilation = isVariousArtistsCredit(artists.get(group.artistId), group.artistId);
  return chooseLibraryAlbumEdition(
    albumId,
    { ...release, title: release.title || group.title },
    edition,
    (track) => (compilation && artists.get(track.artistId)) || null,
  );
}

// Runs on every missing-track search, yet calls brainzmash at most daily per
// album: a release listing "[unknown]" is cached for a day, and waiting when
// that copy has expired puts new names on this search, not the next day's.
export async function relistProvisionalAlbum(
  albumId: number,
  defaultEdition: (artistId: number) => string,
): Promise<number[]> {
  const library = albumLibrary(albumId);
  const album = library.albums.find((entry) => entry.id === albumId);
  if (
    !album?.releaseGroupMbid ||
    !releasedSince(album.releaseDate, Date.now() - UNKNOWN_TITLE_WAIT_MS)
  )
    return [];
  const listed = library.tracks.filter((track) => album.trackIds.includes(track.id));
  const provisional = listed.some(
    (track) => track.available !== true && track.monitored !== false && isUnknownTitle(track.title),
  );
  if (!provisional) return [];
  let group;
  try {
    group = await getAlbumByMbid(album.releaseGroupMbid, {
      withFallbackReleases: true,
      waitWhenStale: true,
    });
  } catch (error) {
    logger.info("library", "Could not read an album's track list again", {
      albumId,
      message: asAppError(error)?.message || String(error),
    });
    return [];
  }
  const edition = album.metadata?.edition || defaultEdition(album.artistId);
  // Asking for the listed release keeps an expanded edition from switching to
  // a newer release.
  const release = chooseRequestedRelease(group, {
    requestedRelease: album.metadata?.requestedRelease || album.metadata?.trackList?.release,
    edition,
  });
  if (!release || !listsEveryTrack(release)) return [];
  // Other changes, such as a merged recording, are left to scans: rewriting
  // the list for them would repeat on every search.
  const changed = listed.some((have) => {
    if (have.available === true || !isUnknownTitle(have.title)) return false;
    const place = have.albums.find((entry) => entry.albumId === albumId);
    return release.tracks.some(
      (track) =>
        !isSilenceTrack(track.title) &&
        !isUnknownTitle(track.title) &&
        ((track.recordingId || track.id) === have.mbid ||
          (place != null &&
            (track.mediumNumber ?? 1) === place.discNumber &&
            track.trackPosition === place.trackNumber)),
    );
  });
  if (!changed) return [];
  storeAlbumEdition(album.id, group, release, edition);
  const unnamed = new Set(
    listed.filter((track) => isUnknownTitle(track.title)).map((track) => track.id),
  );
  const relisted = albumLibrary(albumId);
  const trackIds = relisted.albums.find((entry) => entry.id === albumId)?.trackIds || [];
  return relisted.tracks
    .filter(
      (track) =>
        trackIds.includes(track.id) &&
        !isUnknownTitle(track.title) &&
        (unnamed.has(track.id) || !album.trackIds.includes(track.id)),
    )
    .map((track) => track.id);
}
