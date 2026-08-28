import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { assertSafeXlsxArchive, parseSpreadsheet } from './spreadsheet-preview-parser'

async function workbookArchive(
  relationshipTarget = 'worksheets/sheet1.xml',
  relationshipMode = '',
): Promise<ArrayBuffer> {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', `
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
    </Types>
  `)
  archive.file('xl/workbook.xml', `
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>
        <sheet name="Budget" sheetId="1" r:id="rId1"/>
        <sheet name="Notes" sheetId="2" r:id="rId2"/>
      </sheets>
    </workbook>
  `)
  archive.file('xl/_rels/workbook.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${relationshipTarget}"${relationshipMode}/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
    </Relationships>
  `)
  archive.file('xl/sharedStrings.xml', `
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
      <si><r><t>Annual </t></r><r><t>revenue</t></r></si>
    </sst>
  `)
  archive.file('xl/styles.xml', `
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>
    </styleSheet>
  `)
  archive.file('xl/worksheets/sheet1.xml', `
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <dimension ref="A1:C2"/>
      <sheetData>
        <row r="1">
          <c r="A1" t="s"><v>0</v></c>
          <c r="B1" t="inlineStr"><is><t>Q1</t></is></c>
          <c r="C1" t="b"><v>1</v></c>
        </row>
        <row r="2">
          <c r="A2"><v>42</v></c>
          <c r="B2" s="1"><v>45292</v></c>
          <c r="C2"><f>SUM(A2)</f><v>42</v></c>
        </row>
      </sheetData>
    </worksheet>
  `)
  archive.file('xl/worksheets/sheet2.xml', `
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <dimension ref="A1"/><sheetData/>
    </worksheet>
  `)
  return archive.generateAsync({ type: 'arraybuffer' })
}

