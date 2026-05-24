import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveSwiftBinary } from '../documents/swift-runtime';

const execFileAsync = promisify(execFile);

// ── macOS: Vision (VNRecognizeTextRequest), compiled+run via the Swift toolchain ──

const SWIFT_OCR_SCRIPT = String.raw`
import Foundation
import Vision
import CoreGraphics
import ImageIO

struct Output: Encodable {
  let text: String
}

guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write(Data("missing-image-path".utf8))
  exit(2)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard
  let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write(Data("image-load-failed".utf8))
  exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
  try handler.perform([request])
  let observations = request.results ?? []
  let texts = observations.compactMap { observation -> String? in
    observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
  }.filter { !$0.isEmpty }
  let payload = Output(text: texts.joined(separator: "\n"))
  let data = try JSONEncoder().encode(payload)
  FileHandle.standardOutput.write(data)
} catch {
  FileHandle.standardError.write(Data(String(describing: error).utf8))
  exit(4)
}
`;

// ── Windows: Windows.Media.Ocr (on-device, free), driven via Windows PowerShell 5.1 ──
//
// Windows PowerShell (powershell.exe, not pwsh) ships the implicit WinRT projection
// every Windows 10/11 has, so no compiled helper or dependency is needed — symmetric
// to the macOS Swift approach. Output is UTF-8 JSON `{ "text": "..." }`.

const WINDOWS_OCR_PS1 = String.raw`
param([Parameter(Mandatory = $true, Position = 0)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  # Resolve IAsyncOperation<T>.AsTask without writing the generic-arity backtick literal.
  $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') } |
    Select-Object -First 1
  function Await($op, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = $null
  foreach ($lang in @('zh-Hans-CN', 'zh-Hant-TW', 'en-US')) {
    try {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($lang))
      if ($engine) { break }
    } catch {}
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { [Console]::Error.Write('ocr-engine-unavailable'); exit 5 }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $text = ($result.Lines | ForEach-Object { $_.Text }) -join [char]10
  [Console]::Out.Write((@{ text = $text } | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 4
}
`;

export interface LocalOcrResult {
  text: string;
}

async function runMacVisionOcr(imagePath: string): Promise<LocalOcrResult> {
  // Prefer the precompiled binary (no Xcode toolchain needed on the user's machine).
  const binary = resolveSwiftBinary('image-ocr');
  if (binary) {
    const { stdout } = await execFileAsync(binary, [imagePath], { maxBuffer: 1024 * 1024 * 4 });
    const parsed = JSON.parse(stdout || '{}') as LocalOcrResult;
    return { text: String(parsed.text ?? '').trim() };
  }
  // Fallback: interpret the inline source via /usr/bin/swift (running from source).
  const dir = await mkdtemp(join(tmpdir(), 'ulyzer-ocr-'));
  const scriptPath = join(dir, 'ocr.swift');
  try {
    await writeFile(scriptPath, SWIFT_OCR_SCRIPT, 'utf8');
    const { stdout } = await execFileAsync('/usr/bin/swift', [scriptPath, imagePath], {
      maxBuffer: 1024 * 1024 * 4,
    });
    const parsed = JSON.parse(stdout || '{}') as LocalOcrResult;
    return { text: String(parsed.text ?? '').trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runWindowsOcr(imagePath: string): Promise<LocalOcrResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ulyzer-ocr-'));
  const scriptPath = join(dir, 'ocr.ps1');
  try {
    await writeFile(scriptPath, WINDOWS_OCR_PS1, 'utf8');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, imagePath],
      { maxBuffer: 1024 * 1024 * 8, windowsHide: true, encoding: 'utf8' },
    );
    const parsed = JSON.parse(stdout || '{}') as LocalOcrResult;
    return { text: String(parsed.text ?? '').trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * On-device image OCR. macOS uses Vision; Windows uses Windows.Media.Ocr. Both run
 * a small inline script (Swift / PowerShell) as a subprocess. Other platforms are
 * unsupported; callers treat a throw as "no OCR available" and fall back gracefully.
 */
export async function extractImageTextLocally(imagePath: string): Promise<LocalOcrResult> {
  try {
    if (process.platform === 'darwin') return await runMacVisionOcr(imagePath);
    if (process.platform === 'win32') return await runWindowsOcr(imagePath);
    throw new Error('本地图片 OCR 当前仅支持 macOS 和 Windows。');
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
