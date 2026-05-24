import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { app } from 'electron';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { SourceProcessingState, YtDlpInstallResult, YtDlpStatus } from '@shared/types';
import { getDb } from '../db/sqlite';
import type { MediaProcessingResult } from './media-ingestion';

const YTDLP_METADATA_TIMEOUT_MS = 60_000;
const YTDLP_SUBTITLE_TIMEOUT_MS = 120_000;
const YTDLP_DOWNLOAD_TIMEOUT_MS = 240_000;
const YTDLP_MAX_BUFFER = 32 * 1024 * 1024;
const PREFERRED_SUB_LANGS = ['zh-Hans', 'zh-CN', 'zh-TW', 'zh', 'en', 'en-orig'];
const YTDLP_YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,web,web_safari,mweb,web_embedded';

interface YtDlpCommand {
  command: string;
  argsPrefix: string[];
  label: string;
}

interface YtDlpMetadata {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  creator?: string;
  duration?: number;
  description?: string;
  webpage_url?: string;
  original_url?: string;
  extractor?: string;
  extractor_key?: string;
  playlist?: string;
  playlist_index?: number;
  episode?: string;
  upload_date?: string;
  categories?: string[];
  tags?: string[];
  chapters?: Array<{ title?: string; start_time?: number; end_time?: number }>;
  subtitles?: Record<string, unknown[]>;
  automatic_captions?: Record<string, unknown[]>;
}

interface SubtitleCandidate {
  filePath: string;
  language: string;
  text: string;
  score: number;
}

type YtDlpResult = MediaProcessingResult & {
  resolvedTitle: string;
  processingState?: SourceProcessingState;
  site: VideoSiteInfo;
  extractor?: string;
  authTried: boolean;
};

let cachedCommand: YtDlpCommand | null = null;

export interface VideoSiteInfo {
  key: string;
  label: string;
  host: string;
  requiresYoutubeWorkarounds?: boolean;
}

const VIDEO_SITE_PATTERNS: Array<{ key: string; label: string; hosts: string[]; youtube?: boolean }> = [
  { key: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], youtube: true },
  { key: 'bilibili', label: 'Bilibili', hosts: ['bilibili.com', 'b23.tv', 'biliintl.com'] },
  { key: 'vimeo', label: 'Vimeo', hosts: ['vimeo.com'] },
  { key: 'tiktok', label: 'TikTok', hosts: ['tiktok.com'] },
  { key: 'douyin', label: '抖音', hosts: ['douyin.com', 'iesdouyin.com'] },
  { key: 'xigua', label: '西瓜视频', hosts: ['ixigua.com', 'xigua.com'] },
  { key: 'acfun', label: 'AcFun', hosts: ['acfun.cn'] },
  { key: 'niconico', label: 'Niconico', hosts: ['nicovideo.jp', 'niconico.jp'] },
  { key: 'dailymotion', label: 'Dailymotion', hosts: ['dailymotion.com'] },
  { key: 'ted', label: 'TED', hosts: ['ted.com'] },
  { key: 'khanacademy', label: 'Khan Academy', hosts: ['khanacademy.org'] },
  { key: 'coursera', label: 'Coursera', hosts: ['coursera.org'] },
  { key: 'edx', label: 'edX', hosts: ['edx.org'] },
];

function normalizedHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function videoSiteFromUrl(url: string): VideoSiteInfo | null {
  const host = normalizedHost(url);
  if (!host) return null;
  const match = VIDEO_SITE_PATTERNS.find((site) => site.hosts.some((domain) => hostMatches(host, domain)));
  if (!match) return null;
  return {
    key: match.key,
    label: match.label,
    host,
    requiresYoutubeWorkarounds: match.youtube,
  };
}

