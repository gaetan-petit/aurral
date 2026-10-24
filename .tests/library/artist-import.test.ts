import { createRouteHarness, createResponse } from "./routeHarness.ts";
import assert from "node:assert/strict";
import { test, beforeEach, afterAll } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { userOps },
  artistImport,
  store,
  { upsertLibraryArtist },
  { setLibraryManagement },
] = await setupIsolatedBackend(
  "artist-import",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/artistImport/artistImport.ts"),
  () => import("../../backend/services/artistImport/artistImportStore.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryManagementStore.ts"),
);
const { registerArtistImport } =
  await import("../../backend/routes/library/handlers/artistImport.ts");

const { runArtistImport, cancelArtistImport } = artistImport;
const { createArtistImport, countArtistImportItems, getArtistImport, listArtistImportItems } =
  store;

const MBIDS: Record<string, string | null> = {
  "New Artist": "00000000-0000-4000-8000-000000000001",
  "Monitored Artist": "00000000-0000-4000-8000-000000000002",
  "Scanned Artist": "00000000-0000-4000-8000-000000000003",
  "Unknown Artist": null,
};

type AddCall = { mbid: string; name: string; monitoring: unknown };

function stubDeps({
  flaky = new Set<string>(),
  managedBy = "aurral",
  lidarrArtists = new Set<string>(),
  addOptions,
}: {
  flaky?: Set<string>;
  managedBy?: string;
  lidarrArtists?: Set<string>;
  addOptions?: () => Promise<unknown>;
} = {}) {
  const added: AddCall[] = [];
  let optionCalls = 0;
  const deps = {
    resolveMbid: async (name: string) => {
      if (flaky.has(name)) throw new Error("metadata service timed out");
      return MBIDS[name] ?? null;
    },
    findLidarrArtist: async (mbid: string) => (lidarrArtists.has(mbid) ? { id: 1 } : null),
    manager: {
      resolveManagedBy: async () => managedBy,
      resolveArtistAddOptions: async (options: { monitoring?: unknown }) => {
        optionCalls += 1;
        if (addOptions) return addOptions();
        return { managedBy, monitoring: options.monitoring };
      },
      addArtistWithResolvedOptions: async (
        mbid: string,
        name: string,
        options: { monitoring?: unknown },
      ) => {
        added.push({ mbid, name, monitoring: options.monitoring });
        return { id: String(100 + added.length) };
      },
    },
  };
  return { deps: deps as never, added, optionCalls: () => optionCalls };
}

let ownerId = 0;

