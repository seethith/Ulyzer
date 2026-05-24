import { fail, pass, type VerificationResult } from './types';

const CITATION_RE =
  /(?:来源(?:策略)?[:：]\s*(?:来源改编|题型参考|AI\s*原创|https?:\/\/|\[|【)|Source(?:\s+Strategy)?[:：]\s*(?:Adapted|Pattern\s+Reference|AI\s*Original|https?:\/\/|\[|【)|\[AI\s*原创\]|\[AI Original\])/i;

export function verifySourceCitation(content: string): VerificationResult {
  if (!content.trim()) {
    return fail('sourceCitation', [{
      code: 'citation.empty_content',
      severity: 'error',
      message: 'Content is empty.',
    }]);
  }

  if (!CITATION_RE.test(content)) {
    return fail('sourceCitation', [{
      code: 'citation.missing_source_marker',
      severity: 'error',
      message: 'Practice content must include source markers such as 来源, Source, [AI原创], or [AI Original].',
    }]);
  }

  return pass('sourceCitation');
}
