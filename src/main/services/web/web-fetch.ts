/**
 * web_fetch — read a single user-provided URL and return its cleaned main text.
 *
 * Unlike web_search (which needs a Tavily/Exa API key), this only does an HTTP
 * fetch + readability extraction via the existing page extractor, so it works
 * with no search API configured. A best-effort SSRF guard blocks non-http(s)
 * schemes and local/internal addresses before any request is made.
 */
import { extractPage } from './page-extractor';
import { assertPublicUrl, UnsafeUrlError } from './ssrf-guard';
import { localMsg } from '../agent-i18n/messages';

export interface FetchUrlInput {
  url: string;
  language?: string;
  maxChars?: number;
}

export interface FetchUrlResult {
  ok: boolean;
  summary: string;
}

export async function fetchUrlForAgent(input: FetchUrlInput): Promise<FetchUrlResult> {
  let url: URL;
  try {
    url = await assertPublicUrl(input.url);
  } catch (err) {
    const reason = err instanceof UnsafeUrlError ? err.reason : 'invalid';
    if (reason === 'protocol') {
      return { ok: false, summary: localMsg(input.language, '只能抓取 http/https 链接。', 'Only http/https URLs can be fetched.') };
    }
    if (reason === 'private') {
      return { ok: false, summary: localMsg(input.language, '出于安全考虑，禁止抓取本地或内网地址。', 'Local or internal addresses are blocked for security.') };
    }
    return { ok: false, summary: localMsg(input.language, '链接格式无效，请提供完整的网页地址。', 'Invalid URL — please provide a full web address.') };
  }

  try {
    const page = await extractPage(url.toString(), '', { maxChars: input.maxChars ?? 12_000 });
    if (!page.text.trim()) {
      return { ok: false, summary: localMsg(input.language, '该页面没有可提取的正文内容（可能需要登录或由脚本动态渲染）。', 'No readable content could be extracted (the page may require login or render via scripts).') };
    }
    const header = [
      `${localMsg(input.language, '标题', 'Title')}: ${page.title || url.hostname}`,
      `${localMsg(input.language, '链接', 'URL')}: ${page.canonicalUrl || url.toString()}`,
      page.siteName ? `${localMsg(input.language, '站点', 'Site')}: ${page.siteName}` : '',
      page.byline ? `${localMsg(input.language, '作者', 'Byline')}: ${page.byline}` : '',
    ].filter(Boolean).join('\n');
    return { ok: true, summary: `${header}\n\n${page.text}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: localMsg(input.language, `抓取失败：${msg}`, `Fetch failed: ${msg}`) };
  }
}
