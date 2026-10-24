import { db } from "../../config/db-sqlite.ts";
import { userOps } from "../../db/helpers/index.ts";
import { hasPermission } from "../../middleware/auth.ts";
import { asAppError } from "../../../lib/errors.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import { getNormalizedText } from "../providers/brainzmashRanking.ts";
import type { libraryManager as LibraryManager } from "../libraryManager.ts";
import {
  countArtistImportItems,
  createArtistImport,
  getArtistImport,
  listUnfinishedArtistImports,
  nextPendingArtistImportItem,
  transitionArtistImport,
  updateArtistImportItem,
  type ArtistImportOperation,
} from "./artistImportStore.ts";

const BUDGET_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_S = 60;
// Import slices queue behind the monitoring jobs each added artist queues,
// so albums are fetched as artists arrive rather than all at once.
const SLICE_PRIORITY = -1;
export const MAX_IMPORT_ARTISTS = 5000;

const DEFAULT_MONITORING = { monitored: true, useDefault: true };

type ImportDeps = {
  resolveMbid: (name: string) => Promise<string | null>;
  // Lidarr's own answer, with no fallback to the library, so an outage is
  // retried rather than read as "already there".
  findLidarrArtist: (mbid: string) => Promise<unknown>;
  manager: Pick<
    typeof LibraryManager,
    "resolveManagedBy" | "resolveArtistAddOptions" | "addArtistWithResolvedOptions"
  >;
};

const defaultDeps = async (): Promise<ImportDeps> => {
  const [{ musicbrainzResolveLibraryArtistMbid }, { libraryManager }, { lidarrClient }] =
    await Promise.all([
      import("../apiClients/musicbrainz.ts"),
      import("../libraryManager.ts"),
      import("../lidarrClient.ts"),
    ]);
  return {
    resolveMbid: musicbrainzResolveLibraryArtistMbid,
    findLidarrArtist: (mbid) => lidarrClient.getArtistByMbid(mbid),
    manager: libraryManager,
  };
};

type AddOptions = Awaited<ReturnType<ImportDeps["manager"]["resolveArtistAddOptions"]>>;
type SliceSetup = { managedBy: string; options: AddOptions };

const libraryArtistsStmt = db.prepare<
  [string],
  { id: number; managed_by: string | null; monitor_rules: string | null }
>(
  `SELECT artist.id, management.managed_by, management.monitor_rules
   FROM library_artists AS artist
   LEFT JOIN library_management AS management
     ON management.entity_kind = 'artist' AND management.entity_id = artist.id
   WHERE artist.mbid = ?`,
);

// An artist already monitored keeps its own rules. One that is only in the
// library, from scanned files, still takes the defaults.
const isMonitored = (
  management: { managed_by: string | null; monitor_rules: string | null } | undefined,
) =>
  management?.managed_by === "lidarr" ||
  (management?.managed_by === "aurral" && management.monitor_rules != null);

// The artist already in the library, if it should be left alone.
async function findExistingArtist(deps: ImportDeps, mbid: string, managedBy: string) {
  const local = libraryArtistsStmt.all(mbid);
  if (managedBy === "lidarr") {
    return (await deps.findLidarrArtist(mbid)) ? { artistId: local[0]?.id ?? null } : null;
  }
  const monitored = local.find(isMonitored);
  return monitored ? { artistId: monitored.id } : null;
}

const libraryStateStmt = db.prepare<
  [],
  { name: string; managed_by: string | null; monitor_rules: string | null }
>(
  `SELECT artist.name, management.managed_by, management.monitor_rules
   FROM library_artists AS artist
   LEFT JOIN library_management AS management
     ON management.entity_kind = 'artist' AND management.entity_id = artist.id`,
);

