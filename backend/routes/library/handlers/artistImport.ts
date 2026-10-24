import type { Request, Response, Router } from "express";
import { noCache } from "../../../middleware/cache.ts";
import { requireAuth, requirePermission } from "../../../middleware/requirePermission.ts";
import {
  cancelArtistImport,
  describeArtistImport,
  describeLibraryStates,
  MAX_IMPORT_ARTISTS,
  startArtistImport,
} from "../../../services/artistImport/artistImport.ts";
import {
  ArtistImportConflictError,
  getArtistImport,
  getLatestArtistImport,
  ITEM_STATUSES,
  listArtistImportItems,
} from "../../../services/artistImport/artistImportStore.ts";
import { spotifyClient } from "../../../services/spotify/spotifyClient.ts";
import { sendSpotifyError } from "../../shared/spotifyErrors.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";

// Only the user who started an import sees it.
function findImport(req: Request<{ id: string }>, res: Response) {
  const operation = getArtistImport(req.params.id);
  if (!operation || operation.ownerUserId !== req.user!.id) {
    res.status(404).json({ error: "not_found", message: "Artist import not found" });
    return null;
  }
  return operation;
}

const parseArtists = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const artists: { id: string; name: string }[] = [];
  for (const entry of value) {
    const id = String(entry?.id || "").trim();
    const name = String(entry?.name || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    artists.push({ id, name: name.slice(0, 500) });
  }
  return artists;
};

export type GetFollowedSpotifyArtistsResponse = {
  artists: (Awaited<ReturnType<typeof spotifyClient.listFollowedArtists>>[number] & {
    libraryState: "monitored" | "unmonitored" | null;
  })[];
  total: number;
};

export type ArtistImportResponse = { operation: ReturnType<typeof describeArtistImport> };

export type ArtistImportItemsResponse = {
  items: ReturnType<typeof listArtistImportItems>;
  offset: number;
  limit: number;
};

export function registerArtistImport(router: Router) {
  router.get(
    "/import/spotify/artists",
    requireAuth,
    requirePermission("addArtist"),
    noCache,
    async (req, res) => {
      try {
        const artists = await spotifyClient.listFollowedArtists(req.user!.id);
        const states = describeLibraryStates(artists.map((artist) => artist.name));
        res.json({
          artists: artists.map((artist, index) => ({ ...artist, libraryState: states[index] })),
          total: artists.length,
        });
      } catch (error) {
        logger.warn("artist-import", "Listing followed Spotify artists failed", {
          reason: safeLogDiagnostic(error),
        });
        sendSpotifyError(res, error, "Failed to fetch followed Spotify artists");
      }
    },
  );

  router.post(
    "/import/spotify/artists",
    requireAuth,
    requirePermission("addArtist"),
    async (req, res) => {
      const artists = parseArtists(req.body?.artists);
      if (!artists?.length) {
        return res
          .status(400)
          .json({ error: "invalid_request", message: "Choose artists to import" });
      }
      if (artists.length > MAX_IMPORT_ARTISTS) {
        return res.status(400).json({
          error: "invalid_request",
          message: `Import at most ${MAX_IMPORT_ARTISTS} artists at a time`,
        });
      }
      try {
        const operation = await startArtistImport({
          ownerUserId: req.user!.id,
          source: "spotify",
          artists,
        });
        res.status(202).json({ operation: describeArtistImport(operation) });
      } catch (error) {
        if (error instanceof ArtistImportConflictError) {
          return res.status(409).json({
            error: "import_active",
            message: error.message,
            operation: describeArtistImport(error.operation),
          });
        }
        res.status(500).json({
          error: "Failed to start the artist import",
          message: asAppError(error)?.message || "Unknown error",
        });
      }
    },
  );

  // The newest import, so the import window can show one that is running or
  // has just finished.
  router.get(
    "/import/artists/latest",
    requireAuth,
    requirePermission("addArtist"),
    noCache,
    (req, res) => {
      res.json({ operation: describeArtistImport(getLatestArtistImport(req.user!.id)) });
    },
  );

  router.get<"/import/artists/:id">(
    "/import/artists/:id",
    requireAuth,
    requirePermission("addArtist"),
    noCache,
    (req, res) => {
      const operation = findImport(req, res);
      if (operation) res.json({ operation: describeArtistImport(operation) });
    },
  );

  router.get<"/import/artists/:id/items">(
    "/import/artists/:id/items",
    requireAuth,
    requirePermission("addArtist"),
    noCache,
    (req, res) => {
      const operation = findImport(req, res);
      if (!operation) return;
      const statuses = String(req.query.status || "")
        .split(",")
        .map((status) => status.trim())
        .filter((status) => ITEM_STATUSES.has(status));
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit), 10) || 50));
      const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
      res.json({
        items: listArtistImportItems(operation.id, { statuses, offset, limit }),
        offset,
        limit,
      });
    },
  );

  router.post<"/import/artists/:id/cancel">(
    "/import/artists/:id/cancel",
    requireAuth,
    requirePermission("addArtist"),
    (req, res) => {
      const operation = findImport(req, res);
      if (!operation) return;
      cancelArtistImport(operation.id);
      res.json({ operation: describeArtistImport(getArtistImport(operation.id)) });
    },
  );
}
