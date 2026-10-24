import { asAppError } from "../../lib/errors.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { spotifyConnectionStore }, { spotifyClient }, { SPOTIFY_SCOPES }] =
  await setupIsolatedBackend(
    "spotify-followed-artists",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/spotify/spotifyConnectionStore.ts"),
    () => import("../../backend/services/spotify/spotifyClient.ts"),
    () => import("../../backend/services/spotify/spotifyConfig.ts"),
  );

const originalFetch = globalThis.fetch;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const connect = (scopes: string | null = SPOTIFY_SCOPES) =>
  spotifyConnectionStore.saveConnection(7, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes,
  });

beforeEach(() => {
  resetDatabase(db);
  spotifyClient.clearPlaylistTrackCache();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await cleanupIsolatedState(isolatedState);
});

test("a connection made before Aurral asked to read followed artists must reconnect for them", () => {
  connect(null);
  assert.equal(spotifyConnectionStore.getPublicStatus(7).canReadFollowedArtists, false);
  connect();
  assert.equal(spotifyConnectionStore.getPublicStatus(7).canReadFollowedArtists, true);
  spotifyConnectionStore.updateTokens(7, { accessToken: "renewed-token" });
  assert.equal(spotifyConnectionStore.getPublicStatus(7).canReadFollowedArtists, true);
});

test("followed artists are read across every cursor page", async () => {
  connect();
  const page = (ids: string[], next: string | null) =>
    jsonResponse(200, {
      artists: {
        items: ids.map((id) => ({
          id,
          name: `Artist ${id}`,
          genres: ["a", "b", "c", "d"],
          images: [
            { url: `https://img/${id}/640`, width: 640 },
            { url: `https://img/${id}/160`, width: 160 },
            { url: `https://img/${id}/32`, width: 32 },
          ],
        })),
        next,
      },
    });
  const requested: string[] = [];
  const pages = [
    page(["c", "a"], "https://api.spotify.com/v1/me/following?type=artist&after=a"),
    page(["b", "a"], "https://api.spotify.com/v1/me/following?type=artist&after=b"),
    page(["d"], null),
  ];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return pages.shift()!;
  };

  const artists = await spotifyClient.listFollowedArtists(7);
  assert.deepEqual(
    artists.map((artist) => artist.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(artists[0].imageUrl, "https://img/a/160");
  assert.deepEqual(artists[0].genres, ["a", "b", "c"]);
  assert.equal(requested.length, 3);
  assert.match(requested[0], /\/me\/following\?type=artist&limit=50$/);

  globalThis.fetch = async () => assert.fail("a second read within minutes uses the cache");
  assert.equal((await spotifyClient.listFollowedArtists(7)).length, 4);

  // Signing in again, maybe as someone else, reads the list afresh.
  spotifyClient.clearPlaylistTrackCache(7);
  globalThis.fetch = async () => page(["z"], null);
  assert.deepEqual(
    (await spotifyClient.listFollowedArtists(7)).map((artist) => artist.id),
    ["z"],
  );
});

test("Spotify refusing the follow scope asks the user to reconnect", async () => {
  connect();
  globalThis.fetch = async () =>
    jsonResponse(403, { error: { status: 403, message: "Insufficient client scope" } });
  await assert.rejects(
    spotifyClient.listFollowedArtists(7),
    (error) =>
      asAppError(error)?.code === "SPOTIFY_SCOPE_REQUIRED" && asAppError(error)?.statusCode === 403,
  );
});
