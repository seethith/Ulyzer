// Guards the `@xmldom/xmldom` override (pinned to the patched 0.8.13 to clear
// GHSA serialization CVEs) against breaking mammoth's docx parsing — 0.9.x is a
// breaking change that requires a mimeType arg mammoth does not pass.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import mammoth from 'mammoth';

async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.folder('word')!.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t>second line</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('docx parsing (mammoth + @xmldom/xmldom)', () => {
  it('extracts raw text', async () => {
    const result = await mammoth.extractRawText({ buffer: await makeDocx('Hello Ulyzer docx test') });
    expect(result.value).toContain('Hello Ulyzer docx test');
    expect(result.value).toContain('second line');
  });

  it('converts to html', async () => {
    const result = await mammoth.convertToHtml({ buffer: await makeDocx('Para content') });
    expect(result.value).toContain('Para content');
    expect(result.value).toMatch(/<p>/);
  });
});
