/**
 * Semi-automatic update check.
 *
 * Reads the GitHub Releases of the project, picks the highest semver tag (honoring
 * the prerelease channel), and compares it with the running app version. It never
 * downloads or installs — the renderer just opens the release page on demand. No
 * auth/token is used (public repo, ~60 req/hr per IP), so nothing sensitive ships.
 */
import { app } from 'electron';
import semver from 'semver';
import type { UpdateCheckOptions, UpdateCheckResult } from '@shared/types';

const REPO_OWNER = 'seethith';
const REPO_NAME = 'Ulyzer';
const REQUEST_TIMEOUT_MS = 8_000;

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
}

interface Candidate {
  version: string;
  release: GitHubRelease;
}

function pickLatest(releases: GitHubRelease[], includePrerelease: boolean): Candidate | null {
  let best: Candidate | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (release.prerelease && !includePrerelease) continue;
    const version = semver.valid(semver.clean(release.tag_name ?? '') ?? '');
    if (!version) continue;
    if (!best || semver.gt(version, best.version)) best = { version, release };
  }
  return best;
}

export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const base: UpdateCheckResult = {
    hasUpdate: false,
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
    error: null,
  };

  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=20`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Ulyzer-Updater/${currentVersion}`,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    return { ...base, error: 'offline' };
  }

  if (response.status === 403 || response.status === 429) return { ...base, error: 'rate_limited' };
  if (!response.ok) return { ...base, error: 'unknown' };

  let releases: GitHubRelease[];
  try {
    const parsed = (await response.json()) as unknown;
    releases = Array.isArray(parsed) ? (parsed as GitHubRelease[]) : [];
  } catch {
    return { ...base, error: 'unknown' };
  }

  const latest = pickLatest(releases, options.includePrerelease ?? false);
  if (!latest) return base; // no usable release yet → simply "up to date"

  const hasUpdate = semver.valid(currentVersion) ? semver.gt(latest.version, currentVersion) : false;
  return {
    hasUpdate,
    currentVersion,
    latestVersion: latest.version,
    releaseUrl: latest.release.html_url,
    releaseNotes: latest.release.body?.trim() || undefined,
    publishedAt: latest.release.published_at,
    prerelease: latest.release.prerelease,
    error: null,
  };
}
