// Patches the duration fields Chromium's fragmented-MP4 MediaRecorder leaves
// unknown/sentinel in the initial `moov` header (mvhd + each trak's
// tkhd/mdia/mdhd), so players that read duration straight from the header
// (rather than summing fragments) show the real recorded length instead of a
// bogus multi-hour value. Only overwrites fixed-width fields in place — box
// sizes are untouched, and fragments (moof/mdat) after moov are never read
// or modified. Bails out (no-op, returns false) if the box layout isn't
// exactly what's expected, so a parsing mismatch can never corrupt an
// otherwise-good file.

import fs from 'fs/promises'

// moov has no sample tables in fragmented output (MediaRecorder writes those
// per-fragment), so it's always tiny — this cap is a generous upper bound on
// how far into the file we'll read looking for it.
const HEADER_SCAN_BYTES = 4 * 1024 * 1024

interface Box {
  type: string
  start: number // absolute offset of the box's size field
  headerSize: number // bytes before the payload (8 normally, 16 for 64-bit size)
  size: number // total box size including header
}

function readBoxAt(buf: Buffer, offset: number): Box | null {
  if (offset + 8 > buf.length) return null
  const size32 = buf.readUInt32BE(offset)
  const type = buf.toString('ascii', offset + 4, offset + 8)
  if (size32 === 1) {
    if (offset + 16 > buf.length) return null
    return { type, start: offset, headerSize: 16, size: Number(buf.readBigUInt64BE(offset + 8)) }
  }
  if (size32 === 0) return null // "extends to EOF" — not expected before moov, treat as unparseable
  return { type, start: offset, headerSize: 8, size: size32 }
}

function findChild(buf: Buffer, parentStart: number, parentEnd: number, type: string): Box | null {
  let offset = parentStart
  while (offset < parentEnd) {
    const box = readBoxAt(buf, offset)
    if (!box || box.size < box.headerSize || offset + box.size > parentEnd) return null
    if (box.type === type) return box
    offset += box.size
  }
  return null
}

function eachChild(buf: Buffer, parentStart: number, parentEnd: number): Box[] {
  const out: Box[] = []
  let offset = parentStart
  while (offset < parentEnd) {
    const box = readBoxAt(buf, offset)
    if (!box || box.size < box.headerSize || offset + box.size > parentEnd) break
    out.push(box)
    offset += box.size
  }
  return out
}

/** Overwrites a version-0/1 mvhd/tkhd/mdhd duration field in place. Returns whether it patched. */
function patchDurationField(buf: Buffer, box: Box, durationSec: number): boolean {
  const payload = box.start + box.headerSize
  const boxEnd = box.start + box.size
  const version = buf.readUInt8(payload)
  if (version === 0) {
    // version(1) + flags(3) + creation_time(4) + modification_time(4) + timescale(4) + duration(4)
    const timescaleOff = payload + 12
    const durationOff = payload + 16
    if (durationOff + 4 > boxEnd) return false
    const timescale = buf.readUInt32BE(timescaleOff)
    if (!timescale) return false
    buf.writeUInt32BE(Math.min(0xffffffff, Math.round(durationSec * timescale)), durationOff)
    return true
  }
  if (version === 1) {
    // version(1) + flags(3) + creation_time(8) + modification_time(8) + timescale(4) + duration(8)
    const timescaleOff = payload + 20
    const durationOff = payload + 24
    if (durationOff + 8 > boxEnd) return false
    const timescale = buf.readUInt32BE(timescaleOff)
    if (!timescale) return false
    buf.writeBigUInt64BE(BigInt(Math.round(durationSec * timescale)), durationOff)
    return true
  }
  return false
}

/**
 * Rewrites the movie/track/media header durations of an MP4 file in place
 * using the real recorded duration. Returns true if at least one field was
 * patched, false if the file was left untouched (e.g. unexpected structure).
 */
export async function patchMp4Duration(filePath: string, durationSec: number): Promise<boolean> {
  if (!(durationSec > 0)) return false

  const handle = await fs.open(filePath, 'r+')
  try {
    const { size: fileSize } = await handle.stat()
    const scanLen = Math.min(HEADER_SCAN_BYTES, fileSize)
    const buf = Buffer.alloc(scanLen)
    await handle.read(buf, 0, scanLen, 0)

    const moov = findChild(buf, 0, scanLen, 'moov')
    if (!moov) return false
    const moovEnd = moov.start + moov.size
    if (moovEnd > scanLen) return false // moov spilled past our scan window; don't guess

    const moovChildren = eachChild(buf, moov.start + moov.headerSize, moovEnd)
    const targets: Box[] = []

    const mvhd = moovChildren.find((b) => b.type === 'mvhd')
    if (mvhd) targets.push(mvhd)

    for (const trak of moovChildren) {
      if (trak.type !== 'trak') continue
      const trakEnd = trak.start + trak.size
      const trakChildren = eachChild(buf, trak.start + trak.headerSize, trakEnd)
      const tkhd = trakChildren.find((b) => b.type === 'tkhd')
      if (tkhd) targets.push(tkhd)
      const mdia = trakChildren.find((b) => b.type === 'mdia')
      if (mdia) {
        const mdhd = findChild(buf, mdia.start + mdia.headerSize, mdia.start + mdia.size, 'mdhd')
        if (mdhd) targets.push(mdhd)
      }
    }

    if (!targets.length) return false
    let patchedAny = false
    for (const box of targets) {
      if (patchDurationField(buf, box, durationSec)) patchedAny = true
    }
    if (!patchedAny) return false

    await handle.write(buf, 0, scanLen, 0)
    return true
  } finally {
    await handle.close()
  }
}
