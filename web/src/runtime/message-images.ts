import type { UiMessage } from "@/domain/messages";

const IMAGE_UNAVAILABLE = "The photo from that message is no longer available. Attach it again and send.";

/** Recover the complete prompt before sending anything; never silently omit a photo. */
export async function loadMessageImages(
  message: Pick<UiMessage, "parts" | "localAttachmentCount">,
  fetchBlob: (path: string) => Promise<Response>,
): Promise<{ data: string; mimeType: string }[]> {
  const parts = message.parts.filter((part) => part.kind === "image");
  if (parts.length < (message.localAttachmentCount ?? 0)) throw new Error(IMAGE_UNAVAILABLE);
  const images: { data: string; mimeType: string }[] = [];
  for (const part of parts) {
    const inline = part.src ? /^data:([^;,]+);base64,(.+)$/s.exec(part.src) : null;
    if (inline) {
      images.push({ data: inline[2], mimeType: inline[1] });
      continue;
    }
    // Same authenticated relative blob route used by ImagePart.
    const hash = part.src?.startsWith("blob:") ? part.src.slice(5).replace(/^sha256:/, "") : "";
    if (!/^[a-fA-F0-9]{8,128}$/.test(hash)) throw new Error(IMAGE_UNAVAILABLE);
    const response = await fetchBlob(`/api/blob/${hash}`);
    if (!response.ok) throw new Error(IMAGE_UNAVAILABLE);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error(IMAGE_UNAVAILABLE);
    let binary = "";
    // Spreading an entire photo can overflow the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    images.push({ data: btoa(binary), mimeType: part.mimeType });
  }
  return images;
}
