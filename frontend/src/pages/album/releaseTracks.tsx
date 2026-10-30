import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Download, Plus } from "../../components/icons";
import { DotLoader, DownloadingIcon } from "../../components/DotLoader";
import SearchLibraryCheck from "../../components/SearchLibraryCheck";
import TooltipButton from "../../components/TooltipButton";
import type { TrackListRow } from "../../components/TrackList";
import { useAudioQueue } from "../../contexts/audioQueueContext";
import { useToast } from "../../contexts/ToastContext";
import { useActiveDownloads } from "../../hooks/useActiveDownloads";
import {
  useAlbumTrackListToolbar,
  type PlaybackSource,
} from "../../hooks/useAlbumTrackListToolbar";
import { useQueueTrackActions } from "../../hooks/useQueueTrackActions";
import type { ReleaseGroupTrack } from "../../utils/api/endpoints/artists.ts";
import { downloadTrackToLibrary } from "../../utils/api/endpoints/library.ts";
import { normalizePreviewTrack } from "../../utils/audioQueue";
import {
  buildStaticPlaylistTrackPayload,
  getApiErrorMessage,
  reserveUniquePlaylistName,
  type ReleaseGroup,
} from "../ArtistDetails/utils";
import { formatDuration, trackDownloadActionLabel } from "../library/libraryShared.tsx";
import type { useLibraryActions } from "../library/useLibraryActions.tsx";
import {
  TrackPlaylistSubmenu,
  type PlaylistSelection,
} from "../ArtistDetails/components/TrackPlaylistMenu";

type PlaylistActions = Pick<
  ReturnType<typeof useLibraryActions>,
  | "staticPlaylists"
  | "playlistsLoading"
  | "playlistsError"
  | "loadStaticPlaylists"
  | "playlistSavingKey"
  | "savePlaylistTracks"
>;

// Sits in the track row's download slot, so owned and missing rows share one column
export function OwnedTrackMark() {
  return (
    <span className="native-library-track__owned">
      <SearchLibraryCheck size="discover" />
    </span>
  );
}

export const releaseTrackId = (
  track: Partial<ReleaseGroupTrack> | null | undefined,
  trackKey: string | undefined,
  index: number,
) => String(track?.id ?? track?.mbid ?? `${trackKey}-${index}`);

export function useReleasePreviewQueue({
  release,
  trackKey,
  tracks,
  artistName,
  artistMbid,
  artwork,
  playbackSource,
}: {
  release: ReleaseGroup | null | undefined;
  trackKey: string | undefined;
  tracks: ReleaseGroupTrack[];
  artistName: string;
  artistMbid: string | null | undefined;
  artwork: string | null | undefined;
  playbackSource: PlaybackSource | null;
}) {
  const normalizeTrack = useCallback(
    (track: ReleaseGroupTrack, index: number) =>
      normalizePreviewTrack(
        {
          id: releaseTrackId(track, trackKey, index),
          title: track?.title || track?.trackName,
          preview_url: track?.preview_url,
        },
        artistName,
        {
          album: release?.title || "",
          artwork: artwork || null,
          artistMbid: artistMbid || undefined,
          albumMbid: release?.id || trackKey,
        },
      ),
    [artistMbid, artistName, artwork, release?.id, release?.title, trackKey],
  );
  const getQueueTracks = useCallback(
    () =>
      (tracks || [])
        .map((track, index) => (track?.preview_url ? normalizeTrack(track, index) : null))
        .filter((track) => track !== null),
    [normalizeTrack, tracks],
  );
  const toolbar = useAlbumTrackListToolbar({ getQueueTracks, playbackSource });
  return { ...toolbar, normalizeTrack, getQueueTracks };
}