export function isYtDlpCandidateUrl(url: string): boolean {
  return videoSiteFromUrl(url) !== null;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function execFileAsync(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const env = {
    ...process.env,
    PATH: process.env.PATH ? `${process.env.PATH}:${extraPath}` : extraPath,
  };
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      cwd: options?.cwd,
      env,
      timeout: options?.timeoutMs,
      maxBuffer: YTDLP_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = [
          error.message,
          stderr?.toString().trim(),
          stdout?.toString().trim(),
        ].filter(Boolean).join('\n');
        const next = new Error(message || 'yt-dlp 执行失败。');
        (next as Error & { code?: unknown }).code = (error as Error & { code?: unknown }).code;
        reject(next);
        return;
      }
      resolvePromise({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

async function canRun(command: YtDlpCommand): Promise<boolean> {
  try {
    await execFileAsync(command.command, [...command.argsPrefix, '--version'], { timeoutMs: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function existsExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryFileName(): string {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function managedYtDlpPath(): string {
  return join(app.getPath('userData'), 'bin', binaryFileName());
}

function releaseAssetNames(): string[] {
  if (process.platform === 'darwin') return ['yt-dlp_macos', 'yt-dlp'];
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return ['yt-dlp_arm64.exe'];
    if (process.arch === 'ia32') return ['yt-dlp_x86.exe'];
    return ['yt-dlp.exe'];
  }
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return ['yt-dlp_linux_aarch64', 'yt-dlp'];
    return ['yt-dlp_linux', 'yt-dlp'];
  }
  return ['yt-dlp'];
}

// GitHub release direct link first, then community mirrors that proxy GitHub —
// these keep yt-dlp installable from networks where github.com is unreachable.
const GH_DOWNLOAD_MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/'];

function releaseAssetUrls(assetName: string): string[] {
  const direct = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
  return GH_DOWNLOAD_MIRRORS.map((mirror) => (mirror ? `${mirror}${direct}` : direct));
}

async function resolveYtDlpCommand(): Promise<YtDlpCommand | null> {
  if (cachedCommand) return cachedCommand;

  const fileName = binaryFileName();
  const envPath = process.env.ULYZER_YT_DLP_PATH?.trim();
  const candidatePaths = [
    envPath,
    managedYtDlpPath(),
    join(process.cwd(), 'resources', 'bin', fileName),
    process.resourcesPath ? join(process.resourcesPath, 'bin', fileName) : null,
    process.resourcesPath ? join(process.resourcesPath, fileName) : null,
    join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', fileName),
    join(process.cwd(), 'node_modules', 'yt-dlp-exec', 'bin', fileName),
  ].filter(Boolean) as string[];

  for (const candidate of candidatePaths) {
    const fullPath = resolve(candidate);
    if (await existsExecutable(fullPath)) {
      const command = { command: fullPath, argsPrefix: [], label: fullPath };
      if (await canRun(command)) {
        cachedCommand = command;
        return command;
      }
    }
  }

  const pathCommand = { command: 'yt-dlp', argsPrefix: [], label: 'yt-dlp' };
  if (await canRun(pathCommand)) {
    cachedCommand = pathCommand;
    return pathCommand;
  }

  const pythonCommand = { command: 'python3', argsPrefix: ['-m', 'yt_dlp'], label: 'python3 -m yt_dlp' };
  if (await canRun(pythonCommand)) {
    cachedCommand = pythonCommand;
    return pythonCommand;
  }

  return null;
}

async function ytDlpVersion(command: YtDlpCommand): Promise<string> {
  const { stdout } = await execFileAsync(command.command, [...command.argsPrefix, '--version'], { timeoutMs: 8_000 });
  return stdout.trim();
}

export async function getYtDlpStatus(): Promise<YtDlpStatus> {
  const installPath = managedYtDlpPath();
  try {
    const command = await resolveYtDlpCommand();
    if (!command) {
      return {
        available: false,
        installPath,
        error: '未找到 yt-dlp。可在高级设置中点击安装，或设置 ULYZER_YT_DLP_PATH。',
      };
    }
    return {
      available: true,
      version: await ytDlpVersion(command),
      path: command.label,
      installPath,
    };
  } catch (error) {
    return {
      available: false,
      installPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function currentDownloadProxy(): string | null {
  return getConfiguredProxy()
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || null;
}

async function downloadWithFetch(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(YTDLP_DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'Ulyzer yt-dlp installer' },
  });
  if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);
}

async function downloadWithCurl(url: string, outputPath: string): Promise<void> {
  const args = [
    '-L',
    '--fail',
    '--connect-timeout', '15',
    '--max-time', String(Math.ceil(YTDLP_DOWNLOAD_TIMEOUT_MS / 1000)),
    '-A', 'Ulyzer yt-dlp installer',
  ];
  const proxy = currentDownloadProxy();
  if (proxy?.trim()) args.push('--proxy', proxy.trim());
  args.push('-o', outputPath, url);
  await execFileAsync('curl', args, { timeoutMs: YTDLP_DOWNLOAD_TIMEOUT_MS + 10_000 });
}

async function downloadYtDlpBinary(url: string, outputPath: string): Promise<void> {
  const proxy = currentDownloadProxy();
  if (proxy?.trim() && process.platform !== 'win32') {
    try {
      await downloadWithCurl(url, outputPath);
      return;
    } catch {
      // Fall back to fetch below; Electron/Node may have direct access even if curl proxy failed.
    }
  }
  try {
    await downloadWithFetch(url, outputPath);
  } catch (fetchError) {
    if (process.platform === 'win32') throw fetchError;
    await downloadWithCurl(url, outputPath);
  }
}

export async function installYtDlp(): Promise<YtDlpInstallResult> {
  const installPath = managedYtDlpPath();
  const tempPath = `${installPath}.download`;
  await mkdir(join(app.getPath('userData'), 'bin'), { recursive: true });

  const downloadErrors: string[] = [];
  for (const assetName of releaseAssetNames()) {
    let downloaded = false;
    for (const url of releaseAssetUrls(assetName)) {
      try {
        await rm(tempPath, { force: true }).catch(() => {});
        await downloadYtDlpBinary(url, tempPath);
        downloaded = true;
        break;
      } catch (error) {
        downloadErrors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!downloaded) continue;
    try {
      if (process.platform !== 'win32') await chmod(tempPath, 0o755);
      const digest = createHash('sha256').update(await readFile(tempPath)).digest('hex');
      await rename(tempPath, installPath);
      cachedCommand = null;
      const status = await getYtDlpStatus();
      if (!status.available) throw new Error(status.error ?? 'yt-dlp 已下载，但无法执行。');
      return {
        ...status,
        downloaded: true,
        error: status.error ? `${status.error}；sha256=${digest}` : undefined,
      };
    } catch (error) {
      downloadErrors.push(`${assetName} install: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await execFileAsync('python3', ['-m', 'pip', 'install', '--user', '-U', 'yt-dlp'], {
      timeoutMs: YTDLP_DOWNLOAD_TIMEOUT_MS,
    });
    cachedCommand = null;
    const status = await getYtDlpStatus();
    if (!status.available) throw new Error(status.error ?? 'pip 已安装 yt-dlp，但无法执行。');
    return {
      ...status,
      downloaded: false,
    };
  } catch (pipError) {
    const pipMessage = pipError instanceof Error ? pipError.message : String(pipError);
    throw new Error([
      '自动安装 yt-dlp 失败。',
      `GitHub 下载失败：${downloadErrors.join(' | ')}`,
      `Python pip 兜底失败：${pipMessage}`,
    ].join('\n'));
  }
}

function getConfiguredProxy(): string | null {
  try {
    const row = getDb()
      .prepare<[], { youtube_proxy_url?: string | null }>('SELECT youtube_proxy_url FROM settings WHERE id = 1')
      .get();
    return row?.youtube_proxy_url?.trim() || null;
  } catch {
    return null;
  }
}

function getConfiguredCookies(): { mode: string; path: string | null; profile: string | null } {
  try {
    const row = getDb()
      .prepare<[], { youtube_cookies_mode?: string | null; youtube_cookies_path?: string | null; youtube_cookies_profile?: string | null }>(
        'SELECT youtube_cookies_mode, youtube_cookies_path, youtube_cookies_profile FROM settings WHERE id = 1',
      )
      .get();
    return {
      mode: row?.youtube_cookies_mode?.trim() || 'none',
      path: row?.youtube_cookies_path?.trim() || null,
      profile: row?.youtube_cookies_profile?.trim() || null,
    };
  } catch {
    return { mode: 'none', path: null, profile: null };
  }
}

function hasConfiguredCookies(): boolean {
  const { mode, path } = getConfiguredCookies();
  if (mode === 'cookies_file') return Boolean(path);
  return ['safari', 'chrome', 'firefox', 'edge', 'brave'].includes(mode);
}

function cookiesArgs(useCookies: boolean): string[] {
  if (!useCookies) return [];
  const { mode, path, profile } = getConfiguredCookies();
  if (mode === 'cookies_file') return path ? ['--cookies', path] : [];
  if (['safari', 'chrome', 'firefox', 'edge', 'brave'].includes(mode)) {
    return ['--cookies-from-browser', profile ? `${mode}:${profile}` : mode];
  }
  return [];
}

function cookiesLabel(): string | null {
  const { mode, path, profile } = getConfiguredCookies();
  if (mode === 'cookies_file') return path ? `cookies.txt：${path}` : null;
  if (['safari', 'chrome', 'firefox', 'edge', 'brave'].includes(mode)) return `浏览器 cookies：${mode}${profile ? `:${profile}` : ''}`;
  return null;
}

function youtubeRobustArgs(): string[] {
  return [
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    '--extractor-args', YTDLP_YOUTUBE_EXTRACTOR_ARGS,
  ];
}

function siteSpecificArgs(site: VideoSiteInfo): string[] {
  return site.requiresYoutubeWorkarounds ? youtubeRobustArgs() : [];
}

function proxyArgs(): string[] {
  const proxy = getConfiguredProxy()
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy;
  return proxy?.trim() ? ['--proxy', proxy.trim()] : [];
}

async function runYtDlp(args: string[], timeoutMs: number, cwd?: string): Promise<{ stdout: string; stderr: string; command: YtDlpCommand }> {
  const command = await resolveYtDlpCommand();
  if (!command) {
    throw new Error('未找到 yt-dlp。请先安装 yt-dlp，或设置环境变量 ULYZER_YT_DLP_PATH 指向 yt-dlp 可执行文件。');
  }
  const output = await execFileAsync(command.command, [...command.argsPrefix, ...args], { timeoutMs, cwd });
  return { ...output, command };
}

function rawErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim();
}

function isAuthLikeError(error: unknown): boolean {
  const message = rawErrorMessage(error);
  return /not a bot|captcha|unusual traffic|automated queries|bot check|sign in|cookies|login|account|private video|members-only|age-restricted|confirm your age|permission|forbidden|unauthorized/i.test(message);
}

function classifyYtDlpError(error: unknown, site: VideoSiteInfo, authTried = false): string {
  const message = rawErrorMessage(error);
  if (/未找到 yt-dlp|ENOENT|not found|spawn .* ENOENT/i.test(message)) {
    return 'yt-dlp 未可用：未找到 yt-dlp。请安装 yt-dlp，或设置 ULYZER_YT_DLP_PATH 指向可执行文件。';
  }
  if (/could not copy|could not read|permission|database is locked|keyring|decrypt|browser profile|profile/i.test(message)) {
    return `${site.label} cookies 读取失败。请确认已关闭对应浏览器的占用、已允许访问浏览器数据，或改用导出的 cookies.txt 文件。`;
  }
  if (/not a bot|captcha|unusual traffic|automated queries|bot check/i.test(message)) {
    const label = cookiesLabel();
    if (authTried && label) {
      return `${site.label} 仍触发人机验证；已尝试使用${label}${site.requiresYoutubeWorkarounds ? '并启用 yt-dlp JS challenge 组件' : ''}。请确认同一浏览器内能播放该视频，必要时改用最新 cookies.txt 或换 Firefox 登录后重试。`;
    }
    return `${site.label} 触发人机验证。请在高级设置中启用登录凭据，或提供最新 cookies.txt。`;
  }
  if (/sign in|cookies|login|account|private video|members-only|age-restricted|confirm your age/i.test(message)) {
    const label = cookiesLabel();
    if (authTried && label) {
      return `${site.label} 仍要求登录或权限验证；已尝试使用${label}${site.requiresYoutubeWorkarounds ? '并启用 yt-dlp JS challenge 组件' : ''}，但该账号/凭据可能无权访问该视频，或视频需要额外验证。`;
    }
    return `${site.label} 需要登录/cookies 或年龄验证。请在高级设置中启用登录凭据，选择已登录该平台的浏览器，或提供 cookies.txt。`;
  }
  if (/no subtitles|no automatic captions|subtitles are disabled|There are no subtitles/i.test(message)) {
    return '该视频没有公开字幕或自动字幕。';
  }
  if (/unavailable|has been removed|This video is not available|Video unavailable/i.test(message)) {
    return `该 ${site.label} 视频不可用、已删除或当前地区无法访问。`;
  }
  if (/HTTP Error 429|Too Many Requests|rate limit/i.test(message)) {
    return `${site.label} 请求过多或触发限流。请稍后重试，或检查代理/cookies 是否过期。`;
  }
  if (/timed out|timeout|ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|Unable to download|network|SSL|certificate|HTTP Error|fetch failed|Connect Timeout/i.test(message)) {
    return `当前运行环境无法访问 ${site.label} 或字幕接口，请检查网络，或在设置的高级选项里配置 YouTube/yt-dlp 代理。`;
  }
  return `${site.label} 解析失败：${message || '未知错误'}`;
}

function extractJson(stdout: string): YtDlpMetadata {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('yt-dlp 没有返回可解析的元数据 JSON。');
  return JSON.parse(trimmed.slice(start, end + 1)) as YtDlpMetadata;
}

async function fetchMetadata(url: string, site: VideoSiteInfo, useCookies: boolean): Promise<YtDlpMetadata> {
  const { stdout } = await runYtDlp([
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '15',
    '--retries', '2',
    ...siteSpecificArgs(site),
    ...cookiesArgs(useCookies),
    ...proxyArgs(),
    url,
  ], YTDLP_METADATA_TIMEOUT_MS);
  return extractJson(stdout);
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const nextPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(nextPath));
    } else if (entry.isFile()) {
      files.push(nextPath);
    }
  }
  return files;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 10)));
}

function cleanSubtitleText(text: string): string {
  return decodeEntities(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cueStartTime(line: string): string | null {
  const match = line.match(/(\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{3}\s+-->/);
  if (!match) return null;
  const start = match[0].replace(/\s+-->.*/, '').replace(',', '.');
  const parts = start.split(':').map((part) => Number(part));
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
  return formatTime(seconds);
}

function parseSubtitle(raw: string): string {
  const lines = raw.replace(/\r/g, '').split('\n');
  const cues: string[] = [];
  let currentTime: string | null = null;
  let currentText: string[] = [];

  const flush = (): void => {
    const text = cleanSubtitleText(currentText.join(' '));
    if (currentTime && text) cues.push(`[${currentTime}] ${text}`);
    currentTime = null;
    currentText = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^(WEBVTT|NOTE|STYLE|REGION)$/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed) && !currentTime) continue;
    const start = cueStartTime(trimmed);
    if (start) {
      flush();
      currentTime = start;
      continue;
    }
    if (currentTime) currentText.push(trimmed);
  }
  flush();
  return cues.join('\n');
}

function languageFromFile(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const match = name.match(/\.([a-z]{2}(?:[-_][A-Za-z0-9]+)?(?:-[A-Za-z0-9]+)?)\.(?:vtt|srt)$/i);
  return match?.[1] ?? 'unknown';
}

function languagePreference(language: string): number {
  const value = language.toLowerCase();
  if (value.includes('zh-hans') || value.includes('zh-cn')) return 100;
  if (value.includes('zh-tw') || value.includes('zh-hant')) return 92;
  if (value === 'zh' || value.startsWith('zh-')) return 88;
  if (value.startsWith('en')) return 70;
  return 20;
}

function looksLikeTranslatedCaption(code: string): boolean {
  const lower = code.toLowerCase();
  if (['zh-hans', 'zh-hant', 'zh-cn', 'zh-tw', 'en', 'en-orig', 'en-us', 'en-gb'].includes(lower)) return false;
  return /-[a-z]{2}(?:-[a-z0-9]+)?$/i.test(code);
}

function chooseSubtitleLanguage(metadata: YtDlpMetadata): string | null {
  const manual = new Set(Object.keys(metadata.subtitles ?? {}));
  const automatic = new Set(Object.keys(metadata.automatic_captions ?? {}));
  for (const preferred of PREFERRED_SUB_LANGS) {
    if (manual.has(preferred)) return preferred;
  }
  for (const preferred of PREFERRED_SUB_LANGS) {
    if (automatic.has(preferred)) return preferred;
  }
  const manualFallback = [...manual].find((code) => !looksLikeTranslatedCaption(code));
  if (manualFallback) return manualFallback;
  return [...automatic].find((code) => !looksLikeTranslatedCaption(code)) ?? null;
}

async function readBestSubtitle(tempDir: string): Promise<SubtitleCandidate | null> {
  const files = (await listFilesRecursive(tempDir))
    .filter((file) => /\.(vtt|srt)$/i.test(file));
  const candidates: SubtitleCandidate[] = [];
  for (const filePath of files) {
    const raw = await readFile(filePath, 'utf8').catch(() => '');
    const text = parseSubtitle(raw);
    if (!text.trim()) continue;
    const language = languageFromFile(filePath);
    const fileStat = await stat(filePath).catch(() => null);
    candidates.push({
      filePath,
      language,
      text,
      score: languagePreference(language) + Math.min(30, Math.floor((fileStat?.size ?? text.length) / 20_000)),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

async function fetchSubtitle(url: string, metadata: YtDlpMetadata, site: VideoSiteInfo, useCookies: boolean): Promise<SubtitleCandidate | null> {
  const language = chooseSubtitleLanguage(metadata);
  if (!language) return null;
  const tempDir = await mkdtemp(join(tmpdir(), 'ulyzer-ytdlp-'));
  try {
    await runYtDlp([
      '--skip-download',
      '--no-playlist',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', language,
      '--sub-format', 'vtt/best',
      '--no-warnings',
      '--socket-timeout', '15',
      '--retries', '2',
      '--output', join(tempDir, '%(id)s.%(ext)s'),
      ...siteSpecificArgs(site),
      ...cookiesArgs(useCookies),
      ...proxyArgs(),
      url,
    ], YTDLP_SUBTITLE_TIMEOUT_MS, tempDir);
    return await readBestSubtitle(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function availableSubtitleSummary(metadata: YtDlpMetadata): string {
  const manual = Object.keys(metadata.subtitles ?? {});
  const auto = Object.keys(metadata.automatic_captions ?? {});
  const parts = [
    manual.length ? `公开字幕：${manual.slice(0, 12).join(', ')}` : '',
    auto.length ? `自动字幕：${auto.slice(0, 12).join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('；') : '未发现字幕轨道';
}

function titleFromMetadata(inputTitle: string | undefined, metadata: YtDlpMetadata | null, site: VideoSiteInfo): string {
  return inputTitle?.trim() || metadata?.title?.trim() || `${site.label} 视频`;
}

function siteFromMetadataOrUrl(url: string, metadata: YtDlpMetadata | null): VideoSiteInfo {
  const fromUrl = videoSiteFromUrl(url);
  if (!metadata) return fromUrl ?? { key: 'video', label: '视频', host: normalizedHost(url) ?? 'unknown' };
  const extractor = (metadata.extractor_key || metadata.extractor || '').toLowerCase();
  if (extractor.includes('youtube')) return { key: 'youtube', label: 'YouTube', host: normalizedHost(url) ?? 'youtube.com', requiresYoutubeWorkarounds: true };
  if (extractor.includes('bili')) return { key: 'bilibili', label: 'Bilibili', host: normalizedHost(url) ?? 'bilibili.com' };
  if (extractor.includes('vimeo')) return { key: 'vimeo', label: 'Vimeo', host: normalizedHost(url) ?? 'vimeo.com' };
  if (extractor.includes('tiktok')) return { key: 'tiktok', label: 'TikTok', host: normalizedHost(url) ?? 'tiktok.com' };
  if (extractor.includes('douyin')) return { key: 'douyin', label: '抖音', host: normalizedHost(url) ?? 'douyin.com' };
  if (extractor.includes('ted')) return { key: 'ted', label: 'TED', host: normalizedHost(url) ?? 'ted.com' };
  return fromUrl ?? { key: 'video', label: '视频', host: normalizedHost(url) ?? 'unknown' };
}

function formatUploadDate(value?: string): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function chapterSummary(metadata: YtDlpMetadata): string | null {
  const chapters = metadata.chapters ?? [];
  if (!chapters.length) return null;
  return chapters
    .slice(0, 30)
    .map((chapter, index) => {
      const start = typeof chapter.start_time === 'number' ? formatTime(chapter.start_time) : '';
      return `${index + 1}. ${start ? `[${start}] ` : ''}${chapter.title || '未命名章节'}`;
    })
    .join('\n');
}

function metadataContent(input: {
  title: string;
  url: string;
  site: VideoSiteInfo;
  metadata: YtDlpMetadata | null;
  subtitle?: SubtitleCandidate | null;
  note?: string;
  authTried?: boolean;
}): string {
  const metadata = input.metadata;
  const description = metadata?.description?.trim();
  const site = metadata ? siteFromMetadataOrUrl(input.url, metadata) : input.site;
  const sourceUrl = metadata?.webpage_url ?? metadata?.original_url ?? input.url;
  const author = metadata?.channel ?? metadata?.uploader ?? metadata?.creator;
  const chapterText = metadata ? chapterSummary(metadata) : null;
  const uploadDate = formatUploadDate(metadata?.upload_date);
  return [
    `视频资料：${input.title}`,
    `平台：${site.label}`,
    metadata?.extractor || metadata?.extractor_key ? `解析器：${metadata.extractor ?? metadata.extractor_key}` : null,
    metadata?.id ? `视频 ID：${metadata.id}` : null,
    author ? `作者/频道：${author}` : null,
    typeof metadata?.duration === 'number' ? `时长：${formatTime(metadata.duration)}` : null,
    uploadDate ? `发布日期：${uploadDate}` : null,
    metadata?.playlist ? `合集/播放列表：${metadata.playlist}${metadata.playlist_index ? ` · 第 ${metadata.playlist_index} 项` : ''}` : null,
    metadata?.episode ? `分集：${metadata.episode}` : null,
    `原始链接：${sourceUrl}`,
    metadata ? `字幕轨道：${availableSubtitleSummary(metadata)}` : null,
    chapterText ? `章节/时间线：\n${chapterText}` : null,
    description ? `简介：\n${description.slice(0, 2400)}` : null,
    input.subtitle
      ? `字幕 transcript（yt-dlp · ${input.subtitle.language}）：\n${input.subtitle.text}`
      : [
        '字幕 transcript：未获取到可用字幕。',
        input.note ? `说明：${input.note}` : '说明：当前仅保存视频链接和元数据，AI 无法看到视频正文内容。',
      ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

async function buildWithAuthMode(input: {
  title?: string;
  url: string;
  site: VideoSiteInfo;
  useCookies: boolean;
}): Promise<YtDlpResult> {
  const metadata = await fetchMetadata(input.url, input.site, input.useCookies);
  const site = siteFromMetadataOrUrl(input.url, metadata);
  const title = titleFromMetadata(input.title, metadata, site);

  try {
    const subtitle = await fetchSubtitle(input.url, metadata, site, input.useCookies);
    if (subtitle?.text.trim()) {
      return {
        resolvedTitle: title,
        content: metadataContent({ title, url: input.url, site, metadata, subtitle, authTried: input.useCookies }),
        processingState: 'ready',
        site,
        extractor: metadata.extractor ?? metadata.extractor_key,
        authTried: input.useCookies,
      };
    }
    const note = '该视频没有匹配的公开字幕或自动字幕，当前仅保存链接和元数据。';
    return {
      resolvedTitle: title,
      content: metadataContent({ title, url: input.url, site, metadata, note, authTried: input.useCookies }),
      processingError: note,
      processingState: 'limited',
      site,
      extractor: metadata.extractor ?? metadata.extractor_key,
      authTried: input.useCookies,
    };
  } catch (error) {
    if (!input.useCookies && isAuthLikeError(error) && hasConfiguredCookies()) {
      throw error;
    }
    const note = classifyYtDlpError(error, site, input.useCookies);
    return {
      resolvedTitle: title,
      content: metadataContent({ title, url: input.url, site, metadata, note, authTried: input.useCookies }),
      processingError: note,
      processingState: 'limited',
      site,
      extractor: metadata.extractor ?? metadata.extractor_key,
      authTried: input.useCookies,
    };
  }
}

export async function buildVideoUrlContent(input: {
  title?: string;
  url: string;
}): Promise<YtDlpResult> {
  const site = videoSiteFromUrl(input.url) ?? { key: 'video', label: '视频', host: normalizedHost(input.url) ?? 'unknown' };
  try {
    return await buildWithAuthMode({ ...input, site, useCookies: false });
  } catch (error) {
    const shouldRetryWithCookies = isAuthLikeError(error) && hasConfiguredCookies();
    if (shouldRetryWithCookies) {
      try {
        return await buildWithAuthMode({ ...input, site, useCookies: true });
      } catch (retryError) {
        const note = classifyYtDlpError(retryError, site, true);
        const title = titleFromMetadata(input.title, null, site);
        return {
          resolvedTitle: title,
          content: metadataContent({ title, url: input.url, site, metadata: null, note, authTried: true }),
          processingError: note,
          processingState: 'limited',
          site,
          authTried: true,
        };
      }
    }
    const note = classifyYtDlpError(error, site, false);
    const title = titleFromMetadata(input.title, null, site);
    return {
      resolvedTitle: title,
      content: metadataContent({ title, url: input.url, site, metadata: null, note, authTried: false }),
      processingError: note,
      processingState: 'limited',
      site,
      authTried: false,
    };
  }
}

export function videoMimeType(site?: VideoSiteInfo | null, extractor?: string | null): string {
  const params = [
    site?.key ? `site=${site.key}` : null,
    extractor ? `extractor=${String(extractor).replace(/[^a-z0-9_-]/gi, '').slice(0, 48)}` : null,
  ].filter(Boolean);
  return params.length ? `text/video-link; ${params.join('; ')}` : 'text/video-link';
}
