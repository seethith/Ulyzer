import { BrowserWindow, app } from 'electron';
import type { Event as ElectronEvent } from 'electron';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { assertPublicUrl, isUnsafeUrlSync } from './ssrf-guard';

const MAX_REDIRECTS = 8;

/**
 * fetch() variant that re-runs the SSRF guard on the initial URL and on every
 * redirect hop. A string-only guard on the initial URL is bypassable via a 30x
 * redirect into an internal address, so each hop is resolved + checked here.
 */
async function safeFetch(initialUrl: string, init: RequestInit): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
      void res.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}

export interface ExtractedPage {
  title: string;
  text: string;
  host: string;
  canonicalUrl?: string;
  excerpt?: string;
  byline?: string;
  siteName?: string;
  lang?: string;
  method?: 'readability' | 'dom' | 'rendered' | 'plain';
  qualityScore?: number;
}

export interface ExtractPageOptions {
  timeoutMs?: number;
  maxChars?: number;
  query?: string;
  searchExcerpt?: string;
  renderFallback?: boolean;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitle(html: string, fallback: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) return decodeEntities(title[1].replace(/\s+/g, ' ')).trim();
  return fallback;
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToReadableText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return normalizeWhitespace(decodeEntities(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ));
}

function hostText(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function compactDomText(document: Document): string {
  const clone = document.body?.cloneNode(true) as HTMLElement | null;
  if (!clone) return '';
  clone.querySelectorAll('script,style,noscript,nav,header,footer,svg,canvas,form').forEach((node) => node.remove());
  clone.querySelectorAll('table').forEach((table) => {
    const rows = [...table.querySelectorAll('tr')].map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => normalizeWhitespace(cell.textContent ?? '')).filter(Boolean).join(' | '),
    ).filter(Boolean);
    if (rows.length) table.replaceWith(document.createTextNode(`\n${rows.join('\n')}\n`));
  });
  return normalizeWhitespace(clone.textContent ?? '');
}

function canonicalFromDocument(document: Document, baseUrl: string): string | undefined {
  const href = document.querySelector<HTMLLinkElement>('link[rel="canonical" i]')?.href
    || document.querySelector<HTMLMetaElement>('meta[property="og:url" i]')?.content;
  if (!href) return undefined;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function queryOverlap(text: string, query?: string): number {
  if (!query?.trim()) return 0.2;
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 16);
  if (!tokens.length) return 0.2;
  const lower = text.toLowerCase();
  let hit = 0;
  for (const token of tokens) {
    if (lower.includes(token)) hit++;
  }
  return hit / tokens.length;
}

function scoreTextQuality(input: { text: string; title?: string; query?: string; method: ExtractedPage['method'] }): number {
  const text = input.text.trim();
  if (!text) return 0;
  const lengthScore = Math.min(1, text.length / 3500);
  const lineCount = text.split('\n').filter((line) => line.trim().length > 8).length;
  const lineScore = Math.min(1, lineCount / 12);
  const navMatches = (text.match(/登录|注册|关注|分享|广告|菜单|copyright|privacy|cookie|subscribe|navigation/gi) ?? []).length;
  const boilerplatePenalty = Math.min(0.35, navMatches / 80);
  const duplicatePenalty = (() => {
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 20).slice(0, 120);
    if (lines.length < 10) return 0;
    const unique = new Set(lines);
    return Math.min(0.25, (1 - unique.size / lines.length) * 0.5);
  })();
  const queryScore = queryOverlap(`${input.title ?? ''}\n${text.slice(0, 8000)}`, input.query);
  const methodBonus = input.method === 'readability' ? 0.12 : input.method === 'rendered' ? 0.08 : 0;
  return Math.max(0, Math.min(1, lengthScore * 0.42 + lineScore * 0.24 + queryScore * 0.22 + methodBonus - boilerplatePenalty - duplicatePenalty));
}

