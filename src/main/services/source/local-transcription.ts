import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getLibraryRoot } from './source-assets';
import type { FfmpegStatus, WhisperStatus, WhisperInstallResult } from '@shared/types';

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = process.env.ULYZER_LOCAL_WHISPER_MODEL || 'mlx-community/whisper-tiny';
const MAX_BUFFER = 1024 * 1024 * 64;
const PYPI_TRUSTED_HOSTS = ['pypi.org', 'files.pythonhosted.org', 'pypi.python.org'] as const;
const FALLBACK_MODELS = [
  DEFAULT_MODEL,
  'mlx-community/whisper-tiny',
  'mlx-community/whisper-tiny-mlx',
  'mlx-community/whisper-base-mlx',
].filter((model, index, all) => all.indexOf(model) === index);

const PYTHON_TRANSCRIBE_SCRIPT = String.raw`
import json
import sys

import mlx_whisper

RESULT_PREFIX = "__ULYZER_TRANSCRIBE_RESULT__="

audio_path = sys.argv[1]
model_repo = sys.argv[2]

result = mlx_whisper.transcribe(
    audio_path,
    path_or_hf_repo=model_repo,
    verbose=False,
)

segments = []
for segment in (result.get("segments") or []):
    text = str(segment.get("text", "")).strip()
    if not text:
        continue
    segments.append({
        "start": float(segment.get("start", 0.0) or 0.0),
        "end": float(segment.get("end", 0.0) or 0.0),
        "text": text,
    })

print(RESULT_PREFIX + json.dumps({
    "text": str(result.get("text", "")).strip(),
    "language": result.get("language"),
    "segments": segments,
}, ensure_ascii=False))
`;

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface LocalTranscriptionResult {
  text: string;
  language?: string;
  segments: TranscriptionSegment[];
}

let ensurePythonRuntimePromise: Promise<string> | null = null;

function runtimeRoot(): string {
  const root = join(getLibraryRoot(), '.runtime', 'local-transcription');
  mkdirSync(root, { recursive: true });
  return root;
}

function venvDir(): string {
  return join(runtimeRoot(), 'venv');
}

function venvPython(): string {
  return join(venvDir(), 'bin', 'python3');
}

function pythonCandidates(): string[] {
  return [process.env.ULYZER_LOCAL_PYTHON, 'python3', '/usr/bin/python3']
    .filter((value): value is string => Boolean(value));
}

async function commandExists(command: string, versionArgs: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, versionArgs, { maxBuffer: MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}

async function resolvePythonBootstrap(): Promise<string> {
  for (const candidate of pythonCandidates()) {
    if (await commandExists(candidate, ['--version'])) return candidate;
  }
  throw new Error('未找到可用的本地 Python 运行时（需要 python3）。');
}

async function resolveFfmpeg(): Promise<string> {
  const candidates = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const candidate of candidates) {
    if (await commandExists(candidate, ['-version'])) return candidate;
  }
  throw new Error('未找到 ffmpeg，无法进行本地音频/视频转写。');
}

async function ensureVenv(): Promise<string> {
  const pythonPath = venvPython();
  if (existsSync(pythonPath)) return pythonPath;

  const bootstrap = await resolvePythonBootstrap();
  await execFileAsync(bootstrap, ['-m', 'venv', venvDir()], { maxBuffer: MAX_BUFFER });
  await execFileAsync(pythonPath, ['-m', 'ensurepip', '--upgrade'], { maxBuffer: MAX_BUFFER }).catch(() => undefined);
  await execFileAsync(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
    maxBuffer: MAX_BUFFER,
  }).catch(() => undefined);
  return pythonPath;
}

async function ensurePythonRuntime(): Promise<string> {
  if (!ensurePythonRuntimePromise) {
    ensurePythonRuntimePromise = (async () => {
      const pythonPath = await ensureVenv();
      try {
        await execFileAsync(pythonPath, ['-c', 'import mlx_whisper'], { maxBuffer: MAX_BUFFER });
      } catch {
        await installMlxWhisper(pythonPath);
      }
      return pythonPath;
    })().catch((error) => {
      ensurePythonRuntimePromise = null;
      throw error;
    });
  }
  return ensurePythonRuntimePromise;
}

function pipBaseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HF_HOME: join(runtimeRoot(), 'hf-cache'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
  };
}

function isSslInstallError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CERTIFICATE_VERIFY_FAILED|SSLError|unable to get local issuer certificate/i.test(message);
}

