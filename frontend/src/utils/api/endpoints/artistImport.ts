import { getData, postData } from "../core.ts";
import type {
  ArtistImportItemsResponse,
  ArtistImportResponse,
  GetFollowedSpotifyArtistsResponse,
} from "../../../../../backend/routes/library/handlers/artistImport.ts";

export type FollowedSpotifyArtist = GetFollowedSpotifyArtistsResponse["artists"][number];
export type ArtistImport = NonNullable<ArtistImportResponse["operation"]>;
export type ArtistImportItem = ArtistImportItemsResponse["items"][number];

// Spotify lists followed artists 50 at a time, so a long list needs time.
const FOLLOWED_ARTISTS_TIMEOUT_MS = 120_000;

export const getFollowedSpotifyArtists = (): Promise<GetFollowedSpotifyArtistsResponse> =>
  getData("/library/import/spotify/artists", { timeout: FOLLOWED_ARTISTS_TIMEOUT_MS });

export const startSpotifyArtistImport = (
  artists: { id: string; name: string }[],
): Promise<ArtistImportResponse> => postData("/library/import/spotify/artists", { artists });

export const getLatestArtistImport = (): Promise<ArtistImportResponse> =>
  getData("/library/import/artists/latest");

export const getArtistImport = (id: number): Promise<ArtistImportResponse> =>
  getData(`/library/import/artists/${encodeURIComponent(id)}`);

export const getArtistImportItems = (
  id: number,
  {
    status = [],
    offset = 0,
    limit = 50,
  }: { status?: string[]; offset?: number; limit?: number } = {},
): Promise<ArtistImportItemsResponse> =>
  getData(
    `/library/import/artists/${encodeURIComponent(id)}/items?${new URLSearchParams({
      status: status.join(","),
      offset: String(offset),
      limit: String(limit),
    })}`,
  );

export const cancelArtistImport = (id: number): Promise<ArtistImportResponse> =>
  postData(`/library/import/artists/${encodeURIComponent(id)}/cancel`, {});
