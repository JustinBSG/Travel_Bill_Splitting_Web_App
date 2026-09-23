// Photo proof. Re-encoding through a canvas drops ALL EXIF metadata,
// including GPS, without an extra library.
const MAX_EDGE = 1600

export interface PreparedPhoto {
  blob: Blob
  /** false when re-encoding failed and the original (with metadata) is used. */
  stripped: boolean
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
    if (!blob) throw new Error('encode failed')
    return { blob, stripped: true }
  } catch {
    return { blob: file, stripped: false }
  }
}