beforeEach(() => {
  resetDatabase(db);
  db.prepare("DELETE FROM library_management").run();
  ownerId = userOps.createUser("importer", "hash", "user", { addArtist: true })!.id;
  const monitored = upsertLibraryArtist({
    identityKey: "monitored",
    mbid: MBIDS["Monitored Artist"],
    name: "Monitored Artist",
  });
  setLibraryManagement({
    entityKind: "artist",
    entityId: monitored.id,
    managedBy: "aurral",
    monitorMode: "latest",
    monitorRules: { default: false, rules: { catalog: "latest" } },
  });
  upsertLibraryArtist({
    identityKey: "scanned",
    mbid: MBIDS["Scanned Artist"],
    name: "Scanned Artist",
  });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

const start = (names: string[]) =>
  createArtistImport({
    ownerUserId: ownerId,
    source: "spotify",
    artists: names.map((name, index) => ({ id: `spotify-${index}`, name })),
  });

const statuses = (id: number) =>
  Object.fromEntries(
    listArtistImportItems(id, { limit: 50 }).map((item) => [item.name, item.status]),
  );

test("an import adds new artists with the default rules and leaves monitored ones alone", async () => {
  const operation = start(["New Artist", "Monitored Artist", "Scanned Artist", "Unknown Artist"]);
  const { deps, added } = stubDeps();

  assert.deepEqual(await runArtistImport(operation.id, { deps }), { done: true });

  assert.deepEqual(statuses(operation.id), {
    "New Artist": "added",
    "Monitored Artist": "existing",
    "Scanned Artist": "added",
    "Unknown Artist": "unmatched",
  });
  assert.deepEqual(
    added.map((call) => call.name),
    ["New Artist", "Scanned Artist"],
  );
  for (const call of added) {
    assert.deepEqual(call.monitoring, { monitored: true, useDefault: true });
  }
  assert.equal(getArtistImport(operation.id)!.status, "complete");
  const rules = db
    .prepare<[string], { monitor_rules: string }>(
      `SELECT management.monitor_rules FROM library_management AS management
       JOIN library_artists AS artist ON artist.id = management.entity_id
       WHERE management.entity_kind = 'artist' AND artist.name = ?`,
    )
    .get("Monitored Artist");
  assert.match(rules!.monitor_rules, /"latest"/);
});

test("a metadata outage pauses the import, retries, then gives up on that artist", async () => {
  const operation = start(["Flaky Artist", "New Artist"]);
  const { deps } = stubDeps({ flaky: new Set(["Flaky Artist"]) });

  assert.deepEqual(await runArtistImport(operation.id, { deps }), {
    done: false,
    delaySeconds: 60,
  });
  assert.equal(statuses(operation.id)["Flaky Artist"], "pending");
  await runArtistImport(operation.id, { deps });
  assert.deepEqual(await runArtistImport(operation.id, { deps }), { done: true });

  const [flaky] = listArtistImportItems(operation.id, { statuses: ["failed"] });
  assert.equal(flaky.name, "Flaky Artist");
  assert.equal(flaky.attempts, 3);
  assert.equal(flaky.reason, "metadata service timed out");
  assert.equal(statuses(operation.id)["New Artist"], "added");
});

test("a setting that fails every artist stops the import once", async () => {
  const operation = start(["New Artist", "Scanned Artist"]);
  const { deps, added, optionCalls } = stubDeps({
    managedBy: "lidarr",
    addOptions: async () => {
      throw Object.assign(new Error("The saved root folder no longer exists"), {
        statusCode: 409,
      });
    },
  });
  assert.deepEqual(await runArtistImport(operation.id, { deps }), { done: true });
  assert.equal(optionCalls(), 1);
  assert.equal(added.length, 0);
  const failed = getArtistImport(operation.id)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "The saved root folder no longer exists");
  assert.equal(countArtistImportItems(operation.id).pending, 2);
});

test("a library manager outage pauses the import without failing artists", async () => {
  const operation = start(["New Artist"]);
  const { deps } = stubDeps({
    addOptions: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.deepEqual(await runArtistImport(operation.id, { deps }), {
    done: false,
    delaySeconds: 60,
  });
  assert.equal(getArtistImport(operation.id)!.status, "running");
  assert.equal(listArtistImportItems(operation.id, {})[0].attempts, 0);
});

test("with Lidarr, only artists Lidarr has are left alone", async () => {
  const operation = start(["New Artist", "Scanned Artist"]);
  const { deps, added } = stubDeps({
    managedBy: "lidarr",
    lidarrArtists: new Set([MBIDS["Scanned Artist"]!]),
  });
  await runArtistImport(operation.id, { deps });
  assert.deepEqual(statuses(operation.id), {
    "New Artist": "added",
    "Scanned Artist": "existing",
  });
  assert.deepEqual(
    added.map((call) => call.name),
    ["New Artist"],
  );
});

test("a slice stops at its time budget and leaves the rest for the next one", async () => {
  const operation = start(["New Artist", "Scanned Artist"]);
  const { deps } = stubDeps();
  assert.deepEqual(await runArtistImport(operation.id, { budgetMs: 0, deps }), { done: false });
  assert.equal(countArtistImportItems(operation.id).pending, 2);
  assert.deepEqual(await runArtistImport(operation.id, { deps }), { done: true });
  assert.equal(countArtistImportItems(operation.id).added, 2);
});

test("a cancelled import adds nothing more", async () => {
  const operation = start(["New Artist"]);
  assert.equal(cancelArtistImport(operation.id), true);
  const { deps, added } = stubDeps();
  assert.deepEqual(await runArtistImport(operation.id, { deps }), { done: true });
  assert.equal(added.length, 0);
  assert.equal(getArtistImport(operation.id)!.status, "cancelled");
});

test("an import stops when its owner can no longer add artists", async () => {
  const operation = start(["New Artist"]);
  userOps.updateUser(ownerId, { permissions: { addArtist: false } });
  const { deps, added } = stubDeps();
  await runArtistImport(operation.id, { deps });
  assert.equal(added.length, 0);
  assert.equal(getArtistImport(operation.id)!.status, "failed");
});

test("a user runs one import at a time, and a long list is stored in full", () => {
  const names = Array.from({ length: 2000 }, (_, index) => `Artist ${index}`);
  const operation = start(names);
  assert.equal(countArtistImportItems(operation.id).pending, 2000);
  assert.throws(() => start(["New Artist"]), { code: "ARTIST_IMPORT_ACTIVE" });
});

const routes = createRouteHarness(registerArtistImport);

test("the import routes reject oversized lists and other users' imports", async () => {
  const tooMany = createResponse<{ message: string }>();
  await routes.get("POST /import/spotify/artists")(
    {
      user: { id: ownerId },
      body: {
        artists: Array.from({ length: 5001 }, (_, index) => ({ id: `${index}`, name: "Name" })),
      },
    },
    tooMany,
  );
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.body.message, /at most 5000/);

  const operation = start(["New Artist"]);
  const stranger = createResponse();
  routes.get("GET /import/artists/:id")(
    { user: { id: ownerId + 1 }, params: { id: String(operation.id) } },
    stranger,
  );
  assert.equal(stranger.statusCode, 404);

  const own = createResponse<{ operation: { total: number; counts: { pending: number } } }>();
  routes.get("GET /import/artists/:id")(
    { user: { id: ownerId }, params: { id: String(operation.id) } },
    own,
  );
  assert.equal(own.body.operation.total, 1);
  assert.equal(own.body.operation.counts.pending, 1);
});
