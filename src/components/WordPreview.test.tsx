import { render, screen, waitFor } from '@testing-library/react'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WordPreviewWorkerResponse } from '../lib/word-preview'
import { WordPreview } from './WordPreview'

let workerResponse: WordPreviewWorkerResponse

class PreviewWorker {
  onmessage: ((event: MessageEvent<WordPreviewWorkerResponse>) => void) | null = null
  onerror: (() => void) | null = null

  postMessage() {
    queueMicrotask(() => {
      this.onmessage?.(new MessageEvent('message', { data: workerResponse }))
    })
  }

  terminate() {}
}

async function formattedDocument(): Promise<Blob> {
  const archive = new JSZip()
  archive.file('[Content_Types].xml', `
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>
  `)
  archive.file('_rels/.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>
  `)
  archive.file('word/_rels/document.xml.rels', `
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="unsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert('no')" TargetMode="External"/>
    </Relationships>
  `)
  archive.file('word/document.xml', `
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <w:body>
        <w:p>
          <w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
          <w:r>
            <w:rPr><w:b/><w:i/><w:color w:val="C00000"/><w:sz w:val="36"/></w:rPr>
            <w:t>Formatted title</w:t>
          </w:r>
        </w:p>
        <w:p>
          <w:hyperlink r:id="unsafe"><w:r><w:t>Unsafe link</w:t></w:r></w:hyperlink>
        </w:p>
        <w:tbl>
          <w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr>
          <w:tr><w:tc><w:tcPr><w:shd w:fill="FFF2CC"/></w:tcPr><w:p><w:r><w:t>Styled cell</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
        <w:sectPr>
          <w:pgSz w:w="12240" w:h="15840"/>
          <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
        </w:sectPr>
      </w:body>
    </w:document>
  `)
  return archive.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

beforeEach(() => {
  vi.stubGlobal('Worker', PreviewWorker)
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
})

describe('WordPreview', () => {
  it('preserves Word page and run formatting while neutralizing active links', async () => {
    workerResponse = { type: 'ready' }
    const data = await formattedDocument()

    const { container } = render(<WordPreview data={data} name="proposal.docx" />)
    const surface = container.querySelector<HTMLElement>('.word-document-surface')
    expect(surface).not.toBeNull()

    await waitFor(() => {
      expect(surface?.shadowRoot?.querySelector('.word-docx-wrapper')).not.toBeNull()
    })

    const shadowRoot = surface?.shadowRoot
    const title = [...(shadowRoot?.querySelectorAll('span') ?? [])]
      .find((element) => element.textContent === 'Formatted title')
    const paragraph = title?.closest('p')
    const styledCell = [...(shadowRoot?.querySelectorAll('td') ?? [])]
      .find((element) => element.textContent?.includes('Styled cell'))
    const unsafeLink = [...(shadowRoot?.querySelectorAll('a') ?? [])]
      .find((element) => element.textContent === 'Unsafe link')

    expect(title).toHaveStyle({
      color: '#C00000',
      fontSize: '18pt',
      fontStyle: 'italic',
      fontWeight: 'bold',
    })
    expect(paragraph).toHaveStyle({ textAlign: 'center' })
    expect(styledCell).toHaveStyle({ backgroundColor: '#FFF2CC' })
    expect(shadowRoot?.querySelector('section.word-docx')).not.toBeNull()
    expect(unsafeLink).not.toHaveAttribute('href')
    expect(shadowRoot?.querySelector('iframe, object, embed, script')).toBeNull()
  })

  it('scales a full Word page to the available phone viewport', async () => {
    workerResponse = { type: 'ready' }
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 640px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('word-document-surface') ? 360 : 0
      })
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('word-document-surface') ? 520 : 0
      })
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.matches('section.word-docx') ? 794 : 0
      })
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.matches('section.word-docx') ? 1_123 : 0
      })

    try {
      const data = await formattedDocument()
      const { container } = render(<WordPreview data={data} name="mobile.docx" />)
      const surface = container.querySelector<HTMLElement>('.word-document-surface')

      await waitFor(() => expect(surface).toHaveAttribute('data-page-fit-scale', '0.4383'))
      expect(
        surface?.shadowRoot?.querySelector<HTMLElement>('.word-docx-wrapper'),
      ).toHaveStyle({ zoom: '0.43828715365239296' })
    } finally {
      clientWidth.mockRestore()
      clientHeight.mockRestore()
      offsetWidth.mockRestore()
      offsetHeight.mockRestore()
    }
  })

  it('shows a fail-safe state when the local DOCX validator rejects a document', async () => {
    workerResponse = { type: 'error' }

    render(<WordPreview data={new Blob(['not a docx'])} name="broken.docx" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Word preview unavailable')
    expect(screen.getByText('The document is unsupported, damaged, or exceeds safe preview limits.')).toBeInTheDocument()
  })
})
