import { Fragment, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import {
  AlertCircle,
  EyeOff,
  ImagePlus,
  Info,
  Search,
  Share,
  Trash2,
} from "../../components/icons";
import AddActionButton from "../../components/AddActionButton";
import { AurralAlbumStatus } from "../../components/AurralAlbumStatus";
import {
  CollectionHeader,
  CollectionPage,
  CollectionPlayButtons,
} from "../../components/CollectionHeader";
import { LibraryItemMenu, type LibraryMenuItem } from "../../components/LibraryItemMenu";
import RouteLink from "../../components/RouteLink";
import {
  SkeletonShape,
  SkeletonStatus,
  SkeletonText,
  SkeletonTrackList,
} from "../../components/Skeletons";
import Tooltip from "../../components/Tooltip";
import { FavoriteButton, TrackList, type TrackListRow } from "../../components/TrackList";
import { useAuth } from "../../contexts/AuthContext";
import { useAudioQueue } from "../../contexts/audioQueueContext";
import { useDiscoverRecent } from "../../contexts/DiscoverRecentProvider";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useQueueTrackActions } from "../../hooks/useQueueTrackActions";
import { useShareAction } from "../../hooks/useShareAction";
import { useWebSocketChannel } from "../../hooks/useWebSocket";
import type { AlbumRouteState } from "../../navigation/albumRoute.tsx";
import { readRouteSeed } from "../../navigation/routeSeed.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import {
  libraryAlbumLookupQueryOptions,
  releaseGroupDetailsQueryOptions,
} from "../../queryOptions.ts";
import { asApiError } from "../../utils/api/core.ts";
import { getReleaseGroupTracks } from "../../utils/api/endpoints/artists.ts";
import { clearLibraryPageCache, getDownloadStatus } from "../../utils/api/endpoints/library.ts";
import { buildAlbumAddAction, countReleaseTracks } from "../../utils/albumAddAction";
import { canRemoveLibraryAlbum } from "../../utils/libraryDestination.ts";
import { EMPTY_LIBRARY, favoriteId, firstAvailableFile } from "../../utils/libraryPageData.ts";
import type { WebSocketChannelMessage } from "../../../../backend/services/websocketService.ts";
import { albumPath, parseAlbumRef } from "../../../../lib/albumPath.ts";
import {
  getApiErrorMessage,
  mergeReleaseDetails,
  resolveReleaseLibraryDisplay,
  type ReleaseGroup,
} from "../ArtistDetails/utils";
import { libraryPreviewData, libraryPreviewFavorites } from "../libraryPreviewData";
import { libraryViewQueryOptions } from "../libraryViewQuery.ts";
import { useLibraryActions } from "../library/useLibraryActions.tsx";
import {
  Cover,
  EmptyState,
  formatDuration,
  isAlbumArtistCredit,
  trackDurationMs,
  type LibraryRemoval,
} from "../library/libraryShared.tsx";
import { buildAlbumHeaderMeta } from "./albumHeaderMeta.ts";
import { mergeAlbumTracks } from "./mergeAlbumTracks.ts";
import { OwnedTrackMark, useReleasePreviewQueue, useReleaseTracks } from "./releaseTracks.tsx";
import { useAlbumDownload } from "./useAlbumDownload.ts";
import { useLibraryAlbumState } from "./useLibraryAlbumState.ts";
import { useReleaseCover } from "./useReleaseCover.ts";

const LIBRARY_SOURCE = { type: "native-library", id: "library", label: "Library" };

const ACTIVE_DOWNLOAD_STATUSES = new Set([
  "adding",
  "searching",
  "downloading",
  "moving",
  "processing",
]);

const handleLibraryScanMessage = (message: WebSocketChannelMessage) => {
  if (message?.type !== "library_scan_completed") return;
  clearLibraryPageCache();
  queryClient.invalidateQueries({
    queryKey: queryKeys.libraryAlbumTracksPrefix,
    refetchType: "none",
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPagePrefix });
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });
};

