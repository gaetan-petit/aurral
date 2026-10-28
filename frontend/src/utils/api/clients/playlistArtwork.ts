import { hc, type InferResponseType } from "hono/client";
import type playlistArtwork from "../../../../../backend/routes/playlists/handlers/artwork.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const playlistArtworkClient = hc<typeof playlistArtwork>(API_BASE_URL, {
  fetch: apiFetch,
}).playlists;

export type PlaylistCoverPick = NonNullable<
  InferResponseType<
    (typeof playlistArtworkClient.artwork)[":playlistId"]["pick"]["$get"],
    200
  >["pick"]
>;
