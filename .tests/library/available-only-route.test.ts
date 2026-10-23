import { createRouteHarness, createResponse } from "./routeHarness.ts";
import type { FetchLibraryPageResponse } from "../../backend/routes/library/handlers/libraryIndex.ts";
type Page<Kind extends "albums" | "artists"> = Extract<FetchLibraryPageResponse, { kind: Kind }>;
import assert from "node:assert/strict";
import { test, beforeAll, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, libraryStore, { setLibraryManagement }] =
  await setupIsolatedBackend(
    "canonical-available-only-route",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/libraryManagementStore.ts"),
  );

const { registerLibraryIndex } =
  await import("../../backend/routes/library/handlers/libraryIndex.ts");
const { getLibrarySearchPage, LIBRARY_VIEW } =
  await import("../../backend/services/libraryQueryService.ts");
const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

const routes = createRouteHarness(registerLibraryIndex);
function callLibraryPage<Kind extends "artists" | "albums">(query: {
  kind: Kind;
  page: string;
  pageSize: string;
  artistId?: string;
  source?: string;
  availableOnly?: string;
  sort?: string;
}) {
  const response = createResponse<Page<Kind>>();
  routes.get("GET /canonical")({ query }, response);
  return response.body;
}

beforeAll(() => {
  resetDatabase(db);

  // Artist who owns some but not all of their discography (the issue's "Muse" case).
  const partialArtist = upsertLibraryArtist({
    identityKey: "partial-artist",
    name: "Owns Some",
  });
  const ownedAlbum = upsertLibraryAlbum({
    identityKey: "owned-album",
    artistId: partialArtist.id,
    title: "Owned Album",
  });
  const ownedTrack = upsertLibraryTrack({
    identityKey: "owned-track",
    title: "Owned Track",
    artistName: partialArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: ownedAlbum.id, trackId: ownedTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: ownedAlbum.id,
    source: "lidarr",
    path: "/library/Owns Some/Owned Album/01 Owned Track.flac",
    available: true,
  });

  const catalogAlbum = upsertLibraryAlbum({
    identityKey: "catalog-album",
    artistId: partialArtist.id,
    title: "Catalog Album",
  });
  const catalogTrack = upsertLibraryTrack({
    identityKey: "catalog-track",
    title: "Catalog Track",
    artistName: partialArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: catalogAlbum.id, trackId: catalogTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: catalogTrack.id,
    albumId: catalogAlbum.id,
    source: "lidarr",
    path: "/library/Owns Some/Catalog Album/01 Catalog Track.flac",
    available: false,
  });

  // Artist who owns nothing (e.g. deleted in Lidarr but lingering) — issue #750.
  const emptyArtist = upsertLibraryArtist({
    identityKey: "empty-artist",
    name: "Owns Nothing",
  });
  const emptyAlbum = upsertLibraryAlbum({
    identityKey: "empty-album",
    artistId: emptyArtist.id,
    title: "Unowned Album",
  });
  const emptyTrack = upsertLibraryTrack({
    identityKey: "empty-track",
    title: "Unowned Track",
    artistName: emptyArtist.name,
  });
  linkLibraryAlbumTrack({ albumId: emptyAlbum.id, trackId: emptyTrack.id, trackNumber: 1 });
  upsertLibraryMediaFile({
    trackId: emptyTrack.id,
    albumId: emptyAlbum.id,
    source: "lidarr",
    path: "/library/Owns Nothing/Unowned Album/01 Unowned Track.flac",
    available: false,
  });

  // Artists Aurral monitors stay in the Library before any of their music
  // arrives. Lidarr's monitored artists and deleted artists, whose monitoring
  // Aurral cleared, wait for music.
  for (const [name, managedBy, monitorRules] of [
    ["Monitored Empty", "aurral", { default: true }],
    ["Deleted Empty", "aurral", null],
    ["Lidarr Empty", "lidarr", null],
  ] as const) {
    const artist = upsertLibraryArtist({
      identityKey: `${name}-artist`,
      name,
      metadata: { monitored: true, ...(managedBy === "lidarr" && { librarySource: "lidarr" }) },
    });
    setLibraryManagement({
      entityKind: "artist",
      entityId: artist.id,
      managedBy,
      monitorMode: monitorRules ? "all" : "none",
      monitorRules,
    });
  }

  const fetchingArtist = upsertLibraryArtist({ identityKey: "fetching-artist", name: "Fetching" });
  for (const [title, monitored] of [
    ["Requested Album", true],
    ["Unmonitored Album", false],
  ] as const) {
    const album = upsertLibraryAlbum({
      identityKey: `aurral-${title}`,
      artistId: fetchingArtist.id,
      title,
      metadata: { librarySource: "aurral", trackListComplete: true, monitored },
    });
    const track = upsertLibraryTrack({
      identityKey: `aurral-${title}-track`,
      title: `${title} Track`,
    });
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    setLibraryManagement({
      entityKind: "album",
      entityId: album.id,
      managedBy: "aurral",
      monitorMode: monitored ? "monitored" : "unmonitored",
    });
  }
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const titles = (page: Page<"albums" | "artists">) =>
  page.items.map((entry) => ("title" in entry ? entry.title : entry.name)).sort();

test("the Library lists what can be played and what Aurral is fetching, with or without Lidarr", () => {
  for (const lidarr of [
    { url: "http://lidarr:8686", apiKey: "test-key", availableOnly: false },
    {},
  ]) {
    dbOps.updateSettings({ integrations: { lidarr } });
    const albums = callLibraryPage({ kind: "albums", page: "1", pageSize: "50" });
    assert.deepEqual(titles(albums), ["Owned Album", "Requested Album"]);
    assert.equal(albums.total, 2);
    const artists = callLibraryPage({ kind: "artists", page: "1", pageSize: "50" });
    assert.deepEqual(titles(artists), ["Fetching", "Monitored Empty", "Owns Some"]);
    assert.equal(artists.total, 3);
    assert.deepEqual(
      artists.items.map((artist) => ("albumCount" in artist ? artist.albumCount : undefined)),
      [1, 0, 1],
    );
    const ownsSome = artists.items.find((artist) => artist.name === "Owns Some");
    assert.ok(ownsSome);
    assert.deepEqual(
      titles(
        callLibraryPage({
          kind: "albums",
          page: "1",
          pageSize: "50",
          artistId: String(ownsSome.id),
        }),
      ),
      ["Owned Album"],
    );
  }
});

test("Library search finds artists Aurral monitors before their music arrives", () => {
  const search = getLibrarySearchPage({ availableOnly: LIBRARY_VIEW, query: "empty" });
  assert.deepEqual(
    search.artists.map((artist) => [artist.name, artist.albumCount]),
    [["Monitored Empty", 0]],
  );
});

test("a source filter lists and counts only albums and artists with playable files from that source", () => {
  for (const kind of ["albums", "artists"] as const) {
    const page = callLibraryPage({ kind, page: "1", pageSize: "50", source: "lidarr" });
    assert.deepEqual(titles(page), [kind === "albums" ? "Owned Album" : "Owns Some"]);
    assert.equal(page.total, 1);
  }
});

test("an explicit availableOnly query param overrides the Library's rule", () => {
  const playable = callLibraryPage({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "true",
  });
  assert.deepEqual(titles(playable), ["Owned Album"]);
  const everything = callLibraryPage({
    kind: "albums",
    page: "1",
    pageSize: "50",
    availableOnly: "false",
  });
  assert.equal(everything.total, 5);
  const playableArtists = callLibraryPage({
    kind: "artists",
    page: "1",
    pageSize: "50",
    availableOnly: "true",
  });
  assert.deepEqual(titles(playableArtists), ["Owns Some"]);
});

test("Recently added ranks an artist with no music yet by when it was added", () => {
  const { newest } = db
    .prepare("SELECT MAX(created_at) AS newest FROM library_media_files")
    .get() as { newest: number };
  const setAddedAt = db.prepare("UPDATE library_artists SET created_at = ? WHERE name = ?");
  setAddedAt.run(newest + 60_000, "Monitored Empty");
  setAddedAt.run(1, "Fetching");
  const artists = callLibraryPage({ kind: "artists", page: "1", pageSize: "50", sort: "newest" });
  assert.deepEqual(
    artists.items.map((artist) => artist.name),
    ["Monitored Empty", "Owns Some", "Fetching"],
  );
});