function AlbumPage() {
  const { ref: routeRef } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const locationState: AlbumRouteState | null = location.state || null;
  const { bootstrap, hasPermission } = useAuth();
  const { showError } = useToast();
  const share = useShareAction();
  const { isShuffleEnabled } = useAudioQueue();
  const getQueueItems = useQueueTrackActions();
  const { isDiscoverSectionActive } = useDiscoverRecent();
  const canAddAlbum = hasPermission("addAlbum");
  const forcePreview = import.meta.env.DEV && searchParams.get("preview") === "1";
  const previewQuery = forcePreview ? "?preview=1" : "";

  useWebSocketChannel("library", handleLibraryScanMessage);

  const albumRef = parseAlbumRef(routeRef);
  const routeReleaseGroupMbid = albumRef?.kind === "release" ? albumRef.releaseGroupMbid : null;

  const albumLookupQuery = useQuery(libraryAlbumLookupQueryOptions(routeReleaseGroupMbid));
  const libraryInfo = useMemo(() => {
    const entry = routeReleaseGroupMbid
      ? albumLookupQuery.data?.[routeReleaseGroupMbid]
      : undefined;
    return entry?.inLibrary ? entry : null;
  }, [albumLookupQuery.data, routeReleaseGroupMbid]);
  const canonicalAlbumId =
    libraryInfo && "canonicalAlbumId" in libraryInfo ? libraryInfo.canonicalAlbumId : null;

  const libraryAlbumId =
    albumRef?.kind === "library"
      ? albumRef.libraryAlbumId
      : locationState?.libraryAlbumId != null
        ? String(locationState.libraryAlbumId)
        : canonicalAlbumId != null
          ? String(canonicalAlbumId)
          : null;

  const libraryQueryOptions = useMemo(
    () => libraryViewQueryOptions({ preview: forcePreview, albumId: libraryAlbumId || "none" }),
    [forcePreview, libraryAlbumId],
  );
  const libraryQuery = useQuery({
    ...libraryQueryOptions,
    enabled: Boolean(libraryAlbumId) && !forcePreview,
  });
  const queryData = libraryQuery.data;
  const isPreviewLibrary = forcePreview || queryData?.isPreview === true;
  const library = queryData?.library || (forcePreview ? libraryPreviewData : EMPTY_LIBRARY);
  const favoriteIds = useMemo(
    () =>
      queryData?.favoriteIds ||
      (isPreviewLibrary ? new Set(libraryPreviewFavorites) : new Set<string>()),
    [isPreviewLibrary, queryData?.favoriteIds],
  );
  const libraryLoading = Boolean(libraryAlbumId) && !forcePreview && libraryQuery.isPending;
  const libraryError = libraryQuery.error
    ? getApiErrorMessage(libraryQuery.error) || "Library unavailable"
    : null;

  const handleLibraryEntityRemoved = useCallback(
    (removal: LibraryRemoval) => {
      if (removal.kind === "album" && String(removal.entity.id) === String(libraryAlbumId)) {
        navigate("/library/albums" + previewQuery);
      }
    },
    [libraryAlbumId, navigate, previewQuery],
  );
  const actions = useLibraryActions({
    libraryQueryKey: libraryQueryOptions.queryKey,
    library,
    favoriteIds,
    isPreviewLibrary,
    forcePreview,
    previewQuery,
    librarySource: LIBRARY_SOURCE,
    onRemoved: handleLibraryEntityRemoved,
  });
  const libraryAlbum = libraryAlbumId
    ? actions.albumsById.get(String(libraryAlbumId)) || null
    : null;
  const libraryArtist = libraryAlbum ? actions.getArtistForAlbum(libraryAlbum) || null : null;
  const albumState = useLibraryAlbumState({ libraryAlbum, actions, isPreviewLibrary });
  const albumTracks = albumState.albumTracks;

  // A library album that has a release group lives at that release group's URL.
  const libraryReleaseGroupMbid = libraryAlbum?.releaseGroupMbid || null;
  useEffect(() => {
    if (albumRef?.kind !== "library" || !libraryAlbum || !libraryReleaseGroupMbid) return;
    navigate(
      { pathname: albumPath(libraryReleaseGroupMbid), search: location.search },
      { replace: true, state: { ...locationState, libraryAlbumId: String(libraryAlbum.id) } },
    );
  }, [
    albumRef?.kind,
    libraryAlbum,
    libraryReleaseGroupMbid,
    location.search,
    locationState,
    navigate,
  ]);

  const releaseGroupMbid = routeReleaseGroupMbid || libraryReleaseGroupMbid;
  const routeSeed = readRouteSeed(locationState);
  const focusRelease = locationState?.focusReleaseGroup;
  const baseRelease = useMemo<ReleaseGroup>(
    () => ({
      id: releaseGroupMbid || undefined,
      title: String(focusRelease?.title || "").trim(),
      "first-release-date": focusRelease?.firstReleaseDate || "",
      "primary-type": focusRelease ? focusRelease.primaryType || "Album" : undefined,
      "secondary-types": Array.isArray(focusRelease?.secondaryTypes)
        ? focusRelease.secondaryTypes
        : [],
      rating: focusRelease?.rating || null,
      _coverUrl: focusRelease?.coverUrl || "",
      _deezerAlbumId: focusRelease?.deezerAlbumId || "",
    }),
    [focusRelease, releaseGroupMbid],
  );
  const releaseDetailsQuery = useQuery(releaseGroupDetailsQueryOptions(releaseGroupMbid));
  const release = useMemo(
    () => mergeReleaseDetails(baseRelease, releaseDetailsQuery.data),
    [baseRelease, releaseDetailsQuery.data],
  );
  const artistCredits = releaseDetailsQuery.data?.["artist-credit"];
  const creditedArtist = Array.isArray(artistCredits)
    ? artistCredits.find((credit) => credit?.artist?.id === locationState?.artistMbid) ||
      artistCredits[0]
    : null;
  const artistMbid =
    locationState?.artistMbid || libraryArtist?.mbid || creditedArtist?.artist?.id || null;
  const artistName =
    libraryArtist?.name ||
    locationState?.artistName ||
    creditedArtist?.name ||
    routeSeed?.artistName ||
    libraryAlbum?.albumArtist ||
    "";
  const title = libraryAlbum?.title || release.title || routeSeed?.title || "";
  const headerPending = !title && (libraryLoading || releaseDetailsQuery.isPending);

  const trackContext = useMemo(
    () => ({
      artistMbid: artistMbid || undefined,
      artistName,
      albumTitle: release.title || title,
      releaseType: release["primary-type"] || "",
      releaseDate: release["first-release-date"] || "",
      deezerAlbumId: release._deezerAlbumId || "",
    }),
    [artistMbid, artistName, release, title],
  );
  const artistResolved = Boolean(
    locationState?.artistMbid || libraryArtist || !releaseDetailsQuery.isPending,
  );
  const tracksQuery = useQuery({
    queryKey: queryKeys.releaseGroupTracks(releaseGroupMbid, trackContext),
    queryFn: ({ signal }) =>
      getReleaseGroupTracks(releaseGroupMbid ?? "", { ...trackContext, signal }),
    enabled: Boolean(releaseGroupMbid) && artistResolved,
    staleTime: 5 * 60 * 1000,
  });
  const releaseTracks = useMemo(
    () => (Array.isArray(tracksQuery.data) ? tracksQuery.data : []),
    [tracksQuery.data],
  );
  const tracksLoading = Boolean(releaseGroupMbid) && tracksQuery.isPending;

  useEffect(() => {
    if (tracksQuery.error && !albumTracks.length) showError("Failed to load tracks");
  }, [albumTracks.length, showError, tracksQuery.error]);

  const lookupLibraryAlbumId = libraryInfo?.libraryAlbumId
    ? String(libraryInfo.libraryAlbumId)
    : null;
  const { isConnected: downloadStatusWsConnected } = useWebSocketChannel(
    "downloads",
    (msg) => {
      if (msg?.type !== "download_statuses" || !lookupLibraryAlbumId) return;
      const next = msg.statuses?.[lookupLibraryAlbumId];
      if (!next) return;
      queryClient.setQueryData(queryKeys.downloadStatus([lookupLibraryAlbumId]), (current) => ({
        ...(current || {}),
        [lookupLibraryAlbumId]: next,
      }));
      if (next.status === "added") {
        queryClient.invalidateQueries({
          queryKey: queryKeys.libraryAlbumLookup([routeReleaseGroupMbid]),
        });
      }
    },
    { enabled: Boolean(lookupLibraryAlbumId) },
  );
  const downloadStatusQuery = useQuery({
    queryKey: queryKeys.downloadStatus(lookupLibraryAlbumId ? [lookupLibraryAlbumId] : []),
    queryFn: ({ signal }) =>
      getDownloadStatus([lookupLibraryAlbumId], { signal, bypassCache: true }),
    enabled: Boolean(lookupLibraryAlbumId),
    staleTime: 4_000,
    refetchInterval: (currentQuery) => {
      if (
        !lookupLibraryAlbumId ||
        downloadStatusWsConnected ||
        (typeof document !== "undefined" && document.hidden)
      ) {
        return false;
      }
      const status = currentQuery.state.data?.[lookupLibraryAlbumId]?.status;
      return ACTIVE_DOWNLOAD_STATUSES.has(String(status)) || status === "failed" ? 15_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const downloadStatus =
    (lookupLibraryAlbumId && downloadStatusQuery.data?.[lookupLibraryAlbumId]) || null;

  const libraryDisplay = useMemo(
    () =>
      resolveReleaseLibraryDisplay(
        countReleaseTracks(libraryInfo, releaseTracks.length),
        downloadStatus,
      ),
    [downloadStatus, libraryInfo, releaseTracks.length],
  );
  const releaseDownloading =
    !libraryDisplay.isComplete &&
    (actions.isAlbumDownloading(releaseGroupMbid) ||
      ACTIVE_DOWNLOAD_STATUSES.has(String(downloadStatus?.status)));

  const libraryCover = libraryAlbum ? actions.getAlbumCover(libraryAlbum) : "";
  const cover = useReleaseCover({
    releaseGroupMbid,
    seedUrl: release._coverUrl || routeSeed?.coverUrl || "",
    artistName,
    albumTitle: release.title,
    enabled: !libraryCover,
  });
  const coverUrl = cover.src;

  const artwork = libraryCover || coverUrl;
  const playbackSource = useMemo(
    () => ({
      type: "release",
      id: releaseGroupMbid || String(libraryAlbum?.id || ""),
      label: title || "Release",
    }),
    [libraryAlbum?.id, releaseGroupMbid, title],
  );
  const preview = useReleasePreviewQueue({
    release,
    trackKey: releaseGroupMbid || undefined,
    tracks: releaseTracks,
    artistName,
    artistMbid,
    artwork,
    playbackSource,
  });
  const releaseRows = useReleaseTracks({
    release,
    trackKey: releaseGroupMbid || undefined,
    artistName,
    artistMbid,
    albumMbid: releaseGroupMbid,
    preview,
    playbackSource,
    albumDownloading: releaseDownloading,
    ownedTrackMbids: libraryInfo?.ownedTrackMbids,
    playlists: actions,
  });

  const { setLibrary } = actions;
  const { reloadLibraryAlbumTracks, updateAlbumMonitoringState } = albumState;
  const handleLibraryAlbumRequested = useCallback(
    async (managedBy: string) => {
      if (!libraryAlbum) return;
      setLibrary((current) => ({
        ...current,
        albums: current.albums.map((entry) =>
          String(entry.id) === String(libraryAlbum.id)
            ? { ...entry, managedBy: managedBy === "lidarr" ? "lidarr" : "aurral" }
            : entry,
        ),
      }));
      updateAlbumMonitoringState(libraryAlbum.id, { monitored: true });
      await reloadLibraryAlbumTracks();
    },
    [libraryAlbum, reloadLibraryAlbumTracks, setLibrary, updateAlbumMonitoringState],
  );
  const { downloadAlbum, requesting, ownerConflict } = useAlbumDownload({
    releaseGroupMbid,
    albumTitle: title,
    artistMbid,
    artistName,
    libraryAlbum,
    libraryArtist,
    triggerSearch: libraryDisplay.triggerSearch,
    onLibraryAlbumRequested: handleLibraryAlbumRequested,
  });

  const merged = useMemo(
    () =>
      mergeAlbumTracks({
        libraryTracks: albumTracks,
        releaseTracks,
        libraryAlbumId: libraryAlbum?.id ?? null,
        releaseKey: releaseGroupMbid || "release",
      }),
    [albumTracks, libraryAlbum?.id, releaseGroupMbid, releaseTracks],
  );
  const hasMissingTracks = merged.some(
    (entry) => !entry.libraryTrack || !firstAvailableFile(entry.libraryTrack),
  );
  const rows: TrackListRow[] = merged.map((entry) => {
    const releaseIndex = entry.releaseTrack ? releaseTracks.indexOf(entry.releaseTrack) : -1;
    if (!entry.libraryTrack) {
      return releaseRows.buildReleaseTrackRow(entry.releaseTrack!, releaseIndex, {
        key: entry.key,
        number: entry.number,
      });
    }
    const track = entry.libraryTrack;
    const row = actions.buildLibraryTrackRow(
      track,
      albumTracks.indexOf(track),
      albumTracks,
      "release",
    );
    const hasFile = Boolean(firstAvailableFile(track));
    const previewPlayback =
      !hasFile && entry.releaseTrack
        ? releaseRows.previewPlayback(entry.releaseTrack, releaseIndex)
        : null;
    return {
      ...row,
      key: entry.key,
      number: entry.number,
      subtitle: isAlbumArtistCredit(track, libraryArtist) ? null : row.subtitle,
      // Owned rows show the ✓ where missing rows show their download button
      ...(hasFile && hasMissingTracks ? { trailing: <OwnedTrackMark /> } : {}),
      time: hasFile
        ? row.time
        : formatDuration(trackDurationMs(track)) ||
          formatDuration(entry.releaseTrack?.length) ||
          "—",
      // The small "missing" time style is for the library's "Unavailable" label; here
      // the cell always holds a real duration.
      timeMissing: false,
      ...(previewPlayback?.onPlay ? previewPlayback : {}),
    };
  });
  const trackParam =
    searchParams.get("track") ||
    (locationState?.focusTrackMbid ? String(locationState.focusTrackMbid) : "");
  const highlightKey = trackParam
    ? (merged.find(
        (entry) =>
          entry.key === trackParam ||
          String(entry.libraryTrack?.id ?? "") === trackParam ||
          entry.libraryTrack?.mbid === trackParam ||
          entry.releaseTrack?.mbid === trackParam ||
          entry.releaseTrack?.id === trackParam,
      )?.key ?? null)
    : null;

  const trackCount = Math.max(
    merged.length,
    libraryAlbum ? Number(actions.albumAvailability(libraryAlbum).total || 0) : 0,
  );
  const durationMs = merged.reduce(
    (total, entry) =>
      total +
      (Number(entry.libraryTrack && firstAvailableFile(entry.libraryTrack)?.durationMs) ||
        Number(entry.releaseTrack?.length) ||
        0),
    0,
  );
  const availableCount = libraryAlbum
    ? Math.max(
        merged.filter((entry) => entry.libraryTrack && firstAvailableFile(entry.libraryTrack))
          .length,
        Number(actions.albumAvailability(libraryAlbum).available || 0),
      )
    : libraryInfo
      ? Number(libraryInfo.trackFileCount || 0)
      : null;
  const unmonitoredIcon =
    libraryAlbum && albumState.albumMonitored === false ? (
      <Tooltip content="Not monitored">
        <span
          className="native-library-detail__manager"
          data-unmonitored
          role="img"
          aria-label="Not monitored"
        >
          <EyeOff aria-hidden="true" />
        </span>
      </Tooltip>
    ) : null;
  const meta = buildAlbumHeaderMeta({
    release,
    libraryAlbum,
    trackCount,
    availableCount,
    durationMs,
  });

  useDocumentTitle(title ? (artistName ? `${title} — ${artistName}` : title) : "Album");

  const albumPlayable = albumTracks.some((track) => firstAvailableFile(track));
  const albumIsCurrent =
    actions.matchesSource(LIBRARY_SOURCE) &&
    albumTracks.some((track) => String(track.id) === String(actions.currentTrack?.id));
  const loadAlbumDetail = async () => ({ tracks: albumTracks, lookup: null });

  const showAurralStatus = Boolean(
    libraryAlbum && albumState.albumMonitoring.monitored && !isPreviewLibrary,
  );
  const showLibraryPill =
    !showAurralStatus &&
    Boolean(libraryDisplay.label) &&
    libraryDisplay.kind !== "incomplete" &&
    !(libraryAlbum && libraryDisplay.isComplete);
  // Until we know whether the album is in the library, the release-only actions would
  // flash in and could request an album the library already has.
  const libraryResolving =
    libraryLoading || (Boolean(routeReleaseGroupMbid) && albumLookupQuery.isPending);
  const showDownload =
    !libraryResolving &&
    (libraryAlbum
      ? albumState.canDownloadLibraryAlbum
      : canAddAlbum && Boolean(releaseGroupMbid) && !libraryDisplay.isComplete);
  const searchInsteadOfDownload = Boolean(
    libraryAlbum && albumState.albumManager === "lidarr" && albumState.albumMonitored,
  );
  const downloadBusy =
    requesting || (libraryAlbum ? albumState.libraryAlbumDownloading : releaseDownloading);
  const albumAddAction = buildAlbumAddAction(
    libraryDisplay.triggerSearch,
    actions.libraryDestination,
  );

  const libraryContext = !isDiscoverSectionActive;
  const discoverArtistPath = artistMbid ? `/artist/${encodeURIComponent(artistMbid)}` : null;
  const discoverArtistLinkState = libraryArtist
    ? actions.discoverArtistState(libraryArtist)
    : {
        artistName,
        inLibrary: locationState?.inLibrary,
        libraryArtist: locationState?.libraryArtist,
      };
  const libraryArtistPath = libraryArtist ? actions.libraryArtistPath(libraryArtist) : null;
  const subtitleToLibrary = Boolean(libraryArtistPath && (libraryContext || !discoverArtistPath));
  const subtitle = subtitleToLibrary ? (
    <RouteLink to={libraryArtistPath!} className="native-library-detail__artist">
      {artistName}
    </RouteLink>
  ) : discoverArtistPath ? (
    <Link
      to={discoverArtistPath}
      state={discoverArtistLinkState}
      className="native-library-detail__artist"
    >
      {artistName || (headerPending ? <SkeletonText width="7em" /> : "Artist")}
    </Link>
  ) : (
    <p>{artistName || (headerPending ? <SkeletonText width="7em" /> : "Unknown Artist")}</p>
  );
  const shareRelease = () =>
    share(
      {
        kind: "album",
        albumMbid: releaseGroupMbid,
        artistMbid,
        title,
        artistName,
        tracks: releaseTracks.map((track) => ({
          title: track.title,
          artistName,
          albumTitle: title,
          artistMbid,
          albumMbid: releaseGroupMbid,
          trackMbid: track.mbid,
          releaseMbid: track.releaseMbid,
          durationMs: track.length,
          trackNumber: track.trackNumber,
          discNumber: track.discNumber,
        })),
      },
      title,
    );
  const albumMonitoringMenuItem = albumState.getAlbumMonitoringMenuItem(() =>
    downloadAlbum(albumState.activeManager),
  );
  const menuItems: LibraryMenuItem[] = libraryAlbum
    ? [
        ...actions.collectionQueueItems(loadAlbumDetail, !albumPlayable),
        actions.shareMenuItem({ kind: "album", entity: libraryAlbum }, { artist: libraryArtist }),
        {
          id: "info",
          label: "View info",
          icon: Info,
          onSelect: () =>
            actions.openLibraryInfo(
              { kind: "album", entity: libraryAlbum },
              { artist: libraryArtist },
            ),
        },
        ...(actions.canEditArtwork
          ? [
              {
                id: "artwork",
                label: "Change artwork",
                icon: ImagePlus,
                onSelect: () =>
                  actions.openArtworkEditor(
                    "album",
                    libraryAlbum,
                    libraryCover,
                    libraryAlbum.defaultCoverUrl || "",
                  ),
              },
            ]
          : []),
        ...(albumMonitoringMenuItem ? [albumMonitoringMenuItem] : []),
        ...(actions.canDeleteAlbum &&
        canRemoveLibraryAlbum(libraryAlbum, {
          lidarrConnected: albumState.activeManager === "lidarr",
        })
          ? [
              {
                id: "delete",
                label: "Delete album",
                icon: Trash2,
                danger: true,
                separatorBefore: true,
                onSelect: () => actions.openLibraryRemoval({ kind: "album", entity: libraryAlbum }),
              },
            ]
          : []),
      ]
    : [
        ...getQueueItems(preview.getQueueTracks(), { source: playbackSource }),
        {
          id: "share",
          label: "Share",
          icon: Share,
          disabled: !artistName || !title,
          onSelect: shareRelease,
        },
      ];

  if (!albumRef) {
    return <EmptyState title="Not found" message="This album link is not valid." />;
  }
  if (albumRef.kind === "library" && !libraryLoading && !libraryAlbum && !libraryError) {
    return (
      <CollectionPage>
        <EmptyState title="Not found" message="This item is no longer in the Library." />
      </CollectionPage>
    );
  }
  if (libraryError && !releaseGroupMbid) {
    return (
      <div className="native-library-state" role="alert">
        <strong>Library unavailable</strong>
        <span>{libraryError}</span>
        <button
          type="button"
          className="native-library-state__action"
          disabled={libraryQuery.isFetching}
          onClick={() => void libraryQuery.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }
  if (releaseDetailsQuery.isError && !title && !libraryLoading) {
    // 404: no such release group; 400: the ref isn't an MBID at all
    const status = asApiError(releaseDetailsQuery.error)?.response?.status;
    if (status === 404 || status === 400) {
      return (
        <CollectionPage>
          <EmptyState title="Not found" message="This album doesn’t exist on MusicBrainz." />
        </CollectionPage>
      );
    }
    return (
      <div className="search-empty-panel" role="alert">
        <div className="search-empty-panel__icon" aria-hidden="true">
          <AlertCircle />
        </div>
        <h1 className="search-empty-panel__title">Couldn’t load this release</h1>
        <p className="search-empty-panel__message">
          The metadata service didn’t respond. Try again in a moment.
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={releaseDetailsQuery.isFetching}
          onClick={() => void releaseDetailsQuery.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <CollectionPage tintSrc={artwork}>
      {actions.renderModals()}
      {albumState.albumMonitoring.dialog}
      {libraryAlbum && bootstrap?.lidarr?.circuitOpen === true && (
        <p className="native-library-notice" role="status">
          Lidarr is unavailable. Showing the last indexed library.
        </p>
      )}
      <CollectionHeader
        cover={
          libraryCover ? (
            <Cover src={libraryCover} label={title} thumbnail={false} />
          ) : coverUrl ? (
            <img src={coverUrl} alt="" loading="eager" decoding="async" onError={cover.onError} />
          ) : headerPending ? (
            <SkeletonShape className="skeleton-fill" />
          ) : (
            <span className="native-library-cover-fallback" aria-hidden="true">
              {title.trim().charAt(0).toUpperCase() || "—"}
            </span>
          )
        }
        title={headerPending ? <SkeletonText width="8em" /> : title || "Unknown Album"}
        titleAside={
          showLibraryPill ? (
            <Tooltip content={libraryDisplay.label}>
              <span
                className={`release-page__library-status release-page__library-status--${libraryDisplay.kind}`}
              >
                <span>{libraryDisplay.label}</span>
              </span>
            </Tooltip>
          ) : null
        }
        subtitle={subtitle}
        meta={
          headerPending ? (
            <SkeletonText width="11em" />
          ) : (
            <>
              {/* Items never break inside, and each "·" sticks to the item before it,
                  so lines only wrap after a separator. The unmonitored icon rides
                  with the last item instead of wrapping alone. */}
              {meta.map((segment, index) => (
                <Fragment key={segment.text}>
                  {index ? " · " : null}
                  <span className="native-library-detail__meta-item">
                    {segment.partial ? (
                      <span className="native-library-card__status" data-tone="warning">
                        {segment.text}
                        <span className="sr-only"> available</span>
                      </span>
                    ) : (
                      segment.text
                    )}
                    {unmonitoredIcon && index === meta.length - 1 ? (
                      <>
                        {" · "}
                        {unmonitoredIcon}
                      </>
                    ) : null}
                  </span>
                </Fragment>
              ))}
              {meta.length ? null : unmonitoredIcon}
            </>
          )
        }
        status={
          showAurralStatus && libraryAlbum ? (
            <AurralAlbumStatus
              key={libraryAlbum.id}
              album={libraryAlbum}
              artist={libraryArtist}
              canManage={actions.canAddTracks}
              canRetry={albumState.activeManager === "aurral"}
              onChanged={actions.refreshLibraryActivity}
              onSettled={albumState.reloadLibraryAlbumTracks}
            />
          ) : null
        }
        actions={
          <>
            {albumPlayable ? (
              <CollectionPlayButtons
                label={title || "album"}
                isPlaying={albumIsCurrent && actions.isRunning}
                isShuffleEnabled={albumIsCurrent && isShuffleEnabled}
                onPlay={() =>
                  albumIsCurrent ? actions.togglePlayPause() : actions.playTracks(albumTracks)
                }
                onShuffle={() => actions.playTracks(albumTracks, null, true)}
              />
            ) : (
              <CollectionPlayButtons
                label={title || "Release"}
                playLabel={libraryResolving ? undefined : "Preview"}
                disabled={libraryResolving || preview.disabled}
                isPlaying={preview.isListPlaying}
                isShuffleEnabled={preview.isShuffleEnabled}
                onPlay={preview.handlePlayAll}
                onShuffle={preview.handleShufflePlay}
              />
            )}
            {libraryAlbum ? (
              <FavoriteButton
                active={favoriteIds.has(favoriteId("album", libraryAlbum))}
                pending={Boolean(actions.pendingFavorite)}
                label={title || "album"}
                onClick={() => actions.toggleFavorite("album", libraryAlbum)}
              />
            ) : null}
            {showDownload ? (
              <AddActionButton
                {...albumAddAction}
                label={searchInsteadOfDownload ? "Search for album" : albumAddAction.label}
                icon={searchInsteadOfDownload ? Search : albumAddAction.icon}
                ownerConflict={ownerConflict}
                onAdd={(managedBy) => void downloadAlbum(managedBy)}
                isLoading={downloadBusy}
                loadingLabel="Downloading"
                disabled={downloadBusy}
              />
            ) : null}
            <LibraryItemMenu
              label={title || "Album"}
              {...(libraryAlbum ? actions.albumMenuProps(libraryAlbum, loadAlbumDetail) : {})}
              items={menuItems}
            />
          </>
        }
      />
      {rows.length ? (
        <TrackList
          label={`${title || "Album"} tracks`}
          rows={rows}
          variant="release"
          highlightKey={highlightKey}
        />
      ) : libraryLoading || tracksLoading ? (
        <SkeletonStatus label="Loading tracks">
          <SkeletonTrackList count={12} variant="release" />
        </SkeletonStatus>
      ) : (
        <div className="native-library-state">
          <span>No tracks available</span>
        </div>
      )}
    </CollectionPage>
  );
}

export default AlbumPage;
