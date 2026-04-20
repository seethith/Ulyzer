/**
 * Structured logger for Ulyzer main process.
 *
 * - Development: human-readable console output with level prefix
 * - Production:  JSON lines appended to ~/Library/Logs/Ulyzer/app.log
 *
 * Usage:
 *   const log = createLogger('SubTutorLoop');
 *   log.info('循环开始', { nodeId, provider, turn: 0 });
 *   log.warn('上下文接近上限', { used: budget.used, limit: budget.limit });
 *   log.error('工具执行失败', { tool: 'save_file', error: err.message });
 *   log.debug('tool result', { chars: result.length }); // only when LEARNOS_DEBUG=1
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ── Log file path ─────────────────────────────────────────────────────────────

function getLogPath(): string {
  return path.join(app.getPath('logs'), 'app.log');
}

function ensureLogDir(): void {
  try { fs.mkdirSync(path.dirname(getLogPath()), { recursive: true }); } catch { /* ok */ }
}

// ── Core log function ─────────────────────────────────────────────────────────

function log(level: string, module: string, msg: string, meta?: object): void {
  const entry = {
    ts:  new Date().toISOString(),
    level,
    module,
    msg,
    ...(meta ?? {}),
  };

  if (process.env.NODE_ENV === 'development' || process.env.LEARNOS_DEBUG) {
    // Pretty console output in development
    const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
    console.log(`[${level}] [${module}] ${msg}${metaStr}`);
  } else {
    // Append structured JSON in production
    try {
      ensureLogDir();
      fs.appendFileSync(getLogPath(), JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* non-fatal */ }
  }
}

// ── Logger factory ────────────────────────────────────────────────────────────

export interface Logger {
  info  (msg: string, meta?: object): void;
  warn  (msg: string, meta?: object): void;
  error (msg: string, meta?: object): void;
  /** Emitted only when LEARNOS_DEBUG=1 */
  debug (msg: string, meta?: object): void;
}

export function createLogger(module: string): Logger {
  return {
    info:  (msg, meta) => log('INFO',  module, msg, meta),
    warn:  (msg, meta) => log('WARN',  module, msg, meta),
    error: (msg, meta) => log('ERROR', module, msg, meta),
    debug: (msg, meta) => {
      if (process.env.LEARNOS_DEBUG) log('DEBUG', module, msg, meta);
    },
  };
}
