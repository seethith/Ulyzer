/**
 * web_fetch chat tool — reads a single user-provided URL and returns its cleaned
 * main text. Needs no search API key: it does a direct HTTP fetch + readability
 * extraction (with an SSRF guard) via the shared web-fetch helper.
 */
import { z } from 'zod';
import type { TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';
import { fetchUrlForAgent } from '../../web/web-fetch';
import { blockWebMessage } from '../search-mode-guard';

interface WebFetchResult { found: boolean; summary: string }

export const webFetchChatTool: TutorTool<{ url: string }, WebFetchResult> = buildTool({
  name: 'web_fetch',
  description:
    '【做什么】抓取用户提供的网页链接，返回清洗后的正文内容（不需要搜索 API）。' +
    '【何时调用】用户在消息里粘贴了一个网址（博客、官方文档、Stack Overflow、GitHub README 等）希望你阅读/讲解该页面，或 web_search 返回结果后需要深入读取某条来源的正文时。' +
    '【返回】网页标题、链接和提取后的正文文本。' +
    '【限制】只支持 http/https，禁止本地/内网地址；需要登录或纯脚本动态渲染的内容可能抓不全；一次只抓一个链接，不要用它做关键词搜索（用 web_search）。',
  inputSchema: z.object({
    url: z.string().min(1),
  }),
  inputJsonSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: '要抓取的网页完整链接（必须以 http:// 或 https:// 开头）' },
    },
  },
  maxResultChars: 8000,
  isReadOnly: true,
  execute: async (input, ctx): Promise<WebFetchResult> => {
    const blocked = blockWebMessage(ctx.searchMode, ctx.language);
    if (blocked) return { found: false, summary: blocked };
    ctx.onProgress?.(`🌐 抓取网页：${input.url}\n`);
    const res = await fetchUrlForAgent({ url: input.url, language: ctx.language });
    return { found: res.ok, summary: res.summary };
  },
  formatResult: (r) => r.summary,
});