// A quick hint for the picker, by name. The import checks again by MBID.
export function describeLibraryStates(names: string[]) {
  const states = new Map<string, "monitored" | "unmonitored">();
  for (const row of libraryStateStmt.iterate()) {
    const key = getNormalizedText(row.name);
    if (!key || states.get(key) === "monitored") continue;
    states.set(
      key,
      isMonitored(
        row.managed_by
          ? { managed_by: row.managed_by, monitor_rules: row.monitor_rules }
          : undefined,
      )
        ? "monitored"
        : "unmonitored",
    );
  }
  return names.map((name) => states.get(getNormalizedText(name)) ?? null);
}

async function enqueueSlice(
  operationId: number,
  { delaySeconds = 0, dedupe = true }: { delaySeconds?: number; dedupe?: boolean } = {},
) {
  const { enqueueSystemTaskJob, findActiveHonkerJob } = await import("../honkerDb.ts");
  if (
    dedupe &&
    findActiveHonkerJob("system-task", (payload) => Number(payload?.operationId) === operationId, {
      recoverExpired: true,
      payloadKind: "artist-import",
    })
  )
    return;
  enqueueSystemTaskJob(
    { kind: "artist-import", operationId },
    { priority: SLICE_PRIORITY, ...(delaySeconds ? { delaySeconds } : {}) },
  );
}

export async function startArtistImport({
  ownerUserId,
  source,
  artists,
}: {
  ownerUserId: number;
  source: string;
  artists: { id: string; name: string }[];
}) {
  const operation = createArtistImport({ ownerUserId, source, artists });
  try {
    await enqueueSlice(operation.id, { dedupe: false });
  } catch (error) {
    transitionArtistImport(operation.id, ["running"], "failed", "The import could not be queued");
    throw error;
  }
  logger.info("artist-import", "Artist import queued", {
    operationId: operation.id,
    source,
    artistCount: artists.length,
  });
  return operation;
}

export function cancelArtistImport(id: number) {
  return transitionArtistImport(id, ["running"], "cancelled");
}

export async function resumeArtistImports() {
  for (const operation of listUnfinishedArtistImports()) await enqueueSlice(operation.id);
}

const ownerFor = (operation: ArtistImportOperation) => {
  const owner = userOps.getUserById(operation.ownerUserId);
  if (!owner || owner.status !== "active" || !hasPermission(owner, "addArtist")) return null;
  return {
    id: owner.id,
    username: owner.username,
    role: owner.role,
    permissions: owner.permissions,
  };
};

type ItemResult = { retry: true; reason: string } | { retry: false };

async function importItem(
  deps: ImportDeps,
  operation: ArtistImportOperation,
  item: NonNullable<ReturnType<typeof nextPendingArtistImportItem>>,
  user: NonNullable<ReturnType<typeof ownerFor>>,
  { managedBy, options }: SliceSetup,
): Promise<ItemResult> {
  const update = (fields: Parameters<typeof updateArtistImportItem>[2]) =>
    updateArtistImportItem(operation.id, item.position, fields);
  let mbid = item.mbid;
  try {
    mbid ||= await deps.resolveMbid(item.name);
  } catch (error) {
    return { retry: true, reason: asAppError(error)?.message || "The metadata service failed" };
  }
  if (!mbid) {
    update({ status: "unmatched", reason: "No single MusicBrainz artist has this name" });
    return { retry: false };
  }
  update({ mbid });
  try {
    const existing = await findExistingArtist(deps, mbid, managedBy);
    if (existing) {
      update({ status: "existing", artistId: existing.artistId });
      return { retry: false };
    }
    const added = await deps.manager.addArtistWithResolvedOptions(mbid, item.name, {
      ...options,
      user,
    });
    if (added && "error" in added && added.error) {
      const failure = added as { error: string; statusCode?: number; code?: string | null };
      if (failure.statusCode === 503 || failure.code === "metadata_unavailable") {
        return { retry: true, reason: failure.error };
      }
      update({ status: "failed", reason: failure.error });
      return { retry: false };
    }
    const artistId = Number((added as { id?: unknown } | null)?.id);
    update({ status: "added", artistId: Number.isSafeInteger(artistId) ? artistId : null });
    return { retry: false };
  } catch (error) {
    return { retry: true, reason: asAppError(error)?.message || "Adding the artist failed" };
  }
}