async function formattedWorkbookArchive(): Promise<ArrayBuffer> {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  archive.file('xl/workbook.xml', `
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Styled report" sheetId="1" r:id="rId1"/></sheets>
    </workbook>
  `)
  archive.file('xl/_rels/workbook.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>
  `)
  archive.file('xl/styles.xml', `
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
      <fonts count="2">
        <font><name val="Calibri"/><sz val="11"/></font>
        <font><name val="Arial"/><sz val="16"/><b/><color rgb="FFFFFFFF"/></font>
      </fonts>
      <fills count="3">
        <fill><patternFill patternType="none"/></fill>
        <fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/></patternFill></fill>
      </fills>
      <borders count="2">
        <border><left/><right/><top/><bottom/></border>
        <border><left/><right/><top/><bottom style="medium"><color rgb="FF4F81BD"/></bottom></border>
      </borders>
      <cellXfs count="4">
        <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
        <xf numFmtId="0" fontId="1" fillId="2" borderId="1">
          <alignment horizontal="center" vertical="center" wrapText="1"/>
        </xf>
        <xf numFmtId="164" fontId="0" fillId="0" borderId="0">
          <alignment horizontal="right"/>
        </xf>
        <xf numFmtId="10" fontId="0" fillId="0" borderId="0"/>
      </cellXfs>
    </styleSheet>
  `)
  archive.file('xl/worksheets/sheet1.xml', `
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <dimension ref="A1:C2"/>
      <cols>
        <col min="1" max="1" width="24" customWidth="1"/>
        <col min="2" max="3" width="12" customWidth="1"/>
      </cols>
      <sheetData>
        <row r="1" ht="30" customHeight="1">
          <c r="A1" s="1" t="inlineStr"><is><t>Quarterly Plan</t></is></c>
        </row>
        <row r="2">
          <c r="A2" t="inlineStr"><is><t>Hosting</t></is></c>
          <c r="B2" s="2"><v>1234.5</v></c>
          <c r="C2" s="3"><v>0.125</v></c>
        </row>
      </sheetData>
      <mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
    </worksheet>
  `)
  return archive.generateAsync({ type: 'arraybuffer' })
}

interface ArchiveEntry {
  name: string
  uncompressedSize: number
}

function centralDirectoryArchive(entries: ArchiveEntry[]): ArrayBuffer {
  const encoder = new TextEncoder()
  const names = entries.map((entry) => encoder.encode(entry.name))
  const centralDirectorySize = names.reduce((total, name) => total + 46 + name.length, 0)
  const bytes = new Uint8Array(centralDirectorySize + 22)
  const view = new DataView(bytes.buffer)
  let offset = 0

  entries.forEach((entry, index) => {
    const name = names[index]
    view.setUint32(offset, 0x02014b50, true)
    view.setUint16(offset + 10, 8, true)
    view.setUint32(offset + 24, entry.uncompressedSize, true)
    view.setUint16(offset + 28, name.length, true)
    bytes.set(name, offset + 46)
    offset += 46 + name.length
  })

  view.setUint32(offset, 0x06054b50, true)
  view.setUint16(offset + 8, entries.length, true)
  view.setUint16(offset + 10, entries.length, true)
  view.setUint32(offset + 12, centralDirectorySize, true)
  view.setUint32(offset + 16, 0, true)
  return bytes.buffer
}

describe('spreadsheet preview parser', () => {
  it('extracts cached cell values, rich strings, dates, and multiple worksheets', async () => {
    const workbook = await parseSpreadsheet(await workbookArchive())

    expect(workbook).toEqual({
      sheets: [
        {
          name: 'Budget',
          rows: [
            [
              { value: 'Annual revenue', style: 0 },
              { value: 'Q1', style: 0 },
              { value: 'TRUE', style: 0 },
            ],
            [
              { value: '42', style: 0 },
              { value: '2024-01-01', style: 1 },
              { value: '42', style: 0 },
            ],
          ],
          rowCount: 2,
          columnCount: 3,
          columnWidths: [112, 112, 112],
          rowHeights: [0, 0],
          columnStyles: [-1, -1, -1],
          rowStyles: [-1, -1],
          merges: [],
          truncated: false,
        },
        {
          name: 'Notes',
          rows: [],
          rowCount: 1,
          columnCount: 1,
          columnWidths: [112],
          rowHeights: [],
          columnStyles: [-1],
          rowStyles: [],
          merges: [],
          truncated: false,
        },
      ],
      styles: [{}, {}],
      truncated: false,
    })
  })

  it('preserves common Excel layout, merged cells, formatting, and number formats', async () => {
    const workbook = await parseSpreadsheet(await formattedWorkbookArchive())
    const sheet = workbook.sheets[0]

    expect(sheet.columnWidths).toEqual([173, 89, 89])
    expect(sheet.rowHeights).toEqual([40, 0])
    expect(sheet.merges).toEqual([{
      startRow: 1,
      startColumn: 1,
      endRow: 1,
      endColumn: 3,
    }])
    expect(sheet.rows[0][0]).toEqual({ value: 'Quarterly Plan', style: 1 })
    expect(sheet.rows[1]).toEqual([
      { value: 'Hosting', style: 0 },
      { value: '$1,234.50', style: 2 },
      { value: '12.50%', style: 3 },
    ])
    expect(workbook.styles[1]).toEqual({
      backgroundColor: '#1F4E78',
      borderBottom: { color: '#4F81BD', style: 'solid', width: 2 },
      color: '#FFFFFF',
      fontFamily: 'Arial',
      fontSize: 16,
      fontWeight: 700,
      textAlign: 'center',
      verticalAlign: 'middle',
      whiteSpace: 'normal',
    })
  })

  it('rejects worksheet relationships that escape the workbook package', async () => {
    await expect(parseSpreadsheet(await workbookArchive('../../outside.xml')))
      .rejects.toThrow('XLSX relationship escapes the workbook')
  })

  it('rejects externally hosted worksheets without fetching them', async () => {
    await expect(parseSpreadsheet(await workbookArchive('https://example.com/sheet.xml', ' TargetMode="External"')))
      .rejects.toThrow('External XLSX worksheet relationships are not supported')
  })

  it('rejects archives whose declared expansion exceeds the memory ceiling', () => {
    const archive = centralDirectoryArchive([
      { name: '[Content_Types].xml', uncompressedSize: 1_000 },
      { name: 'xl/workbook.xml', uncompressedSize: 40 * 1024 * 1024 },
      { name: 'xl/_rels/workbook.xml.rels', uncompressedSize: 40 * 1024 * 1024 },
    ])

    expect(() => assertSafeXlsxArchive(archive)).toThrow('XLSX entry is not safe to preview')
  })
})
