import { compareVersions, versionFromTag } from '../../shared/version.js';
import type { ReleaseInfo } from '../types.js';

export const ASSET_NAME = 'app-payload.json.gz';

interface RawAsset { name?: unknown; browser_download_url?: unknown }
interface RawRelease {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  assets?: unknown;
}

/**
 * Turn a GitHub release into the decision the app acts on.
 *
 * `quarantined` marks a version this install already tried and threw out, so
 * callers can avoid nagging someone with a release known to be broken here.
 * A release with no payload asset yields `url: null`, which means "the runtime
 * changed, send them to the page for a full download" rather than an error.
 */
export function parseRelease(
  raw: unknown,
  currentVersion: string,
  quarantinedVersion: string | null,
): ReleaseInfo {
  const rel = (raw ?? {}) as RawRelease;
  const version = versionFromTag(rel.tag_name);
  if (!version) throw new Error('unexpected tag: ' + String(rel.tag_name));

  const assets = Array.isArray(rel.assets) ? (rel.assets as RawAsset[]) : [];
  const asset = assets.find((a) => a && a.name === ASSET_NAME);
  const url = asset && typeof asset.browser_download_url === 'string'
    ? asset.browser_download_url
    : null;

  return {
    version,
    current: currentVersion,
    newer: compareVersions(version, currentVersion) > 0,
    quarantined: quarantinedVersion !== null && version === quarantinedVersion,
    url,
    page: typeof rel.html_url === 'string' ? rel.html_url : null,
    notes: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : '',
  };
}