export function useReleaseTracks({
  release,
  trackKey,
  artistName,
  artistMbid,
  albumMbid,
  preview,
  playbackSource,
  albumDownloading,
  ownedTrackMbids,
  playlists,
}: {
  release: ReleaseGroup;
  trackKey: string | undefined;
  artistName: string;
  artistMbid: string | null;
  albumMbid: string | null;
  preview: ReturnType<typeof useReleasePreviewQueue>;
  playbackSource: PlaybackSource;
  albumDownloading: boolean;
  ownedTrackMbids: readonly string[] | undefined;
  playlists: PlaylistActions;
}) {
  const { showError, showSuccess } = useToast();
  const { currentTrack, isPlaying, isLoading, isStarting, playTrack, togglePlayPause } =
    useAudioQueue();
  const { isTrackDownloading } = useActiveDownloads();
  const getQueueItems = useQueueTrackActions();
  const {
    staticPlaylists,
    playlistsLoading,
    playlistsError,
    loadStaticPlaylists,
    playlistSavingKey,
    savePlaylistTracks,
  } = playlists;
  const [libraryTrackSavingKey, setLibraryTrackSavingKey] = useState("");
  const { mutateAsync: downloadTrack } = useMutation({ mutationFn: downloadTrackToLibrary });

  const buildReleaseTrackPayload = useCallback(
    (track: ReleaseGroupTrack) => {
      const year = String(release["first-release-date"] || "").slice(0, 4);
      return buildStaticPlaylistTrackPayload({
        artistName: artistName || "",
        trackName: track?.trackName || track?.title || "",
        albumName: release.title || "",
        artistMbid: artistMbid || "",
        albumMbid: albumMbid || "",
        releaseMbid: track?.releaseMbid,
        trackMbid: track?.mbid || track?.id || "",
        releaseYear: year,
        durationMs: track?.length,
        trackNumber: track?.trackNumber,
        discNumber: track?.discNumber,
        reason: null,
      });
    },
    [albumMbid, artistMbid, artistName, release],
  );

  const addTrackToLibrary = useCallback(
    async (track: ReleaseGroupTrack, savingKey: string) => {
      const payload = buildReleaseTrackPayload(track);
      setLibraryTrackSavingKey(savingKey);
      try {
        const result = await downloadTrack(payload);
        showSuccess(
          result?.alreadyOwned
            ? `${payload.trackName} is already in your library`
            : result?.queued
              ? `Queued ${payload.trackName} for your library`
              : `Added ${payload.trackName} to your library`,
        );
      } catch (err) {
        showError(getApiErrorMessage(err) || "Failed to add track to library");
      } finally {
        setLibraryTrackSavingKey("");
      }
    },
    [buildReleaseTrackPayload, downloadTrack, showError, showSuccess],
  );

  const previewTrack = useCallback(
    (track: ReleaseGroupTrack, index: number) => {
      const normalized = preview.normalizeTrack(track, index);
      if (!normalized?.src) return;
      if (currentTrack?.id === normalized.id) {
        togglePlayPause();
        return;
      }
      playTrack(normalized, { source: playbackSource, queue: preview.getQueueTracks() });
    },
    [currentTrack?.id, playTrack, playbackSource, preview, togglePlayPause],
  );

  const defaultPlaylistName = reserveUniquePlaylistName(
    staticPlaylists,
    `${artistName || "Artist"} Picks`,
  );
  const ownedTrackSet = new Set((ownedTrackMbids || []).map(String));
  const isOwnedReleaseTrack = (track: ReleaseGroupTrack) =>
    [track.mbid, track.id].filter(Boolean).some((identity) => ownedTrackSet.has(String(identity)));

  const previewPlayback = (track: ReleaseGroupTrack, index: number) => {
    const id = releaseTrackId(track, trackKey, index);
    const isCurrent = currentTrack?.id === id;
    return {
      active: isCurrent,
      playing: isCurrent && (isPlaying || isStarting),
      loading: isCurrent && isLoading,
      onPlay: track.preview_url ? () => previewTrack(track, index) : null,
    };
  };

  const buildReleaseTrackRow = (
    track: ReleaseGroupTrack,
    index: number,
    { key, number }: { key: string; number: number },
  ): TrackListRow => {
    const id = releaseTrackId(track, trackKey, index);
    const title = track.title || track.trackName || "Unknown Track";
    const isOwned = isOwnedReleaseTrack(track);
    const canPlay = Boolean(track.preview_url);
    const membershipTrack = buildReleaseTrackPayload(track);
    const downloading =
      !isOwned &&
      (albumDownloading || isTrackDownloading(track) || isTrackDownloading(membershipTrack));
    const downloadLabel = trackDownloadActionLabel(downloading ? "downloading" : null);
    const queueItems = canPlay
      ? getQueueItems(preview.normalizeTrack(track, index), { source: playbackSource })
      : [];
    const items = [
      ...queueItems,
      ...(!isOwned
        ? [
            {
              id: "add-library",
              label: downloadLabel,
              icon: downloading ? DownloadingIcon : Download,
              separatorBefore: queueItems.length > 0,
              disabled: downloading || libraryTrackSavingKey === id,
              onSelect: () => addTrackToLibrary(track, id),
            },
          ]
        : []),
    ];
    return {
      key,
      number,
      title,
      time: formatDuration(track.length) || "—",
      missing: !isOwned,
      ...previewPlayback(track, index),
      trailing: isOwned ? (
        <OwnedTrackMark />
      ) : (
        <TooltipButton
          className="native-library-track__download"
          onClick={() => void addTrackToLibrary(track, id)}
          disabled={downloading || libraryTrackSavingKey === id}
          label={downloadLabel}
          aria-label={downloadLabel}
        >
          {downloading ? <DotLoader size="sm" label={null} /> : <Download aria-hidden="true" />}
        </TooltipButton>
      ),
      menu: {
        items,
        ...(items.length ? { additionalItemsAfter: items[items.length - 1].id } : {}),
        onMenuOpen: loadStaticPlaylists,
        renderAdditionalItems: ({ closeMenu }) => (
          <>
            {items.length ? <div className="native-library-item-menu__separator" /> : null}
            <TrackPlaylistSubmenu
              label="Add to playlist"
              icon={Plus}
              track={membershipTrack}
              playlists={staticPlaylists}
              loading={playlistsLoading}
              saving={playlistSavingKey === id}
              error={playlistsError}
              defaultNewPlaylistName={defaultPlaylistName}
              onSelect={(target: PlaylistSelection) => {
                if (!membershipTrack.artistName || !membershipTrack.trackName) {
                  showError("Track details are incomplete");
                  return;
                }
                void savePlaylistTracks([membershipTrack], target, {
                  key: id,
                  label: "Track",
                  defaultName: defaultPlaylistName,
                });
              }}
              onClose={closeMenu}
              toggleOnClick
            />
          </>
        ),
      },
    };
  };

  return { buildReleaseTrackRow, previewPlayback, buildReleaseTrackPayload };
}
