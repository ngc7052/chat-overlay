export type PlatformName = 'goodgame' | 'twitch';
export type BadgeStyle = 'icons' | 'text' | 'off';
export type PlatformStyle = 'icon' | 'text' | 'off';

export interface SourceConfig {
  platform: PlatformName;
  channel: string;
  enabled: boolean;
}

export interface Bounds {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
}

export interface Config {
  sources: SourceConfig[];
  bounds: Bounds;
  locked: boolean;
  hidden: boolean;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  opacity: number;
  bgOpacity: number;
  hoverBgOpacity: number;
  outline: boolean;
  showTimestamps: boolean;
  platformStyle: PlatformStyle;
  badgeStyle: BadgeStyle;
  boldNames: boolean;
  exactColors: boolean;
  showSystem: boolean;
  customCss: string;
  emotes: boolean;
  thirdPartyEmotes: boolean;
  emoteScale: number;
  messageLifetime: number;
  fadeDuration: number;
  maxMessages: number;
  hideCommands: boolean;
  ignoreList: string[];
  hotkeyLock: string;
  hotkeyHide: string;
  autoCheckUpdates: boolean;
}

/** What boot.ts hands the payload through `global.__overlayPayload`. */
export interface PayloadHandoff {
  dir: string;
  version: string;
  bundledDir: string;
  bundledVersion: string;
  stagedDir: string;
  incomingDir: string;
  usingStaged: boolean;
  markHealthy(): void;
  quarantinedVersion(): string | null;
}

export interface ReleaseInfo {
  version: string;
  current: string;
  newer: boolean;
  quarantined: boolean;
  url: string | null;
  page: string | null;
  notes: string;
}
