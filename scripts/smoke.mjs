import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import JSZip from 'jszip'

let stage = 'configuration'
let browser

async function step(name, operation) {
  stage = name
  await operation()
  console.log(`PASS ${name}`)
}

async function share(page, text) {
  await page.getByRole('textbox', { name: 'Shared text', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Share', exact: true }).click()
}

async function selectItem(page, text) {
  const item = page.locator('.resource-item').filter({ hasText: text })
  await item.waitFor()
  await item.locator('.resource-select').click()
  return item
}

async function join(page, invitation, origin) {
  await page.goto(origin)
  await page.getByRole('textbox', { name: 'Room ID or invitation link' }).fill(invitation)
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  await page.getByText('Connected', { exact: true }).waitFor()
}

async function fixtures() {
  const word = new JSZip()
  word.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  word.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  word.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Word preview</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>')
  const sheet = new JSZip()
  sheet.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')
  sheet.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/></sheets></workbook>')
  sheet.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
  sheet.file('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Synthetic spreadsheet preview</t></is></c></row></sheetData></worksheet>')
  const content = 'BT /F1 18 Tf 40 140 Td (Synthetic PDF preview) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return [
    { name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') },
    { name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) },
    { name: 'synthetic.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await word.generateAsync({ type: 'nodebuffer' }) },
    { name: 'synthetic.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await sheet.generateAsync({ type: 'nodebuffer' }) },
  ]
}

try {
  const base = new URL(process.env.SECRETGRAM_BASE_URL ?? '')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  assert(base.protocol === 'https:' || (loopback && base.protocol === 'http:'))
  assert(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/')
  const origin = base.origin
  await step('health and security headers', async () => {
    const health = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { data: { status: 'ok', version: 1 } })
    assert.equal(health.headers.get('cache-control'), 'no-store')
    assert(health.headers.get('x-request-id'))
    if (!loopback) {
      const home = await fetch(origin, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
      assert.equal(home.status, 200)
      assert.equal(home.headers.get('cache-control'), 'no-store')
      for (const [name, value] of [['referrer-policy', 'no-referrer'], ['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY']]) assert.equal(home.headers.get(name), value)
      assert(home.headers.get('strict-transport-security')?.includes('max-age='))
      assert(home.headers.get('content-security-policy')?.includes("default-src 'self'"))
      const html = await home.text()
      const asset = html.match(/src="(\/assets\/[^"\s]+\.js)"/u)?.[1]
      assert(asset)
      const response = await fetch(`${origin}${asset}`, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
      assert.equal(response.status, 200)
      assert(response.headers.get('cache-control')?.includes('immutable'))
      await response.body?.cancel()
    }
  })
  if (!process.argv.includes('--health')) {
    stage = 'browser startup'
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH })
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 1440, height: 1000 } }), browser.newContext({ viewport: { width: 1440, height: 1000 } })])
    let unexpectedExternalRequest = false
    for (const context of contexts) {
      context.setDefaultTimeout(45_000)
      context.on('request', request => {
        const url = new URL(request.url())
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) unexpectedExternalRequest = true
      })
      await context.addInitScript(() => {
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.syntheticInvitation = value } } })
      })
    }
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
    let locator
    let expiresAt
    let authorization
    let chunkPath
    let invitation
    let receivedFrames = 0
    b.on('websocket', socket => socket.on('framereceived', () => { receivedFrames += 1 }))
    a.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'GET' && /^\/api\/v1\/rooms\/[A-Za-z0-9_-]{43}$/u.test(path)) authorization = request.headers().authorization
      if (request.method() === 'PUT' && /\/chunks\/0$/u.test(path)) chunkPath = path
    })
    // The public API supports five-minute rooms; shorten only this synthetic creation.
    await a.route(`${origin}/api/v1/rooms`, async route => {
      const request = route.request()
      if (request.method() !== 'POST') return route.continue()
      const body = request.postDataJSON()
      locator = body.locator
      await route.continue({ postData: JSON.stringify({ ...body, ttlSeconds: 300 }) })
    })
    await step('create short-lived room and join independent peer', async () => {
      await a.goto(origin)
      await a.getByRole('tab', { name: 'Create room', exact: true }).click()
      await a.getByLabel('Room lifetime').selectOption('86400')
      const created = a.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/rooms' && response.request().method() === 'POST')
      await a.locator('#create-room-panel button[type="submit"]').click()
      const result = await (await created).json()
      expiresAt = result.data.expiresAt
      assert(Number.isSafeInteger(expiresAt) && expiresAt > Date.now() && expiresAt < Date.now() + 310_000)
      assert(/^[A-Za-z0-9_-]{43}$/u.test(locator))
      if (process.env.SECRETGRAM_SMOKE_RECORD) {
        await mkdir(dirname(process.env.SECRETGRAM_SMOKE_RECORD), { recursive: true })
        await writeFile(process.env.SECRETGRAM_SMOKE_RECORD, JSON.stringify({ origin, locator, expiresAt }) + '\n', { mode: 0o600 })
      }
      await a.getByText('Connected', { exact: true }).waitFor()
      await a.getByRole('button', { name: 'Invite', exact: true }).click()
      await a.getByRole('button', { name: 'Copy invitation link', exact: true }).click()
      invitation = await a.evaluate(() => window.syntheticInvitation)
      assert(new URL(invitation).hash)
      await a.keyboard.press('Escape')
      await join(b, invitation, origin)
    })
    await step('bidirectional encrypted live messages', async () => {
      await share(a, 'Synthetic message from browser A')
      await selectItem(b, 'Synthetic message from browser A')
      await b.locator('.shared-text-detail pre').filter({ hasText: 'Synthetic message from browser A' }).waitFor()
      await share(b, 'Synthetic reply from browser B')
      await selectItem(a, 'Synthetic reply from browser B')
      await a.locator('.shared-text-detail pre').filter({ hasText: 'Synthetic reply from browser B' }).waitFor()
      assert(receivedFrames >= 2)
    })
    await step('pin replacement and reconnect history', async () => {
      await selectItem(a, 'Synthetic message from browser A')
      await a.getByRole('button', { name: 'Pin selected item', exact: true }).click()
      await b.locator('.resource-item.pinned').filter({ hasText: 'Synthetic message from browser A' }).waitFor()
      await selectItem(b, 'Synthetic reply from browser B')
      await b.getByRole('button', { name: 'Pin selected item', exact: true }).click()
      await a.locator('.resource-item.pinned').filter({ hasText: 'Synthetic reply from browser B' }).waitFor()
      await b.reload()
      await join(b, invitation, origin)
      await b.locator('.resource-item.pinned').filter({ hasText: 'Synthetic reply from browser B' }).waitFor()
      await selectItem(b, 'Synthetic message from browser A')
      await selectItem(b, 'Synthetic reply from browser B')
      await b.getByRole('button', { name: 'Unpin selected item', exact: true }).click()
      await a.locator('.resource-item.pinned').waitFor({ state: 'detached' })
    })
    const binary = Buffer.alloc(4 * 1024 * 1024 + 73)
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251
    await step('two-chunk encrypted upload and verified fallback download', async () => {
      await a.getByLabel('Choose files').setInputFiles({ name: 'synthetic.bin', mimeType: 'application/octet-stream', buffer: binary })
      await a.getByRole('button', { name: 'Share files', exact: true }).click()
      await selectItem(b, 'synthetic.bin')
      const downloaded = b.waitForEvent('download')
      await b.getByRole('button', { name: 'Download', exact: true }).click()
      const download = await downloaded
      const stream = await download.createReadStream()
      assert(stream)
      const parts = []
      for await (const part of stream) parts.push(part)
      assert(Buffer.concat(parts).equals(binary))
      await download.delete()
    })
    if (!process.argv.includes('--baseline')) {
      await step('native writable streaming and committed file integrity', async () => {
        // A real browser-local file handle replaces only the unattended OS picker.
        await b.evaluate(() => {
          window.showSaveFilePicker = async () => {
            const directory = await navigator.storage.getDirectory()
            return directory.getFileHandle('synthetic-output', { create: true })
          }
        })
        await b.getByRole('button', { name: 'Download', exact: true }).click()
        await b.getByRole('status').filter({ hasText: 'File saved.' }).waitFor()
        const digest = await b.evaluate(async () => {
          const directory = await navigator.storage.getDirectory()
          const file = await (await directory.getFileHandle('synthetic-output')).getFile()
          const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
          await directory.removeEntry('synthetic-output')
          return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
        })
        assert.equal(digest, createHash('sha256').update(binary).digest('hex'))
      })
      await step('canceling a native save preserves the existing destination', async () => {
        await b.evaluate(async () => {
          const directory = await navigator.storage.getDirectory()
          const handle = await directory.getFileHandle('synthetic-output', { create: true })
          const writable = await handle.createWritable()
          await writable.write('Original local file')
          await writable.close()
        })
        const blockedChunk = Promise.withResolvers()
        await b.route(`${origin}${chunkPath}`, route => { blockedChunk.resolve(route) })
        await b.getByRole('button', { name: 'Download', exact: true }).click()
        const route = await Promise.race([
          blockedChunk.promise,
          delay(45_000, undefined, { ref: false }).then(() => { throw new Error('Synthetic request timed out') }),
        ])
        await b.getByRole('button', { name: 'Cancel download', exact: true }).click()
        await route.abort()
        await b.unroute(`${origin}${chunkPath}`)
        await b.getByRole('status').filter({ hasText: 'Download canceled.' }).waitFor()
        const previousFile = await b.evaluate(async () => {
          const directory = await navigator.storage.getDirectory()
          const file = await (await directory.getFileHandle('synthetic-output')).getFile()
          const text = await file.text()
          await directory.removeEntry('synthetic-output')
          return text
        })
        assert.equal(previousFile, 'Original local file')
      })
    }
    for (const fixture of await fixtures()) {
      await step(`local ${fixture.name.split('.').at(-1)} preview in both peers`, async () => {
        await a.getByLabel('Choose files').setInputFiles(fixture)
        await a.getByRole('button', { name: 'Share files', exact: true }).click()
        for (const page of [a, b]) {
          await selectItem(page, fixture.name)
          const viewer = page.locator('.attachment-viewer')
          if (fixture.name.endsWith('.png')) {
            await page.waitForFunction(() => {
              const image = document.querySelector('.attachment-viewer img')
              return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
            })
          }
          if (fixture.name.endsWith('.pdf')) await viewer.getByText('Synthetic PDF preview', { exact: false }).first().waitFor()
          if (fixture.name.endsWith('.docx')) await viewer.getByText('Synthetic Word preview', { exact: false }).first().waitFor()
          if (fixture.name.endsWith('.xlsx')) await viewer.getByText('Synthetic spreadsheet preview', { exact: false }).first().waitFor()
        }
      })
      assert.equal(unexpectedExternalRequest, false)
    }
    await step('expired room and attachment access rejected', async () => {
      assert(authorization && chunkPath)
      await delay(Math.max(0, expiresAt - Date.now() + 2_000))
      for (const path of [`/api/v1/rooms/${locator}`, `/api/v1/rooms/${locator}/messages`, chunkPath]) {
        const response = await b.request.get(`${origin}${path}`, { headers: { Authorization: authorization } })
        assert([404, 410].includes(response.status()))
      }
    })
    console.log('PASS synthetic room expired; physical R2 deletion is verified separately')
  }
} catch {
  // Browser errors may contain invitation locators, form values, or request headers.
  console.error(`FAIL ${stage}; inspect this step with synthetic content only`)
  process.exitCode = 1
} finally {
  await browser?.close()
}
