import type { FormEvent } from "react";
import { SettingsPlaybackSection } from "./SettingsPlaybackSection";
import type { InferResponseType } from "hono/client";
import type { playbackSettingsClient } from "../../../utils/api/clients/playbackSettings.ts";
import type { useToast } from "../../../contexts/ToastContext";
import type { SettingsState } from "../utils";

type Toast = ReturnType<typeof useToast>["showSuccess"];

export function SettingsPlaybackTab({
  settings,
  playbackSettings,
  updateSettings,
  hasUnsavedChanges,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}: {
  settings: SettingsState;
  playbackSettings:
    | InferResponseType<typeof playbackSettingsClient.playback.$get, 200>["destinations"]
    | null;
  updateSettings: (settings: SettingsState) => void;
  hasUnsavedChanges: boolean;
  saving: boolean;
  handleSaveSettings: (
    event?: FormEvent<HTMLFormElement> | null,
    settingsOverride?: SettingsState,
  ) => Promise<boolean>;
  showSuccess: Toast;
  showError: Toast;
  showInfo: ReturnType<typeof useToast>["showInfo"];
}) {
  return (
    <div className="arr-page">
      <form onSubmit={handleSaveSettings} className="arr-form" autoComplete="off">
        <SettingsPlaybackSection
          settings={settings}
          playbackSettings={playbackSettings}
          updateSettings={updateSettings}
          hasUnsavedChanges={hasUnsavedChanges}
          handleSaveSettings={handleSaveSettings}
          showSuccess={showSuccess}
          showError={showError}
          showInfo={showInfo}
        />
      </form>
    </div>
  );
}
