import { useEffect, useRef } from "react";
import { albumPath } from "../../../../../lib/albumPath.ts";

interface ArtistSearchFocusState {
  focusReleaseGroupMbid?: string | null;
  focusTrackMbid?: string | null;
  focusTrackTitle?: string | null;
  artistName?: string | null;
  inLibrary?: boolean;
  libraryArtist?: unknown;
  focusReleaseGroup?: unknown;
}

interface ArtistSearchFocusOptions {
  navigate: (to: string, options: { replace: boolean; state: unknown }) => void;
  mbid: string | undefined;
  locationState: ArtistSearchFocusState | null | undefined;
}

export function useArtistSearchFocus({ navigate, mbid, locationState }: ArtistSearchFocusOptions) {
  const focusReleaseGroupMbid = locationState?.focusReleaseGroupMbid || null;
  const focusTrackMbid = locationState?.focusTrackMbid || null;
  const appliedRef = useRef(false);

  useEffect(() => {
    appliedRef.current = false;
  }, [mbid, focusReleaseGroupMbid, focusTrackMbid]);

  useEffect(() => {
    if (appliedRef.current || !focusReleaseGroupMbid || !mbid) return;

    appliedRef.current = true;
    navigate(albumPath(focusReleaseGroupMbid, { track: focusTrackMbid }), {
      replace: true,
      state: {
        artistMbid: mbid,
        artistName: locationState?.artistName,
        inLibrary: locationState?.inLibrary,
        libraryArtist: locationState?.libraryArtist,
        focusReleaseGroup: locationState?.focusReleaseGroup,
        focusTrackMbid,
        focusTrackTitle: locationState?.focusTrackTitle,
      },
    });
  }, [focusReleaseGroupMbid, focusTrackMbid, locationState, mbid, navigate]);
}
