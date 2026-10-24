import { getAppBasePath, normalizeBasePathWithTrailingSlash } from "./basePath";
import type { ApiError } from "./api/core.ts";
import { getApiErrorBody } from "../pages/onboardingUtils.tsx";

declare global {
  interface Window {
    onCompleteOauth?: (query: string, onComplete?: () => void) => void;
  }
}

export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: string | number | null | undefined;
};

const SPOTIFY_OAUTH_BROADCAST_CHANNEL = "aurral-spotify-oauth";
const SPOTIFY_AUTH_REQUIRED_CODE = "SPOTIFY_AUTH_REQUIRED";
const SPOTIFY_SCOPE_REQUIRED_CODE = "SPOTIFY_SCOPE_REQUIRED";

type HandoffPayload = {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: string | number | null;
};

function tokensFromHandoffPayload(
  payload: HandoffPayload | null | undefined,
): SpotifyTokens | null {
  const accessToken = String(payload?.access_token || "").trim();
  const refreshToken = String(payload?.refresh_token || "").trim();
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    expiresIn: payload?.expires_in,
  };
}

export function getOAuthCallbackUrl() {
  const base = normalizeBasePathWithTrailingSlash(getAppBasePath());
  return `${window.location.origin}${base}oauth.html`;
}

export function openSpotifyOAuthPopup(oauthUrl: string) {
  return new Promise<SpotifyTokens>((resolve, reject) => {
    const popup = window.open(oauthUrl, "spotify-oauth", "width=480,height=720");
    if (!popup || popup.closed || typeof popup.closed === "undefined") {
      reject(new Error("Allow popups to connect Spotify."));
      return;
    }

    let settled = false;
    let channel: BroadcastChannel | null | undefined;
    const cleanup = () => {
      delete window.onCompleteOauth;
      if (channel) {
        channel.close();
        channel = null;
      }
      clearTimeout(timeout);
    };
    const finish = (tokens: SpotifyTokens) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tokens);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    try {
      channel = new BroadcastChannel(SPOTIFY_OAUTH_BROADCAST_CHANNEL);
      channel.onmessage = (event) => {
        if (event.data?.type !== "ready") return;
        const tokens = tokensFromHandoffPayload(event.data?.payload);
        if (tokens) finish(tokens);
      };
    } catch (_) {
      channel = null;
    }

    window.onCompleteOauth = (query, onComplete) => {
      delete window.onCompleteOauth;
      onComplete?.();
      const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
      const tokens = tokensFromHandoffPayload({
        access_token: params.get("access_token"),
        refresh_token: params.get("refresh_token"),
        expires_in: params.get("expires_in"),
      });
      if (!tokens) {
        fail("Spotify sign-in returned no tokens");
        return;
      }
      finish(tokens);
    };

    const timeout = setTimeout(
      () => {
        fail("Spotify sign-in timed out");
      },
      5 * 60 * 1000,
    );
  });
}

export function isSpotifyAuthRequired(error: ApiError | null | undefined) {
  return getApiErrorBody(error)?.code === SPOTIFY_AUTH_REQUIRED_CODE;
}

// The connection predates a permission a call now needs.
export function isSpotifyScopeRequired(error: ApiError | null | undefined) {
  return getApiErrorBody(error)?.code === SPOTIFY_SCOPE_REQUIRED_CODE;
}
