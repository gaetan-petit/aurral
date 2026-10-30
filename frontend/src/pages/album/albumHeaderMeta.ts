import {
  formatAlbumDuration,
  formatReleaseDate,
  getReleaseMetric,
  getReleaseTypeLabel,
  type ReleaseGroup,
} from "../ArtistDetails/utils.ts";
import { releaseTypeOf, type LibraryAlbum } from "../../utils/libraryPageData.ts";

export type AlbumHeaderMetaSegment = { text: string; partial?: boolean };

// The track count reads "available/total" when part of the album is missing, like the
// library album cards.
export function buildAlbumHeaderMeta({
  release,
  libraryAlbum,
  trackCount,
  availableCount = null,
  durationMs,
}: {
  release: ReleaseGroup | null | undefined;
  libraryAlbum: LibraryAlbum | null | undefined;
  trackCount: number;
  availableCount?: number | null;
  durationMs: number;
}): AlbumHeaderMetaSegment[] {
  const metric = getReleaseMetric(release);
  const unit = trackCount === 1 ? "track" : "tracks";
  const partial = availableCount != null && availableCount < trackCount;
  return [
    {
      text:
        formatReleaseDate(release) || formatReleaseDate({ releaseDate: libraryAlbum?.releaseDate }),
    },
    { text: getReleaseTypeLabel(release) || releaseTypeOf(libraryAlbum) || "" },
    trackCount > 0
      ? {
          text: partial ? `${availableCount}/${trackCount} ${unit}` : `${trackCount} ${unit}`,
          partial,
        }
      : { text: "" },
    { text: formatAlbumDuration(durationMs) },
    {
      text: metric.label
        ? `${metric.label} ${metric.type === "rating" ? "rating" : "listeners"}`
        : "",
    },
  ].filter((segment) => segment.text);
}
