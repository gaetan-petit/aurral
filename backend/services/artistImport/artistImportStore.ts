import { db } from "../../config/db-sqlite.ts";
import type { ArtistImportItemsRow, ArtistImportOperationsRow } from "../../db/rows.ts";

export const ACTIVE_IMPORT_STATUSES = ["running"];
const FINISHED_STATUSES = new Set(["complete", "failed", "cancelled"]);
export const ITEM_STATUSES = new Set(["pending", "added", "existing", "unmatched", "failed"]);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type ArtistImportOperation = NonNullable<ReturnType<typeof toOperation>>;
export type ArtistImportItem = ReturnType<typeof toItem>;

const toOperation = (row: ArtistImportOperationsRow | undefined) =>
  row && {
    id: row.id,
    ownerUserId: row.owner_user_id,
    source: row.source,
    status: row.status,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  };

const toItem = (row: ArtistImportItemsRow) => ({
  position: row.position,
  externalId: row.external_id,
  name: row.name,
  status: row.status,
  mbid: row.mbid || null,
  artistId: row.artist_id ?? null,
  reason: row.reason || null,
  attempts: row.attempts,
});

export function getArtistImport(id: string | number) {
  return toOperation(
    db
      .prepare<[number], ArtistImportOperationsRow>(
        "SELECT * FROM artist_import_operations WHERE id = ?",
      )
      .get(Number(id)),
  );
}

export function getActiveArtistImport(ownerUserId: number) {
  return toOperation(
    db
      .prepare<[number, ...string[]], ArtistImportOperationsRow>(
        `SELECT * FROM artist_import_operations
         WHERE owner_user_id = ? AND status IN (${ACTIVE_IMPORT_STATUSES.map(() => "?").join(",")})
         ORDER BY id DESC LIMIT 1`,
      )
      .get(ownerUserId, ...ACTIVE_IMPORT_STATUSES),
  );
}

export function getLatestArtistImport(ownerUserId: number) {
  return (
    getActiveArtistImport(ownerUserId) ||
    toOperation(
      db
        .prepare<[number], ArtistImportOperationsRow>(
          "SELECT * FROM artist_import_operations WHERE owner_user_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(ownerUserId),
    )
  );
}

export function listUnfinishedArtistImports() {
  return db
    .prepare<string[], ArtistImportOperationsRow>(
      `SELECT * FROM artist_import_operations
       WHERE status IN (${ACTIVE_IMPORT_STATUSES.map(() => "?").join(",")})`,
    )
    .all(...ACTIVE_IMPORT_STATUSES)
    .map((row) => toOperation(row)!);
}

export class ArtistImportConflictError extends Error {
  declare code: string;
  declare operation: ArtistImportOperation;

  constructor(operation: ArtistImportOperation) {
    super("An artist import is already running. Wait for it to finish or cancel it.");
    this.code = "ARTIST_IMPORT_ACTIVE";
    this.operation = operation;
  }
}

function cleanupArtistImports(now: number) {
  db.prepare(
    `DELETE FROM artist_import_operations
     WHERE finished_at IS NOT NULL AND finished_at < ?`,
  ).run(now - RETENTION_MS);
}

// Stores the whole list in one transaction, so a large import is either
// queued in full or not at all.
export function createArtistImport({
  ownerUserId,
  source,
  artists,
}: {
  ownerUserId: number;
  source: string;
  artists: { id: string; name: string }[];
}) {
  return db
    .transaction(() => {
      const active = getActiveArtistImport(ownerUserId);
      if (active) throw new ArtistImportConflictError(active);
      const now = Date.now();
      cleanupArtistImports(now);
      const id = Number(
        db
          .prepare(
            `INSERT INTO artist_import_operations (owner_user_id, source, status, created_at, updated_at)
             VALUES (?, ?, 'running', ?, ?)`,
          )
          .run(ownerUserId, source, now, now).lastInsertRowid,
      );
      const insert = db.prepare(
        `INSERT INTO artist_import_items (operation_id, position, external_id, name, status, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      );
      artists.forEach((artist, position) => insert.run(id, position, artist.id, artist.name, now));
      return getArtistImport(id)!;
    })
    .immediate();
}

// Moves an import on only from the status it is expected to be in.
export function transitionArtistImport(
  id: string | number,
  from: string[],
  to: string,
  error: string | null = null,
) {
  const now = Date.now();
  return (
    db
      .prepare(
        `UPDATE artist_import_operations
         SET status = ?, error = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
      )
      .run(to, error, now, FINISHED_STATUSES.has(to) ? now : null, Number(id), ...from).changes > 0
  );
}

export function nextPendingArtistImportItem(id: string | number) {
  const row = db
    .prepare<[number], ArtistImportItemsRow>(
      `SELECT * FROM artist_import_items
       WHERE operation_id = ? AND status = 'pending'
       ORDER BY position LIMIT 1`,
    )
    .get(Number(id));
  return row ? toItem(row) : null;
}

export function updateArtistImportItem(
  id: string | number,
  position: number,
  {
    status,
    mbid,
    artistId,
    reason,
    attempts,
  }: {
    status?: string;
    mbid?: string | null;
    artistId?: number | null;
    reason?: string | null;
    attempts?: number;
  },
) {
  db.prepare(
    `UPDATE artist_import_items
     SET status = COALESCE(?, status),
       mbid = COALESCE(?, mbid),
       artist_id = COALESCE(?, artist_id),
       reason = ?,
       attempts = COALESCE(?, attempts),
       updated_at = ?
     WHERE operation_id = ? AND position = ?`,
  ).run(
    status ?? null,
    mbid ?? null,
    artistId ?? null,
    reason ?? null,
    attempts ?? null,
    Date.now(),
    Number(id),
    Number(position),
  );
  db.prepare("UPDATE artist_import_operations SET updated_at = ? WHERE id = ?").run(
    Date.now(),
    Number(id),
  );
}

export function countArtistImportItems(id: string | number) {
  const counts: Record<string, number> = {
    pending: 0,
    added: 0,
    existing: 0,
    unmatched: 0,
    failed: 0,
  };
  for (const row of db
    .prepare<[number], { status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM artist_import_items
       WHERE operation_id = ? GROUP BY status`,
    )
    .all(Number(id))) {
    counts[row.status] = row.count;
  }
  return counts;
}

export function listArtistImportItems(
  id: string | number,
  {
    statuses = [],
    offset = 0,
    limit = 50,
  }: { statuses?: string[]; offset?: number; limit?: number },
) {
  const filter = statuses.length ? `AND status IN (${statuses.map(() => "?").join(",")})` : "";
  return db
    .prepare<unknown[], ArtistImportItemsRow>(
      `SELECT * FROM artist_import_items
       WHERE operation_id = ? ${filter}
       ORDER BY position LIMIT ? OFFSET ?`,
    )
    .all(Number(id), ...statuses, limit, offset)
    .map(toItem);
}
