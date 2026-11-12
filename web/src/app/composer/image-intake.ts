export const MAX_IMAGES = 8;
/** Per-image cap on the base64 the daemon accepts (MAX_IMAGE_BASE64_CHARS). */
export const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;
/**
 * One message's total image payload. Mirrors the daemon's body cap minus its
 * 1 MiB allowance for text and JSON framing (MAX_BASE64_JSON_BODY).
 */
export const MAX_TOTAL_IMAGE_BASE64_CHARS = MAX_IMAGES * MAX_IMAGE_BASE64_CHARS;
export const PAYLOAD_TOO_LARGE_COPY = "This message is too large to send. Try fewer photos.";

export function imagesTooLargeToSend(images: readonly { data: string }[]): boolean {
  let total = 0;
  for (const image of images) total += image.data.length;
  return images.length > MAX_IMAGES || images.some(image => image.data.length > MAX_IMAGE_BASE64_CHARS)
    || total > MAX_TOTAL_IMAGE_BASE64_CHARS;
}
export const MAX_LONG_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export interface ProcessedImage {
  data: string; // base64 without data: prefix
  mimeType: string;
  previewUrl: string; // data URL for display
  name: string;
  width: number;
  height: number;
}

export interface IntakeResult {
  images: ProcessedImage[];
  error?: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  let resolve!: (value: HTMLImageElement) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<HTMLImageElement>((res, rej) => { resolve = res; reject = rej; });
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("decode failed"));
  img.src = src;
  return promise;
}

/**
 * The intake error is shown to the user as is. The WebView cannot decode some
 * formats a phone gallery holds (HEIC above all), and "decode failed" told
 * them neither which file nor what to do instead.
 */
function unreadableImageCopy(file: File): string {
  return `Couldn’t open ${file.name || "this image"}. Try a JPEG or PNG instead.`;
}

function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function downscaleFile(file: File): Promise<ProcessedImage> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl).catch(() => {
      throw new Error(unreadableImageCopy(file));
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error(unreadableImageCopy(file));

    const longEdge = Math.max(w, h);
    const needsDownscale = longEdge > MAX_LONG_EDGE;
    const scale = needsDownscale ? MAX_LONG_EDGE / longEdge : 1;
    const outW = Math.round(w * scale);
    const outH = Math.round(h * scale);

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(img, 0, 0, outW, outH);

    const keepPng = file.type === "image/png" && !needsDownscale;
    let mimeType = keepPng ? "image/png" : "image/jpeg";
    let dataUrl = keepPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    let b64 = base64Of(dataUrl);
    // A photo saved as PNG compresses poorly: under the size limit in pixels
    // it can still be over the per-image byte cap. JPEG fits; refusing it did not.
    if (keepPng && b64.length > MAX_IMAGE_BASE64_CHARS) {
      mimeType = "image/jpeg";
      dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      b64 = base64Of(dataUrl);
    }
    if (b64.length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error(`${file.name || "This image"} is too large to attach. Try a smaller photo.`);
    }

    return {
      data: b64,
      mimeType,
      previewUrl: dataUrl,
      name: file.name || "image",
      width: outW,
      height: outH,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function intakeFiles(files: FileList | File[], currentCount: number): Promise<IntakeResult> {
  const incoming = [...files].filter((f) => f.type.startsWith("image/"));
  if (incoming.length === 0) {
    return { images: [], error: "No images found. Choose an image file to attach." };
  }

  const room = Math.max(0, MAX_IMAGES - currentCount);
  if (room === 0) {
    return { images: [], error: `You can add up to ${MAX_IMAGES} images per message. Remove one to add another.` };
  }

  const capped = incoming.slice(0, room);
  const overflow = incoming.length - capped.length;

  const processed: ProcessedImage[] = [];
  let firstError: string | undefined;
  let failures = 0;

  for (const file of capped) {
    try {
      const img = await downscaleFile(file);
      processed.push(img);
    } catch (e) {
      failures++;
      const msg = e instanceof Error ? e.message : "Could not process image. Try a different file.";
      if (!firstError) firstError = msg;
    }
  }

  // One failure keeps its own, specific message; several read as one summary with the first reason,
  // so a batch of five does not raise five competing errors.
  if (failures > 1) firstError = `${failures} of ${capped.length} photos couldn’t be added. ${firstError}`;

  if (overflow > 0) {
    const msg = `You can add up to ${MAX_IMAGES} images per message. Remove one to add another.`;
    return { images: processed, error: firstError ?? msg };
  }

  if (firstError && processed.length === 0) {
    return { images: [], error: firstError };
  }

  if (firstError) {
    return { images: processed, error: firstError };
  }

  return { images: processed };
}

export async function processImageFile(file: File): Promise<ProcessedImage> {
  return downscaleFile(file);
}
