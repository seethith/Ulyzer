import { fail, pass, type VerificationResult } from './types';

interface KcEntry {
  id: string;
  name: string;
}

function parseKcs(outlineText: string): KcEntry[] {
  const entries: KcEntry[] = [];
  const re = /^###\s+(KC\d+):\s*(.+)$/mg;
  let match: RegExpExecArray | null;
  while ((match = re.exec(outlineText)) !== null) {
    entries.push({ id: match[1], name: match[2].trim() });
  }
  return entries;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

export function verifyKcCoverage(
  outlineText: string,
  content: string,
  minCoverageRatio = 0.8,
): VerificationResult {
  const kcs = parseKcs(outlineText);
  if (kcs.length === 0) {
    return pass('kcCoverage', [{
      code: 'kc.no_kc_outline',
      severity: 'warning',
      message: 'No KC markers were found in the outline; KC coverage check skipped.',
    }]);
  }

  const normalizedContent = normalizeText(content);
  const covered = kcs.filter((kc) =>
    normalizedContent.includes(kc.id.toLowerCase()) ||
    normalizedContent.includes(normalizeText(kc.name)),
  );
  const ratio = covered.length / kcs.length;

  if (ratio < minCoverageRatio) {
    return fail('kcCoverage', [{
      code: 'kc.coverage_low',
      severity: 'error',
      message: `KC coverage is too low: ${covered.length}/${kcs.length}.`,
      details: {
        coveredKcIds: covered.map((kc) => kc.id),
        uncoveredKcIds: kcs.filter((kc) => !covered.includes(kc)).map((kc) => kc.id),
        ratio,
      },
    }]);
  }

  return pass('kcCoverage');
}