// The manager and add options are the same for every artist, so a bad
// saved setting stops the import once instead of failing each artist.
async function prepareSlice(
  deps: ImportDeps,
  user: NonNullable<ReturnType<typeof ownerFor>>,
): Promise<{ setup: SliceSetup } | { fail: string } | { retry: string }> {
  try {
    const managedBy = await deps.manager.resolveManagedBy(null);
    const options = await deps.manager.resolveArtistAddOptions({
      user,
      managedBy,
      monitoring: DEFAULT_MONITORING,
    });
    if ("error" in options && options.error) return { fail: String(options.error) };
    return { setup: { managedBy, options } };
  } catch (error) {
    const failure = asAppError(error);
    const message = failure?.message || "The library manager could not be reached";
    const status = Number(failure?.statusCode);
    return status >= 400 && status < 500 ? { fail: message } : { retry: message };
  }
}

// One bounded slice: artists are matched and added one at a time until the
// budget runs out. The next slice is queued until none are left, so a
// restart resumes where it stopped.
export async function runArtistImport(
  id: number,
  { budgetMs = BUDGET_MS, deps }: { budgetMs?: number; deps?: ImportDeps } = {},
): Promise<{ done: boolean; delaySeconds?: number }> {
  const deadline = Date.now() + budgetMs;
  let operation = getArtistImport(id);
  if (operation?.status !== "running") return { done: true };
  const user = ownerFor(operation);
  if (!user) {
    transitionArtistImport(
      id,
      ["running"],
      "failed",
      "The import's owner can no longer add artists",
    );
    return { done: true };
  }
  const resolved = deps || (await defaultDeps());
  const prepared = await prepareSlice(resolved, user);
  if ("fail" in prepared) {
    transitionArtistImport(id, ["running"], "failed", prepared.fail);
    return { done: true };
  }
  if ("retry" in prepared) {
    logger.warn("artist-import", "Artist import paused until the library manager answers", {
      operationId: id,
      reason: prepared.retry,
    });
    return { done: false, delaySeconds: RETRY_DELAY_S };
  }
  while (Date.now() < deadline) {
    operation = getArtistImport(id);
    if (operation?.status !== "running") return { done: true };
    const item = nextPendingArtistImportItem(id);
    if (!item) break;
    const result = await importItem(resolved, operation, item, user, prepared.setup);
    if (!result.retry) continue;
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      updateArtistImportItem(id, item.position, {
        status: "failed",
        reason: result.reason,
        attempts,
      });
      continue;
    }
    updateArtistImportItem(id, item.position, { reason: result.reason, attempts });
    logger.warn("artist-import", "Artist import paused after a failed lookup", {
      operationId: id,
      artist: item.name,
      attempts,
      reason: result.reason,
    });
    return { done: false, delaySeconds: RETRY_DELAY_S };
  }
  if (nextPendingArtistImportItem(id)) return { done: false };
  transitionArtistImport(id, ["running"], "complete");
  logger.info("artist-import", "Artist import finished", {
    operationId: id,
    ...countArtistImportItems(id),
  });
  return { done: true };
}

export async function processArtistImportJob(payload: { operationId?: unknown } = {}) {
  const operationId = Number(payload.operationId);
  if (!Number.isSafeInteger(operationId)) return;
  try {
    const { done, delaySeconds } = await runArtistImport(operationId);
    if (!done) await enqueueSlice(operationId, { delaySeconds, dedupe: false });
  } catch (error) {
    logger.warn("artist-import", "Artist import failed", {
      operationId,
      reason: safeLogDiagnostic(error),
    });
    transitionArtistImport(
      operationId,
      ["running"],
      "failed",
      asAppError(error)?.message || "The import stopped unexpectedly",
    );
  }
}

export function describeArtistImport(operation: ArtistImportOperation | null | undefined) {
  if (!operation) return null;
  const counts = countArtistImportItems(operation.id);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { ...operation, counts, total, processed: total - counts.pending };
}
