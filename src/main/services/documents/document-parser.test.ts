import { describe, expect, it } from 'vitest';
import { documentAssetToText, parseDocumentFile } from './document-parser';

async function createOfficeBuffer(files: Record<string, string>): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return await zip.generateAsync({ type: 'nodebuffer' });
}

describe('document parser base', () => {
  it('parses plain text into a stable document asset structure', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'notes.txt',
      mimeType: 'text/plain',
      text: 'First paragraph.\n\nSecond paragraph.',
    });

    expect(asset.kind).toBe('text');
    expect(asset.processingState).toBe('ready');
    expect(asset.units).toHaveLength(1);
    expect(asset.units[0].blocks).toHaveLength(2);
    expect(asset.metadata?.totalChars).toBeGreaterThan(0);
    expect(documentAssetToText(asset)).toContain('[text 1]');
    expect(documentAssetToText(asset)).toContain('Second paragraph.');
  });

  it('marks empty image-like inputs as OCR pending placeholders', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'scan.png',
      mimeType: 'image/png',
      buffer: Buffer.from([]),
    });

    expect(asset.kind).toBe('image');
    expect(asset.units[0].kind).toBe('image');
    expect(asset.units[0].ocrState).toBe('pending');
  });

  it('parses markdown into typed blocks with heading context', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'guide.md',
      mimeType: 'text/markdown',
      text: [
        '# Intro',
        '',
        'Start here.',
        '',
        '- First',
        '- Second',
        '',
        '| Topic | Value |',
        '| --- | --- |',
        '| A | B |',
      ].join('\n'),
    });

    const blocks = asset.units[0].blocks;
    expect(asset.kind).toBe('markdown');
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'list', 'table']);
    expect(blocks[1].headingPath).toEqual(['Intro']);
    expect(documentAssetToText(asset)).toContain('| Topic | Value |');
  });

  it('parses html into readable typed blocks', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'page.html',
      mimeType: 'text/html',
      text: '<main><h1>Chapter &amp; Topic</h1><p>Hello <strong>world</strong>.</p><ul><li>One</li></ul></main>',
    });

    const blocks = asset.units[0].blocks;
    expect(asset.kind).toBe('html');
    expect(asset.units[0].kind).toBe('webpage');
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'list']);
    expect(blocks[0].text).toBe('Chapter & Topic');
    expect(blocks[1].headingPath).toEqual(['Chapter & Topic']);
  });

  it('extracts PPTX slides into slide units', async () => {
    const buffer = await createOfficeBuffer({
      'ppt/slides/slide1.xml': [
        '<p:sld xmlns:p="p" xmlns:a="a">',
        '<p:cSld><p:spTree><p:sp><p:txBody>',
        '<a:p><a:r><a:t>Learning Plan</a:t></a:r></a:p>',
        '<a:p><a:r><a:t>Understand the basics first.</a:t></a:r></a:p>',
        '</p:txBody></p:sp></p:spTree></p:cSld>',
        '</p:sld>',
      ].join(''),
      'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>',
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer,
    });

    expect(asset.kind).toBe('pptx');
    expect(asset.units).toHaveLength(1);
    expect(asset.units[0].kind).toBe('slide');
    expect(asset.units[0].title).toBe('Learning Plan');
    expect(documentAssetToText(asset)).toContain('Understand the basics first.');
    expect(documentAssetToText(asset)).toContain('Speaker note');
  });

  it('extracts XLSX sheets into sheet units', async () => {
    const buffer = await createOfficeBuffer({
      'xl/workbook.xml': [
        '<workbook xmlns:r="r"><sheets>',
        '<sheet name="Plan" sheetId="1" r:id="rId1"/>',
        '</sheets></workbook>',
      ].join(''),
      'xl/_rels/workbook.xml.rels': [
        '<Relationships>',
        '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>',
        '</Relationships>',
      ].join(''),
      'xl/sharedStrings.xml': [
        '<sst>',
        '<si><t>Topic</t></si>',
        '<si><t>Math</t></si>',
        '<si><t>Hours</t></si>',
        '</sst>',
      ].join(''),
      'xl/worksheets/sheet1.xml': [
        '<worksheet><sheetData>',
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>12</v></c><c r="C2"><f>B2*2</f><v>24</v></c></row>',
        '</sheetData></worksheet>',
      ].join(''),
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'sheet.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    });

    expect(asset.kind).toBe('xlsx');
    expect(asset.units).toHaveLength(1);
    expect(asset.units[0].kind).toBe('sheet');
    expect(asset.units[0].title).toBe('Plan');
    expect(documentAssetToText(asset)).toContain('| 行 | A | B | C |');
    expect(documentAssetToText(asset)).toContain('Math');
    expect(documentAssetToText(asset)).toContain('24 (= B2*2)');
    expect(asset.units[0].blocks[0].metadata?.table).toMatchObject({
      version: 1,
      sourceFormat: 'xlsx',
      headers: ['A', 'B', 'C'],
      rowCount: 2,
      columnCount: 3,
      cells: expect.arrayContaining([
        expect.objectContaining({
          rowNumber: 2,
          columnName: 'C',
          address: 'C2',
          text: '24 (= B2*2)',
          valueType: 'formula',
        }),
      ]),
    });
  });

  it('parses CSV as structured sheet rows with quoted cells', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'scores.csv',
      mimeType: 'text/csv',
      text: [
        '姓名,备注,分数',
        '张三,"喜欢 A,B,C",90',
        '李四,"这一格里',
        '有换行",85',
      ].join('\n'),
    });

    expect(asset.kind).toBe('csv');
    expect(asset.units).toHaveLength(1);
    expect(asset.units[0].kind).toBe('sheet');
    expect(asset.units[0].metadata).toMatchObject({
      delimiter: 'comma',
      hasHeader: true,
      rowCount: 3,
      dataRowCount: 2,
      columnCount: 3,
    });
    expect(documentAssetToText(asset)).toContain('| 行 | 姓名 | 备注 | 分数 |');
    expect(documentAssetToText(asset)).toContain('喜欢 A,B,C');
    expect(documentAssetToText(asset)).toContain('这一格里<br>有换行');
    expect(asset.units[0].blocks[0].metadata?.table).toMatchObject({
      version: 1,
      sourceFormat: 'csv',
      delimiter: 'comma',
      hasHeader: true,
      headers: ['姓名', '备注', '分数'],
      rowCount: 2,
      columnCount: 3,
      startRow: 2,
      endRow: 3,
      cells: expect.arrayContaining([
        expect.objectContaining({
          rowNumber: 2,
          columnIndex: 1,
          header: '备注',
          text: '喜欢 A,B,C',
          valueType: 'text',
        }),
        expect.objectContaining({
          rowNumber: 3,
          columnIndex: 2,
          header: '分数',
          text: '85',
          valueType: 'number',
        }),
      ]),
    });
  });

  it('parses TSV as structured sheet rows', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'plan.tsv',
      mimeType: 'text/tab-separated-values',
      text: [
        'Topic\tHours',
        'Math\t12',
        'Physics\t8',
      ].join('\n'),
    });

    expect(asset.kind).toBe('tsv');
    expect(asset.units[0].kind).toBe('sheet');
    expect(asset.units[0].metadata).toMatchObject({
      delimiter: 'tab',
      hasHeader: true,
      rowCount: 3,
      dataRowCount: 2,
      columnCount: 2,
    });
    expect(documentAssetToText(asset)).toContain('| 行 | Topic | Hours |');
    expect(documentAssetToText(asset)).toContain('| 2 | Math | 12 |');
    expect(asset.units[0].blocks[0].metadata?.table).toMatchObject({
      sourceFormat: 'tsv',
      delimiter: 'tab',
      headers: ['Topic', 'Hours'],
      cells: expect.arrayContaining([
        expect.objectContaining({
          rowNumber: 2,
          header: 'Hours',
          text: '12',
          valueType: 'number',
        }),
      ]),
    });
  });

  it('extracts RTF text with a local fallback parser', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'note.rtf',
      mimeType: 'application/rtf',
      text: String.raw`{\rtf1\ansi\b Important\par Plain text}`,
    });

    expect(asset.kind).toBe('rtf');
    expect(asset.units[0].kind).toBe('section');
    expect(documentAssetToText(asset)).toContain('Important');
    expect(documentAssetToText(asset)).toContain('Plain text');
  });

  it('extracts EPUB spine chapters into section units', async () => {
    const buffer = await createOfficeBuffer({
      'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>',
      'OPS/content.opf': [
        '<package><metadata><dc:title>Book Title</dc:title></metadata>',
        '<manifest><item id="chap1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest>',
        '<spine><itemref idref="chap1"/></spine></package>',
      ].join(''),
      'OPS/chap1.xhtml': '<html><body><h1>Chapter One</h1><p>EPUB paragraph.</p></body></html>',
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'book.epub',
      mimeType: 'application/epub+zip',
      buffer,
    });

    expect(asset.kind).toBe('epub');
    expect(asset.units).toHaveLength(1);
    expect(asset.units[0].kind).toBe('section');
    expect(asset.units[0].title).toBe('Chapter One');
    expect(documentAssetToText(asset)).toContain('EPUB paragraph.');
  });

  it('extracts ODT text into a section unit', async () => {
    const buffer = await createOfficeBuffer({
      'content.xml': [
        '<office:document-content xmlns:office="office" xmlns:text="text">',
        '<office:body><office:text>',
        '<text:h text:outline-level="1">ODT Heading</text:h>',
        '<text:p>ODT paragraph.</text:p>',
        '</office:text></office:body></office:document-content>',
      ].join(''),
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'doc.odt',
      mimeType: 'application/vnd.oasis.opendocument.text',
      buffer,
    });

    expect(asset.kind).toBe('odt');
    expect(asset.units[0].kind).toBe('section');
    expect(asset.units[0].title).toBe('ODT Heading');
    expect(documentAssetToText(asset)).toContain('ODT paragraph.');
  });

  it('extracts ODS tables into sheet units', async () => {
    const buffer = await createOfficeBuffer({
      'content.xml': [
        '<office:document-content xmlns:office="office" xmlns:table="table" xmlns:text="text">',
        '<office:body><office:spreadsheet>',
        '<table:table table:name="Data">',
        '<table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Score</text:p></table:table-cell></table:table-row>',
        '<table:table-row><table:table-cell><text:p>Ada</text:p></table:table-cell><table:table-cell office:value="98"><text:p>98</text:p></table:table-cell></table:table-row>',
        '</table:table>',
        '</office:spreadsheet></office:body></office:document-content>',
      ].join(''),
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'table.ods',
      mimeType: 'application/vnd.oasis.opendocument.spreadsheet',
      buffer,
    });

    expect(asset.kind).toBe('ods');
    expect(asset.units[0].kind).toBe('sheet');
    expect(asset.units[0].title).toBe('Data');
    expect(documentAssetToText(asset)).toContain('| 行 | A | B |');
    expect(documentAssetToText(asset)).toContain('Ada');
    expect(asset.units[0].blocks[0].metadata?.table).toMatchObject({
      sourceFormat: 'ods',
      headers: ['A', 'B'],
      rowCount: 2,
      columnCount: 2,
      cells: expect.arrayContaining([
        expect.objectContaining({
          rowNumber: 2,
          columnName: 'B',
          address: 'B2',
          text: '98',
          valueType: 'number',
        }),
      ]),
    });
  });

  it('extracts ODP slides into slide units', async () => {
    const buffer = await createOfficeBuffer({
      'content.xml': [
        '<office:document-content xmlns:office="office" xmlns:draw="draw" xmlns:text="text">',
        '<office:body><office:presentation>',
        '<draw:page draw:name="Slide 1">',
        '<text:h>ODP Title</text:h>',
        '<text:p>ODP body.</text:p>',
        '</draw:page>',
        '</office:presentation></office:body></office:document-content>',
      ].join(''),
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'slides.odp',
      mimeType: 'application/vnd.oasis.opendocument.presentation',
      buffer,
    });

    expect(asset.kind).toBe('odp');
    expect(asset.units[0].kind).toBe('slide');
    expect(asset.units[0].title).toBe('ODP Title');
    expect(documentAssetToText(asset)).toContain('ODP body.');
  });

  it('extracts OPML outlines into a nested mind map section', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'outline.opml',
      mimeType: 'text/x-opml',
      text: [
        '<?xml version="1.0"?>',
        '<opml version="2.0">',
        '<head><title>Study Outline</title></head>',
        '<body>',
        '<outline text="Root"><outline text="Child" _note="Remember this" url="https://example.com"/></outline>',
        '</body>',
        '</opml>',
      ].join(''),
    });

    expect(asset.kind).toBe('opml');
    expect(asset.units[0].kind).toBe('section');
    expect(asset.units[0].title).toBe('Study Outline');
    expect(documentAssetToText(asset)).toContain('- Root');
    expect(documentAssetToText(asset)).toContain('Child');
    expect(documentAssetToText(asset)).toContain('Remember this');
    expect(documentAssetToText(asset)).toContain('https://example.com');
  });

  it('extracts FreeMind MM nodes into a nested mind map section', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'map.mm',
      mimeType: 'application/x-freemind',
      text: [
        '<map version="1.0.1">',
        '<node TEXT="Main">',
        '<node TEXT="Branch"><richcontent TYPE="NOTE"><html><body><p>Branch note</p></body></html></richcontent></node>',
        '</node>',
        '</map>',
      ].join(''),
    });

    expect(asset.kind).toBe('mm');
    expect(asset.units[0].kind).toBe('section');
    expect(asset.units[0].title).toBe('Main');
    expect(documentAssetToText(asset)).toContain('- Main');
    expect(documentAssetToText(asset)).toContain('Branch');
    expect(documentAssetToText(asset)).toContain('Branch note');
  });

  it('extracts XMind content.json sheets into mind map sections', async () => {
    const buffer = await createOfficeBuffer({
      'content.json': JSON.stringify([{
        title: 'Sheet A',
        rootTopic: {
          id: 'root',
          title: 'Central Topic',
          notes: { plain: { content: 'Root note' } },
          children: {
            attached: [{
              id: 'child',
              title: 'Attached Topic',
              labels: ['important'],
              markers: [{ markerId: 'priority-1' }],
            }],
          },
        },
      }]),
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'map.xmind',
      mimeType: 'application/vnd.xmind.workbook',
      buffer,
    });

    expect(asset.kind).toBe('xmind');
    expect(asset.units).toHaveLength(1);
    expect(asset.units[0].title).toBe('Sheet A');
    expect(documentAssetToText(asset)).toContain('Central Topic');
    expect(documentAssetToText(asset)).toContain('Root note');
    expect(documentAssetToText(asset)).toContain('Attached Topic');
    expect(documentAssetToText(asset)).toContain('priority-1');
  });

  it('extracts XMind sheets whose root topic has no title', async () => {
    const buffer = await createOfficeBuffer({
      'content.json': JSON.stringify([{
        title: '思维导图',
        rootTopic: {
          id: 'root',
          class: 'topic',
          structureClass: 'org.xmind.ui.map.clockwise',
          children: {
            detached: [{
              id: 'intro',
              title: '操作系统绪论',
            }],
          },
        },
      }]),
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'untitled-root.xmind',
      mimeType: 'application/vnd.xmind.workbook',
      buffer,
    });

    expect(asset.kind).toBe('xmind');
    expect(asset.processingState).toBe('ready');
    expect(asset.units[0].title).toBe('思维导图');
    expect(documentAssetToText(asset)).toContain('- 思维导图');
    expect(documentAssetToText(asset)).toContain('操作系统绪论');
  });

  it('extracts XMind parser-style content.json sheets with topic/topics', async () => {
    const buffer = await createOfficeBuffer({
      'content.json': JSON.stringify({
        sheets: [{
          title: 'Parser Sheet',
          topic: {
            title: 'Parser Root',
            topics: [{
              title: 'Parser Child',
              note: 'Child note',
            }],
          },
        }],
      }),
    });

    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'parser-map.xmind',
      mimeType: 'application/vnd.xmind.workbook',
      buffer,
    });

    expect(asset.kind).toBe('xmind');
    expect(asset.processingState).toBe('ready');
    expect(asset.units[0].title).toBe('Parser Sheet');
    expect(documentAssetToText(asset)).toContain('Parser Root');
    expect(documentAssetToText(asset)).toContain('Parser Child');
    expect(documentAssetToText(asset)).toContain('Child note');
  });

  it('does not mark empty non-visual document units as OCR pending', async () => {
    const asset = await parseDocumentFile({
      courseId: 'course-1',
      title: 'broken.xmind',
      mimeType: 'application/vnd.xmind.workbook',
      buffer: await createOfficeBuffer({
        'content.json': JSON.stringify({ sheets: [] }),
      }),
    });

    expect(asset.kind).toBe('xmind');
    expect(asset.processingState).toBe('failed');
    expect(asset.units[0].kind).toBe('section');
    expect(asset.units[0].ocrState).toBe('not_required');
  });
});
