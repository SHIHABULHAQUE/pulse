import { LIMITS, type ImageAttachment } from '@pulse/protocol';

const TARGET_BYTES = 300_000;
const ACCEPTED = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/;

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Re-encodes an image on the device: max 1280 px, WebP (JPEG where WebP encoding isn't supported), ~300 KB.
 * Re-encoding also strips EXIF metadata such as GPS location.
 */
export async function compressImage(file: Blob): Promise<ImageAttachment> {
  if (file.type && !ACCEPTED.test(file.type)) throw new Error('That file type is not supported. Send a photo or picture.');
  if (file.size > 30 * 1024 * 1024) throw new Error('That image is too large (max 30 MB before compression)');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('Could not read that image'); }
  const scale = Math.min(1, LIMITS.imageMaxSide / Math.max(bitmap.width, bitmap.height));
  let width = Math.max(1, Math.round(bitmap.width * scale));
  let height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  const draw = () => {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // transparent PNGs → white instead of black when saved as JPEG
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
  };
  draw();
  let mime: ImageAttachment['mime'] = 'image/webp';
  let quality = 0.82;
  let blob = await canvasToBlob(canvas, mime, quality);
  if (!blob || blob.type !== 'image/webp') { mime = 'image/jpeg'; blob = await canvasToBlob(canvas, mime, quality); }
  // Lower quality, then size, until it fits.
  for (let attempt = 0; blob && blob.size > TARGET_BYTES && attempt < 8; attempt++) {
    if (quality > 0.5) quality -= 0.12;
    else { width = Math.round(width * 0.8); height = Math.round(height * 0.8); draw(); }
    blob = await canvasToBlob(canvas, mime, quality);
  }
  bitmap.close();
  if (!blob) throw new Error('Could not compress that image');
  const data = await blobToB64(blob);
  if (data.length > LIMITS.imageB64Chars) throw new Error('Image is still too large after compression');
  return { mime, data, width, height };
}

export function imageSrc(image: ImageAttachment): string {
  return `data:${image.mime};base64,${image.data}`;
}
