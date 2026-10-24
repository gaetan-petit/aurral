import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Music2, UserPlus } from "lucide-react";
import { Link } from "react-router";
import { ModalShell } from "../components/PlaylistModals";
import { DotLoader } from "../components/DotLoader";
import {
  cancelArtistImport,
  getArtistImport,
  getArtistImportItems,
  getFollowedSpotifyArtists,
  getLatestArtistImport,
  startSpotifyArtistImport,
  type ArtistImport,
  type FollowedSpotifyArtist,
} from "../utils/api/endpoints/artistImport.ts";
import {
  completeSpotifyOAuth,
  getSpotifyImportStatus,
  startSpotifyOAuth,
} from "../utils/api/endpoints/playlists.ts";
import { getMonitoringDefaults } from "../utils/api/endpoints/library.ts";
import { describeMonitoringRules, plural } from "../utils/monitoringRules.ts";
import {
  getOAuthCallbackUrl,
  isSpotifyAuthRequired,
  isSpotifyScopeRequired,
  openSpotifyOAuthPopup,
} from "../utils/spotifyOAuth.ts";
import { useLibraryDestination } from "../hooks/useLibraryDestination.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { asApiError } from "../utils/api/core.ts";
import { getApiErrorMessage } from "./onboardingUtils.tsx";

const PAGE_SIZE = 100;
// Library lists refresh as artists arrive, without refetching per artist.
const REFRESH_EVERY_ADDED = 25;

type ArtistImportModalProps = {
  open: boolean;
  onClose: () => void;
  onArtistsAdded?: () => void;
  showError?: (message: string) => void;
};

const formatCount = (count: number) => count.toLocaleString();

const searchKey = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase();

function ArtistRow({
  artist,
  selected,
  onToggle,
}: {
  artist: FollowedSpotifyArtist;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const monitored = artist.libraryState === "monitored";
  return (
    <label className="artist-import__row">
      <input type="checkbox" checked={selected} onChange={() => onToggle(artist.id)} />
      {artist.imageUrl ? (
        <img className="artist-import__image" src={artist.imageUrl} alt="" loading="lazy" />
      ) : (
        <span className="artist-import__image" aria-hidden="true" />
      )}
      <span className="artist-import__name">{artist.name}</span>
      {artist.libraryState ? (
        <span className="artist-import__badge">{monitored ? "Monitored" : "In library"}</span>
      ) : null}
    </label>
  );
}

function ImportSummary({ operation }: { operation: ArtistImport }) {
  const [showMissing, setShowMissing] = useState(false);
  const [limit, setLimit] = useState(200);
  const missingCount = operation.counts.unmatched + operation.counts.failed;
  const missingQuery = useQuery({
    queryKey: [...queryKeys.artistImportItems(operation.id, limit), missingCount],
    queryFn: () => getArtistImportItems(operation.id, { status: ["unmatched", "failed"], limit }),
    enabled: showMissing && missingCount > 0,
  });
  const running = operation.status === "running";
  const percent = operation.total ? Math.round((operation.processed / operation.total) * 100) : 0;
  return (
    <div className="artist-import__progress">
      <div className="artist-import__progress-head">
        <span>
          {running
            ? `${formatCount(operation.processed)} of ${formatCount(operation.total)} artists`
            : operation.status === "cancelled"
              ? "Import cancelled"
              : operation.status === "failed"
                ? "Import stopped"
                : "Import finished"}
        </span>
        {running ? <span>{percent}%</span> : null}
      </div>
      <div
        className="artist-import__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={operation.total}
        aria-valuenow={operation.processed}
        aria-label="Artist import progress"
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <dl className="artist-import__counts">
        <div>
          <dt>Added</dt>
          <dd>{formatCount(operation.counts.added)}</dd>
        </div>
        <div>
          <dt>Already in library</dt>
          <dd>{formatCount(operation.counts.existing)}</dd>
        </div>
        <div>
          <dt>Not found</dt>
          <dd>{formatCount(operation.counts.unmatched)}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{formatCount(operation.counts.failed)}</dd>
        </div>
      </dl>
      {operation.error ? <p className="settings-page__error">{operation.error}</p> : null}
      {running ? (
        <p className="settings-page__hint">
          Artists are added one at a time, so their albums download gradually. You can close this
          window; the import keeps going.
        </p>
      ) : null}
      {missingCount > 0 ? (
        showMissing ? (
          <div className="playlist-import__list-panel">
            <div className="playlist-import__playlist-list" aria-label="Artists not added">
              {missingQuery.isLoading ? (
                <div className="playlist-import__list-status">
                  <DotLoader size="sm" label={null} />
                </div>
              ) : (
                (missingQuery.data?.items || []).map((item) => (
                  <div key={item.position} className="artist-import__missing">
                    <span className="artist-import__name">{item.name}</span>
                    <span className="artist-import__reason">{item.reason}</span>
                  </div>
                ))
              )}
              {(missingQuery.data?.items.length || 0) >= limit ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setLimit((value) => value + 200)}
                >
                  Show more
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowMissing(true)}
          >
            Show {plural(missingCount, "artist")} not added
          </button>
        )
      ) : null}
    </div>
  );
}

