/**
 * Extended reading section appended to AI-generated theory and practice files.
 *
 * All links are parameterised search URLs — no API keys required, zero config.
 * Domain-specific extras are added when the subject is detected.
 *
 * Section order (theory):  参考教材 → 辅助理解 → 社区与文档
 * Section order (practice): 参考演示 → 社区参考
 */
import type { Domain } from '../web/source-strategy';
import type { GenerateFolder } from '@shared/types';

// ── Textbook links (same for all domains) ─────────────────────────────────────

function textbookLinks(q: string): string[] {
  return [
    `- [Google Books](https://books.google.com/books?q=${q}) — 教材预览与检索`,
    `- [Open Library](https://openlibrary.org/search?q=${q}) — 开放电子书`,
    `- [Z-Library](https://z-lib.id/s/${q}) — 电子书资源（如可访问）`,
    `- [Google Scholar](https://scholar.google.com/scholar?q=${q}) — 学术论文与权威综述`,
  ];
}

// ── Community & doc links by domain ──────────────────────────────────────────

function communityLinks(domain: Domain, q: string): string[] {
  switch (domain) {
    case 'programming':
      return [
        `- [MDN Web Docs](https://developer.mozilla.org/zh-CN/search?q=${q}) — Web 技术权威文档`,
        `- [Stack Overflow](https://stackoverflow.com/search?q=${q}) — 编程问答社区`,
        `- [GitHub](https://github.com/search?q=${q}&type=repositories) — 参考实现与开源项目`,
        `- [GeeksforGeeks](https://www.geeksforgeeks.org/search/?q=${q}) — 算法与编程讲解`,
        `- [Dev.to](https://dev.to/search?q=${q}) — 开发者经验文章`,
        `- [CSDN](https://so.csdn.net/so/search?q=${q}) — 中文技术社区`,
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文深度讨论`,
        `- [Hacker News](https://hn.algolia.com/?q=${q}) — 技术新闻与讨论`,
      ];
    case 'math':
      return [
        `- [Wikipedia](https://en.wikipedia.org/w/index.php?search=${q}) — 数学百科`,
        `- [Wolfram MathWorld](https://mathworld.wolfram.com/search/?query=${q}) — 数学权威参考`,
        `- [Art of Problem Solving](https://artofproblemsolving.com/search?q=${q}) — 竞赛数学社区`,
        `- [Math Stack Exchange](https://math.stackexchange.com/search?q=${q}) — 数学问答社区`,
        `- [知乎数学](https://www.zhihu.com/search?q=${q}+数学) — 中文讨论`,
        `- [Reddit r/math](https://www.reddit.com/r/math/search/?q=${q}) — 英文数学讨论`,
      ];
    case 'science':
      return [
        `- [Wikipedia](https://en.wikipedia.org/w/index.php?search=${q}) — 科学百科`,
        `- [Google Scholar](https://scholar.google.com/scholar?q=${q}) — 学术论文`,
        `- [PubMed](https://pubmed.ncbi.nlm.nih.gov/?term=${q}) — 生命科学文献（如适用）`,
        `- [Physics Stack Exchange](https://physics.stackexchange.com/search?q=${q}) — 物理问答（如适用）`,
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文科普讨论`,
        `- [Reddit r/science](https://www.reddit.com/r/science/search/?q=${q}) — 英文科学讨论`,
      ];
    case 'social_humanities':
      return [
        `- [Wikipedia](https://en.wikipedia.org/w/index.php?search=${q}) — 人文百科`,
        `- [Google Scholar](https://scholar.google.com/scholar?q=${q}) — 学术文献`,
        `- [JSTOR](https://www.jstor.org/action/doBasicSearch?Query=${q}) — 人文社科期刊`,
        `- [Stanford Encyclopedia of Philosophy](https://plato.stanford.edu/search/searcher.py?query=${q}) — 哲学/社科权威词条`,
        `- [Academia.edu](https://www.academia.edu/search?q=${q}) — 学术论文分享`,
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文深度讨论`,
      ];
    case 'business':
      return [
        `- [Google Scholar](https://scholar.google.com/scholar?q=${q}) — 学术文献`,
        `- [Harvard Business Review](https://hbr.org/search?term=${q}) — 商业管理深度文章`,
        `- [Investopedia](https://www.investopedia.com/search?q=${q}) — 财经金融参考`,
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文讨论`,
        `- [Reddit r/business](https://www.reddit.com/r/business/search/?q=${q}) — 英文商业讨论`,
      ];
    case 'language':
      return [
        `- [Wikipedia](https://en.wikipedia.org/w/index.php?search=${q}) — 语言学百科`,
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文学习经验`,
        `- [Reddit Language Learning](https://www.reddit.com/r/languagelearning/search/?q=${q}) — 语言学习社区`,
        `- [Quora](https://www.quora.com/search?q=${q}) — 多语种问答`,
      ];
    case 'creative':
      return [
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文创作社区`,
        `- [Instructables](https://www.instructables.com/search/?q=${q}) — 创意教程`,
        `- [Reddit](https://www.reddit.com/search/?q=${q}) — 英文创作社区`,
        `- [Pinterest](https://www.pinterest.com/search/pins/?q=${q}) — 创意灵感`,
      ];
    case 'sports_fitness':
      return [
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文健身讨论`,
        `- [Reddit r/Fitness](https://www.reddit.com/r/Fitness/search/?q=${q}) — 英文健身社区`,
        `- [ACE Fitness](https://www.acefitness.org/search/#q=${q}) — 运动科学参考`,
      ];
    default: // general
      return [
        `- [Wikipedia](https://en.wikipedia.org/w/index.php?search=${q}) — 百科全书`,
        `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文深度讨论`,
        `- [Reddit](https://www.reddit.com/search/?q=${q}) — 英文社区讨论`,
        `- [Medium](https://medium.com/search?q=${q}) — 深度文章`,
        `- [Quora](https://www.quora.com/search?q=${q}) — 多角度问答`,
      ];
  }
}

// ── Practice community links ──────────────────────────────────────────────────

function practiceCommunityLinks(domain: Domain, q: string): string[] {
  if (domain === 'programming') {
    return [
      `- [Stack Overflow](https://stackoverflow.com/search?q=${q}) — 编程实战问答`,
      `- [GitHub](https://github.com/search?q=${q}&type=repositories) — 参考实现`,
      `- [GeeksforGeeks](https://www.geeksforgeeks.org/search/?q=${q}) — 算法解题参考`,
      `- [LeetCode 讨论](https://leetcode.com/search/?q=${q}) — 算法题解（如适用）`,
      `- [CSDN](https://so.csdn.net/so/search?q=${q}) — 中文实践参考`,
      `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文讨论`,
    ];
  }
  if (domain === 'math' || domain === 'science') {
    return [
      `- [Wolfram Alpha](https://www.wolframalpha.com/input?i=${q}) — 在线求解与验证`,
      `- [Math Stack Exchange](https://math.stackexchange.com/search?q=${q}) — 数理问答`,
      `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文讨论`,
    ];
  }
  return [
    `- [知乎](https://www.zhihu.com/search?q=${q}) — 中文讨论`,
    `- [Reddit](https://www.reddit.com/search/?q=${q}) — 英文社区讨论`,
  ];
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build the "延伸阅读" markdown block to append to generated files.
 * Returns empty string for 'notes' and 'answer' folders.
 */
export function buildExtendedReading(
  nodeName: string,
  folderName: GenerateFolder,
  domain: Domain,
): string {
  if (folderName === 'notes' || folderName === 'answer') return '';

  const q = encodeURIComponent(nodeName);

  if (folderName === 'practice') {
    return [
      '',
      '---',
      '',
      '## 延伸阅读',
      '',
      '> 以下为搜索直链，供查阅参考实现与解题思路，非精确推荐。',
      '',
      '### 🎥 参考演示',
      `- [YouTube 演示](https://www.youtube.com/results?search_query=${encodeURIComponent(nodeName + ' tutorial')}) — 英文实操视频`,
      `- [bilibili 演示](https://search.bilibili.com/all?keyword=${encodeURIComponent(nodeName + ' 练习')}) — 中文实践视频`,
      '',
      '### 💬 社区参考',
      ...practiceCommunityLinks(domain, q),
      '',
    ].join('\n');
  }

  // theory
  return [
    '',
    '---',
    '',
    '## 延伸阅读',
    '',
    '> 以下为搜索直链，非精确推荐，供自行甄别参考。',
    '',
    '### 📚 参考教材',
    ...textbookLinks(q),
    '',
    '### 🎥 辅助理解',
    `- [YouTube 教程](https://www.youtube.com/results?search_query=${encodeURIComponent(nodeName + ' tutorial')}) — 英文讲解视频`,
    `- [bilibili 教程](https://search.bilibili.com/all?keyword=${encodeURIComponent(nodeName + ' 教程')}) — 中文讲解视频`,
    '',
    '### 💬 社区与文档',
    ...communityLinks(domain, q),
    '',
  ].join('\n');
}
