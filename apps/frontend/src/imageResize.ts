// Downscales a photograph before it is uploaded.
//
// A product image is shown at 56px in the menu, 44px in the products table and at most the
// lightbox's width; the file a phone camera hands the picker is 4000px and 3–5MB. With the
// bucket serving originals (no image transforms on this plan), every storefront visit
// downloaded the original for every thumbnail — for a twenty-item menu, tens of megabytes,
// and the dominant byte cost of the customer's page. Bounding the LONG EDGE at upload is what
// the storage layer cannot do for us, and it is the one place the merchant's phone does the
// work rather than every customer's.
//
// Best effort, never a gate: anything that fails — an unsupported type, a browser without
// `createImageBitmap`, a decode error, a canvas that refuses — returns the original file, and
// the upload proceeds exactly as it did before this existed.

/** Long-edge cap. 1600px fills a phone's lightbox at 2× and is a ~200KB JPEG, not a 4MB one. */
export const MAX_IMAGE_EDGE = 1600

/** Below this size nothing is gained by re-encoding, whatever the dimensions. */
const SKIP_UNDER_BYTES = 300 * 1024

const QUALITY: Record<string, number> = { 'image/jpeg': 0.85, 'image/webp': 0.85 }

export async function downscaleImage(file: File, maxEdge = MAX_IMAGE_EDGE): Promise<File> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file
  try {
    // `imageOrientation: 'from-image'` bakes the EXIF rotation in, so a portrait phone photo
    // stays portrait once the metadata is gone with the re-encode.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
      if (scale === 1 && file.size < SKIP_UNDER_BYTES) return file
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      ctx.drawImage(bitmap, 0, 0, width, height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, file.type, QUALITY[file.type]))
      // A re-encode that came out LARGER (a flat PNG, say) is not an improvement; keep the original.
      if (!blob || blob.size >= file.size) return file
      return new File([blob], file.name, { type: file.type, lastModified: file.lastModified })
    } finally {
      bitmap.close()
    }
  } catch {
    return file
  }
}
