import { useEffect, useState } from 'react';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse } from '@shared/types';

function imageMimeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

export function useLocalImageDataUrl(filePath: string): string {
  const [dataUrl, setDataUrl] = useState('');

  useEffect(() => {
    const path = filePath.trim();
    let cancelled = false;
    setDataUrl('');
    if (!path) return;

    window.api.invoke(IPC.FS_READ_FILE_BINARY, path)
      .then((res) => {
        const result = res as IpcResponse<string>;
        if (!cancelled && result.success && result.data) {
          setDataUrl(`data:${imageMimeFromPath(path)};base64,${result.data}`);
        }
      })
      .catch(() => {
        if (!cancelled) setDataUrl('');
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return dataUrl;
}
