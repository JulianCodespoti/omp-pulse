type CapacitorWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean };
};

/**
 * True inside the installed Android shell. Its WebView hands `<a download>`
 * blob:/data: URLs to a DownloadListener that silently fails, so saving a file
 * there has to go through the share sheet instead.
 */
export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as CapacitorWindow).Capacitor;
  return typeof cap?.isNativePlatform === "function" && cap.isNativePlatform() === true;
}

/** Whether the share sheet accepts a file with this name and type. */
export function canShareFile(name: string, type = ""): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([], name, { type })] });
  } catch {
    return false;
  }
}

/** How this platform saves a file: a download in a browser, the share sheet in the shell, or not at all. */
export function fileSaveMode(name: string, type = ""): "download" | "share" | null {
  if (!isNativeShell()) return "download";
  return canShareFile(name, type) ? "share" : null;
}

/**
 * Save a file the way this platform can. `false` when it cannot (shell
 * without file sharing) or the person dismissed the share sheet.
 */
export async function saveBlob(blob: Blob, name: string): Promise<boolean> {
  const mode = fileSaveMode(name, blob.type);
  if (mode === "share") {
    try {
      await navigator.share({ files: [new File([blob], name, { type: blob.type })] });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return false;
      throw error;
    }
  }
  if (mode !== "download") return false;
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(blob);
  try {
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
  return true;
}