export function ArtistImportModal({
  open,
  onClose,
  onArtistsAdded,
  showError,
}: ArtistImportModalProps) {
  const [operationId, setOperationId] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");
  const [deselected, setDeselected] = useState<Set<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const destination = useLibraryDestination();
  const refreshedAtRef = useRef(0);

  const statusQuery = useQuery({
    queryKey: queryKeys.spotifyImportStatus,
    queryFn: () => getSpotifyImportStatus(),
    enabled: open,
    staleTime: 0,
  });
  const connected = Boolean(statusQuery.data?.connected);
  const canReadArtists = Boolean(statusQuery.data?.canReadFollowedArtists);

  // Reopening the window shows an import that is still running.
  const latestQuery = useQuery({
    queryKey: queryKeys.latestArtistImport,
    queryFn: () => getLatestArtistImport(),
    enabled: open,
    staleTime: 0,
  });
  const latest = latestQuery.data?.operation;
  const latestFresh = latestQuery.isFetchedAfterMount;
  useEffect(() => {
    if (open && latestFresh && latest?.status === "running") setOperationId(latest.id);
  }, [open, latestFresh, latest?.id, latest?.status]);

  const operationQuery = useQuery({
    queryKey: queryKeys.artistImport(operationId ?? 0),
    queryFn: () => getArtistImport(operationId!).then((result) => result.operation),
    enabled: open && operationId != null,
    staleTime: 0,
    refetchInterval: (current) => (current.state.data?.status === "running" ? 2000 : false),
  });
  const operation = (operationId != null && operationQuery.data) || null;

  const artistsQuery = useQuery({
    queryKey: queryKeys.followedSpotifyArtists,
    queryFn: () => getFollowedSpotifyArtists(),
    enabled: open && connected && canReadArtists && operationId == null,
    staleTime: 60_000,
    retry: false,
  });
  const artistsError = artistsQuery.error ? asApiError(artistsQuery.error) : null;
  const needsReconnect = connected && (!canReadArtists || isSpotifyScopeRequired(artistsError));

  useEffect(() => {
    if (!isSpotifyAuthRequired(artistsError)) return;
    queryClient.setQueryData(queryKeys.spotifyImportStatus, {
      connected: false,
      displayName: null,
      connectedAt: null,
      canReadFollowedArtists: false,
    });
  }, [artistsError]);

  const defaultsQuery = useQuery({
    queryKey: queryKeys.monitoringDefaults,
    queryFn: ({ signal }) => getMonitoringDefaults({ signal }),
    enabled: open && destination.primary === "aurral",
  });

  // Library lists catch up every few added artists, then once at the end.
  const added = operation?.counts.added ?? 0;
  const finished = operation != null && operation.status !== "running";
  useEffect(() => {
    if (!operation) return;
    if (
      added - refreshedAtRef.current >= REFRESH_EVERY_ADDED ||
      (finished && added > refreshedAtRef.current)
    ) {
      refreshedAtRef.current = added;
      onArtistsAdded?.();
    }
  }, [operation, added, finished, onArtistsAdded]);

  const artists = artistsQuery.data?.artists;
  // Artists that look monitored already start unticked. The match is by
  // name only, so they can still be ticked; the import checks the MBID.
  const [loadedList, setLoadedList] = useState<typeof artists>(undefined);
  if (artists !== loadedList) {
    setLoadedList(artists);
    setDeselected(
      new Set(
        (artists || [])
          .filter((artist) => artist.libraryState === "monitored")
          .map((artist) => artist.id),
      ),
    );
  }
  const filtered = useMemo(() => {
    const key = searchKey(query.trim());
    return key
      ? (artists || []).filter((artist) => searchKey(artist.name).includes(key))
      : artists || [];
  }, [artists, query]);
  const selected = useMemo(
    () => (artists || []).filter((artist) => !deselected.has(artist.id)),
    [artists, deselected],
  );

  const toggle = (id: string) =>
    setDeselected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setFiltered = (select: boolean) =>
    setDeselected((current) => {
      const next = new Set(current);
      for (const artist of filtered) {
        if (select) next.delete(artist.id);
        else next.add(artist.id);
      }
      return next;
    });

  const connectSpotify = useMutation({
    mutationFn: async () => {
      const { oauthUrl } = await startSpotifyOAuth(getOAuthCallbackUrl());
      const tokens = await openSpotifyOAuthPopup(oauthUrl);
      return completeSpotifyOAuth(tokens);
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.followedSpotifyArtists });
      queryClient.removeQueries({ queryKey: queryKeys.playlistImportPrefix("spotify") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.spotifyImportStatus });
    },
    onError: (error) => showError?.(getApiErrorMessage(error, "Failed to connect Spotify")),
  });

  const startImport = useMutation({
    mutationFn: () =>
      startSpotifyArtistImport(selected.map((artist) => ({ id: artist.id, name: artist.name }))),
    onSuccess: (result) => {
      refreshedAtRef.current = 0;
      setConfirming(false);
      if (result.operation) {
        queryClient.setQueryData(queryKeys.artistImport(result.operation.id), result.operation);
        setOperationId(result.operation.id);
      }
    },
    onError: (error) => showError?.(getApiErrorMessage(error, "Failed to start the import")),
  });

  const cancelImport = useMutation({
    mutationFn: () => cancelArtistImport(operationId!),
    onSuccess: (result) =>
      queryClient.setQueryData(queryKeys.artistImport(operationId!), result.operation),
    onError: (error) => showError?.(getApiErrorMessage(error, "Failed to cancel the import")),
  });

  const close = () => {
    if (finished) {
      setOperationId(null);
      setDeselected(new Set());
      queryClient.removeQueries({ queryKey: queryKeys.followedSpotifyArtists });
    }
    setConfirming(false);
    setQuery("");
    setVisibleCount(PAGE_SIZE);
    onClose();
  };

  const defaultsLabel =
    destination.primary === "lidarr"
      ? "Lidarr's default monitoring option"
      : describeMonitoringRules(defaultsQuery.data?.rules) || "your default monitoring rules";

  const renderBody = () => {
    if (operation) return <ImportSummary operation={operation} />;
    if (statusQuery.isLoading || latestQuery.isLoading) {
      return (
        <div className="playlist-import__list-status">
          <DotLoader size="sm" label={null} />
        </div>
      );
    }
    if (!connected || needsReconnect) {
      return (
        <div className="playlist-import__empty">
          <div className="playlist-import__empty-icon" aria-hidden="true">
            <Music2 />
          </div>
          <p className="playlist-import__empty-title">
            {needsReconnect ? "Reconnect Spotify" : "Connect your Spotify account"}
          </p>
          {needsReconnect ? (
            <p className="playlist-import__empty-copy">
              Spotify needs your permission to read the artists you follow.
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => connectSpotify.mutate()}
            disabled={connectSpotify.isPending}
          >
            {connectSpotify.isPending ? <DotLoader size="sm" label={null} /> : null}
            {needsReconnect ? "Reconnect Spotify" : "Connect Spotify"}
          </button>
        </div>
      );
    }
    if (confirming) {
      return (
        <div className="artist-import__confirm">
          <p className="artist-import__confirm-title">
            Add {plural(selected.length, "artist")} to your library?
          </p>
          <p>
            Each artist is monitored with <strong>{defaultsLabel}</strong>. This can download a lot
            of music.
          </p>
          <p className="settings-page__hint">
            Artists are added one at a time, so downloads start gradually. Artists that match no
            single MusicBrainz artist are skipped and listed at the end.{" "}
            {destination.primary === "aurral" ? (
              <Link to="/settings/monitoring" onClick={close}>
                Change default rules
              </Link>
            ) : null}
          </p>
        </div>
      );
    }
    return (
      <>
        <div className="playlist-import__account">
          <span className="playlist-import__account-status" aria-hidden="true" />
          <span className="playlist-import__account-label">
            Signed in as <strong>{statusQuery.data?.displayName || "Spotify"}</strong>
          </span>
        </div>
        <div className="playlist-import__list-panel">
          <input
            type="search"
            className="input playlist-import__search"
            placeholder="Search followed artists"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
            disabled={artistsQuery.isLoading}
          />
          <div className="artist-import__toolbar">
            <span>
              {artists
                ? `${formatCount(artists.length)} followed · ${formatCount(selected.length)} selected`
                : "Loading followed artists…"}
            </span>
            <span className="artist-import__toolbar-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFiltered(true)}
                disabled={!filtered.length}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFiltered(false)}
                disabled={!filtered.length}
              >
                Select none
              </button>
            </span>
          </div>
          <div className="artist-import__list" aria-label="Followed Spotify artists">
            {artistsQuery.isLoading ? (
              <div className="playlist-import__list-status">
                <DotLoader size="sm" label={null} />
                <span>Loading followed artists…</span>
              </div>
            ) : artistsQuery.isError ? (
              <div className="playlist-import__list-status">
                {getApiErrorMessage(artistsQuery.error, "Failed to load followed artists")}
              </div>
            ) : filtered.length === 0 ? (
              <div className="playlist-import__list-status">
                {artists?.length ? "No artists match" : "You don't follow any artists on Spotify"}
              </div>
            ) : (
              <>
                {filtered.slice(0, visibleCount).map((artist) => (
                  <ArtistRow
                    key={artist.id}
                    artist={artist}
                    selected={!deselected.has(artist.id)}
                    onToggle={toggle}
                  />
                ))}
                {filtered.length > visibleCount ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm artist-import__more"
                    onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                  >
                    Show more ({formatCount(filtered.length - visibleCount)} left)
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </>
    );
  };

  const running = operation?.status === "running";
  return (
    <ModalShell
      open={open}
      title="Import artists"
      description={operation ? undefined : "Add the artists you follow on Spotify."}
      onClose={close}
      disableClose={startImport.isPending}
      footer={
        operation ? (
          <>
            {running ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => cancelImport.mutate()}
                disabled={cancelImport.isPending}
              >
                Stop import
              </button>
            ) : null}
            <button type="button" className="btn btn-primary btn-sm" onClick={close}>
              {running ? "Close" : "Done"}
            </button>
          </>
        ) : confirming ? (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirming(false)}
              disabled={startImport.isPending}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => startImport.mutate()}
              disabled={startImport.isPending || !selected.length}
            >
              {startImport.isPending ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <UserPlus className="artist-icon-sm" />
              )}
              Start import
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setConfirming(true)}
              disabled={!selected.length || !connected || needsReconnect}
            >
              <UserPlus className="artist-icon-sm" />
              Import {selected.length ? plural(selected.length, "artist") : "artists"}
            </button>
          </>
        )
      }
    >
      <div className="playlist-import artist-import">{renderBody()}</div>
    </ModalShell>
  );
}
