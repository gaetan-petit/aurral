import type { Response } from "express";
import {
  SPOTIFY_AUTH_REQUIRED_CODE,
  SPOTIFY_SCOPE_REQUIRED_CODE,
} from "../../services/spotify/spotifyClient.ts";
import { asAppError } from "../../../lib/errors.ts";

export function sendSpotifyError(res: Response, error: unknown, fallback: string) {
  const failure = asAppError(error);
  if (failure?.code === SPOTIFY_AUTH_REQUIRED_CODE) {
    return res.status(401).json({
      error: "Spotify authentication required",
      code: SPOTIFY_AUTH_REQUIRED_CODE,
      message: "Your Spotify connection expired. Connect Spotify again.",
    });
  }
  if (failure?.code === SPOTIFY_SCOPE_REQUIRED_CODE) {
    return res.status(403).json({
      error: "Spotify permission required",
      code: SPOTIFY_SCOPE_REQUIRED_CODE,
      message: failure.message,
    });
  }
  return res.status(failure?.statusCode || 500).json({
    error: fallback,
    message: failure?.message || "Unknown error",
  });
}