async function installMlxWhisper(pythonPath: string): Promise<void> {
  const baseArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', 'mlx-whisper'];
  try {
    await execFileAsync(pythonPath, baseArgs, {
      maxBuffer: MAX_BUFFER,
      env: pipBaseEnv(),
    });
    return;
  } catch (error) {
    if (!isSslInstallError(error)) throw error;
  }

  const retryArgs = [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    ...PYPI_TRUSTED_HOSTS.flatMap((host) => ['--trusted-host', host]),
    'mlx-whisper',
  ];

  try {
    await execFileAsync(pythonPath, retryArgs, {
      maxBuffer: MAX_BUFFER,
      env: pipBaseEnv(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `本地转写运行时安装失败。已尝试常规安装，并在证书校验失败后重试 PyPI 可信主机模式，仍未成功：${message}`,
    );
  }
}

/** mlx-whisper (the local transcription backend) only runs on Apple Silicon macOS. */
function whisperPlatformSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

export async function getFfmpegStatus(): Promise<FfmpegStatus> {
  try {
    return { available: true, path: await resolveFfmpeg() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getWhisperStatus(): Promise<WhisperStatus> {
  const platformSupported = whisperPlatformSupported();
  if (!platformSupported) {
    return { available: false, platformSupported, error: '本地语音转写依赖 mlx-whisper，仅支持 Apple Silicon (M 系列) Mac。' };
  }
  const pythonPath = venvPython();
  if (!existsSync(pythonPath)) {
    return { available: false, platformSupported, error: '本地转写运行时尚未安装，可在设置中一键安装。' };
  }
  try {
    await execFileAsync(pythonPath, ['-c', 'import mlx_whisper'], { maxBuffer: MAX_BUFFER });
    return { available: true, platformSupported };
  } catch {
    return { available: false, platformSupported, error: 'mlx-whisper 尚未安装，可在设置中一键安装。' };
  }
}

export async function installWhisper(): Promise<WhisperInstallResult> {
  if (!whisperPlatformSupported()) {
    return {
      available: false,
      platformSupported: false,
      installed: false,
      error: '本地语音转写仅支持 Apple Silicon (M 系列) Mac，当前设备不支持。',
    };
  }
  await ensurePythonRuntime();
  const status = await getWhisperStatus();
  return { ...status, installed: status.available };
}

async function normalizeAudio(inputPath: string): Promise<string> {
  const ffmpeg = await resolveFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), 'ulyzer-transcribe-audio-'));
  const wavPath = join(dir, 'normalized.wav');
  try {
    await execFileAsync(
      ffmpeg,
      ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath],
      { maxBuffer: MAX_BUFFER },
    );
    return wavPath;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function parseTranscription(stdout: string): LocalTranscriptionResult {
  const marker = '__ULYZER_TRANSCRIBE_RESULT__=';
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(marker));
  if (!line) {
    throw new Error(`本地转写输出缺少结果标记：${stdout.trim().slice(0, 240) || 'empty stdout'}`);
  }
  const parsed = JSON.parse(line.slice(marker.length) || '{}') as LocalTranscriptionResult;
  return {
    text: String(parsed.text ?? '').trim(),
    language: parsed.language,
    segments: Array.isArray(parsed.segments)
      ? parsed.segments
        .filter((segment) => segment && typeof segment.text === 'string')
        .map((segment) => ({
          start: Number(segment.start ?? 0),
          end: Number(segment.end ?? 0),
          text: String(segment.text).trim(),
        }))
      : [],
  };
}

function isModelRepoResolutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /RepositoryNotFoundError|401 Unauthorized|404 Not Found|Invalid username or password|api\/models\//i.test(message);
}

async function runTranscriptionScript(
  pythonPath: string,
  scriptPath: string,
  wavPath: string,
  modelRepo: string,
): Promise<LocalTranscriptionResult> {
  const { stdout } = await execFileAsync(
    pythonPath,
    [scriptPath, wavPath, modelRepo],
    {
      maxBuffer: MAX_BUFFER,
      env: {
        ...process.env,
        HF_HOME: join(runtimeRoot(), 'hf-cache'),
      },
    },
  );
  return parseTranscription(stdout);
}

export async function transcribeMediaLocally(inputPath: string): Promise<LocalTranscriptionResult> {
  const pythonPath = await ensurePythonRuntime();
  const wavPath = await normalizeAudio(inputPath);
  const dir = await mkdtemp(join(tmpdir(), 'ulyzer-transcribe-script-'));
  const scriptPath = join(dir, 'transcribe.py');
  try {
    await writeFile(scriptPath, PYTHON_TRANSCRIBE_SCRIPT, 'utf8');
    let lastError: unknown = null;
    for (let index = 0; index < FALLBACK_MODELS.length; index += 1) {
      const modelRepo = FALLBACK_MODELS[index];
      try {
        return await runTranscriptionScript(pythonPath, scriptPath, wavPath, modelRepo);
      } catch (error) {
        lastError = error;
        if (!isModelRepoResolutionError(error) || index === FALLBACK_MODELS.length - 1) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(dirname(wavPath), { recursive: true, force: true }).catch(() => undefined);
  }
}