function shouldRenderFallback(page: ExtractedPage, rawHtml: string): boolean {
  if ((page.qualityScore ?? 0) < 0.45) return true;
  if (page.text.length < 900 && /id=["']root["']|id=["']app["']|__NEXT_DATA__|webpack|vite|data-reactroot/i.test(rawHtml)) return true;
  if (/enable javascript|requires javascript|please turn on javascript/i.test(page.text)) return true;
  return false;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderPage(url: string, fallbackTitle: string, options?: ExtractPageOptions): Promise<ExtractedPage | null> {
  if (!app.isReady()) await app.whenReady();
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 1600,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        images: false,
      },
    });
    win.webContents.setAudioMuted(true);
    // The initial URL is already guarded by the caller (safeFetch / web_fetch);
    // block any redirect or in-page navigation that targets an internal address.
    const blockUnsafe = (event: ElectronEvent, target: string): void => {
      if (isUnsafeUrlSync(target)) event.preventDefault();
    };
    win.webContents.on('will-redirect', blockUnsafe);
    win.webContents.on('will-navigate', blockUnsafe);
    await win.loadURL(url, {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Ulyzer/0.1',
    });
    await wait(1800);
    const rendered = await win.webContents.executeJavaScript(`
      (() => {
        const remove = 'script,style,noscript,nav,header,footer,svg,canvas,form';
        const clone = document.body ? document.body.cloneNode(true) : null;
        if (!clone) return { title: document.title || '', text: '', canonicalUrl: location.href, lang: document.documentElement.lang || '' };
        clone.querySelectorAll(remove).forEach((node) => node.remove());
        clone.querySelectorAll('table').forEach((table) => {
          const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
            Array.from(row.querySelectorAll('th,td')).map((cell) => (cell.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).join(' | ')
          ).filter(Boolean);
          if (rows.length) table.replaceWith(document.createTextNode('\\n' + rows.join('\\n') + '\\n'));
        });
        const canonical = document.querySelector('link[rel="canonical" i]')?.href || document.querySelector('meta[property="og:url" i]')?.content || location.href;
        const excerpt = document.querySelector('meta[name="description" i]')?.content || document.querySelector('meta[property="og:description" i]')?.content || '';
        return {
          title: document.title || '',
          text: clone.textContent || '',
          canonicalUrl: canonical,
          excerpt,
          lang: document.documentElement.lang || ''
        };
      })()
    `, true) as { title?: string; text?: string; canonicalUrl?: string; excerpt?: string; lang?: string };
    const text = normalizeWhitespace(rendered.text ?? '').slice(0, options?.maxChars ?? 40_000);
    const title = normalizeWhitespace(rendered.title ?? '') || fallbackTitle || hostText(url);
    const page: ExtractedPage = {
      title,
      text,
      host: hostText(url),
      canonicalUrl: rendered.canonicalUrl,
      excerpt: normalizeWhitespace(rendered.excerpt ?? '') || undefined,
      lang: rendered.lang,
      method: 'rendered',
    };
    page.qualityScore = scoreTextQuality({ text: page.text, title: page.title, query: options?.query, method: 'rendered' });
    return page;
  } catch {
    return null;
  } finally {
    win?.destroy();
  }
}

function extractHtmlPage(url: string, raw: string, fallbackTitle: string, options?: ExtractPageOptions): ExtractedPage {
  const dom = new JSDOM(raw, { url });
  const document = dom.window.document;
  const reader = new Readability(document.cloneNode(true) as Document);
  const article = reader.parse();
  const readabilityText = article?.textContent ? normalizeWhitespace(article.textContent) : '';
  const domText = compactDomText(document);
  const useReadability = readabilityText.length >= Math.min(800, Math.max(180, domText.length * 0.25));
  const text = (useReadability ? readabilityText : domText || htmlToReadableText(raw)).slice(0, options?.maxChars ?? 40_000);
  const title = normalizeWhitespace(article?.title ?? '') || extractTitle(raw, fallbackTitle || hostText(url));
  const method: ExtractedPage['method'] = useReadability ? 'readability' : 'dom';
  const page: ExtractedPage = {
    title,
    text,
    host: hostText(url),
    canonicalUrl: canonicalFromDocument(document, url),
    excerpt: normalizeWhitespace(article?.excerpt ?? document.querySelector<HTMLMetaElement>('meta[name="description" i]')?.content ?? '') || undefined,
    byline: normalizeWhitespace(article?.byline ?? '') || undefined,
    siteName: normalizeWhitespace(article?.siteName ?? '') || undefined,
    lang: document.documentElement.lang || undefined,
    method,
  };
  page.qualityScore = scoreTextQuality({ text: page.text, title: page.title, query: options?.query, method });
  return page;
}

export async function extractPage(url: string, fallbackTitle = '', options?: ExtractPageOptions): Promise<ExtractedPage> {
  const parsed = new URL(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 8_000);
  try {
    const res = await safeFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Ulyzer/0.1 (+https://github.com/seethith/Ulyzer)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`Page fetch failed: ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    const isHtml = contentType.includes('html') || /<html|<body|<article/i.test(raw);
    if (isHtml) {
      const page = extractHtmlPage(url, raw, fallbackTitle || parsed.hostname, options);
      if (options?.renderFallback !== false && shouldRenderFallback(page, raw)) {
        const rendered = await renderPage(url, page.title, options);
        if (rendered && (rendered.qualityScore ?? 0) > (page.qualityScore ?? 0) && rendered.text.length > page.text.length * 0.7) {
          return rendered;
        }
      }
      return page;
    }
    const text = normalizeWhitespace(raw).slice(0, options?.maxChars ?? 40_000);
    return {
      title: fallbackTitle || parsed.hostname,
      text,
      host: parsed.hostname.replace(/^www\./, ''),
      method: 'plain',
      qualityScore: scoreTextQuality({ text, title: fallbackTitle || parsed.hostname, query: options?.query, method: 'plain' }),
    };
  } finally {
    clearTimeout(timeout);
  }
}
