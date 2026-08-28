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
            ['Annual revenue', 'Q1', 'TRUE'],
            ['42', '2024-01-01', '42'],
          ],
          rowCount: 2,
          columnCount: 3,
          truncated: false,
        },
        {
          name: 'Notes',
          rows: [],
          rowCount: 1,
          columnCount: 1,
          truncated: false,
        },
      ],
      truncated: false,
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
