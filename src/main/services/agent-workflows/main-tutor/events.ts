export function safeSend(sender: Electron.WebContents, channel: string, data: unknown): void {
  try {
    if (!sender.isDestroyed()) sender.send(channel, data);
  } catch {
    // Window may have closed while an async agent task was still running.
  }
}
