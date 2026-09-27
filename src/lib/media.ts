// Reads only the first chunk of each image (EXIF lives in the header) and looks for GPS tags.
// Blossom-style hosts address files by their sha256, so they *cannot* strip metadata server-side
// without breaking the hash: whatever the client uploaded is what everyone downloads.

import exifr from 'exifr'
import type { MediaFinding } from './types'

const MAX_BYTES = 192 * 1024

async function fetchHead(url: string, timeoutMs = 7000): Promise<ArrayBuffer> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { Range: `bytes=0-${MAX_BYTES - 1}` },
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    })
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`)
    const reader = r.body?.getReader()
    if (!reader) return await r.arrayBuffer()
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
    ctl.abort()
    const buf = new Uint8Array(total)
    let o = 0
    for (const c of chunks) {
      buf.set(c, o)
      o += c.length
    }
    return buf.buffer
  } finally {
    clearTimeout(t)
  }
}

export async function scanImage(img: { url: string; noteId: string; at: number; host: string; contentAddressed: boolean }): Promise<MediaFinding> {
  const base: MediaFinding = { ...img, status: 'clean' }
  let buf: ArrayBuffer
  try {
    buf = await fetchHead(img.url)
  } catch (e) {
    // A TypeError here is almost always CORS: the browser won't hand us the bytes.
    return { ...base, status: e instanceof TypeError ? 'blocked' : 'error' }
  }
  try {
    const data = await exifr.parse(buf, { gps: true, tiff: true, exif: true, xmp: false, icc: false, iptc: false, translateValues: true })
    if (!data) return base
    const camera = [data.Make, data.Model].filter(Boolean).join(' ').trim() || undefined
    const takenRaw = data.DateTimeOriginal ?? data.CreateDate
    const taken = takenRaw instanceof Date ? takenRaw.toISOString() : takenRaw ? String(takenRaw) : undefined
    if (typeof data.latitude === 'number' && typeof data.longitude === 'number' && (data.latitude !== 0 || data.longitude !== 0)) {
      return { ...base, status: 'gps', lat: data.latitude, lon: data.longitude, camera, taken }
    }
    if (camera || taken) return { ...base, status: 'exif', camera, taken }
    return base
  } catch {
    return base
  }
}
