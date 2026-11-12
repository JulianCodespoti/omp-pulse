import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon, DownloadIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { Notice } from "./ui/Notice";
import { humanizeDaemonError } from "./ui/OwnedBySession";
import {
  loadDraftAttachments,
  offlineQueueNamespaceForCredential,
  recoverCommand,
  saveDraftAttachments,
  type QueuedImage,
} from "../runtime/offline-queue";
import { recoverDraft } from "./composer/use-draft";

type Recovery = {
  text?: string;
  images?: (QueuedImage & { name: string })[];
  recording?: string;
  commands?: { commandId: string; text: string; images: QueuedImage[] }[];
};
type Scope = { token: string; sessionPath: string };
type UpgradePlugin = {
  readSession(scope: Scope): Promise<Recovery>;
  acknowledgeSession(scope: Scope): Promise<void>;
};
const plugin = (window as Window & {
  Capacitor?: { Plugins?: { OmpNativeUpgrade?: UpgradePlugin } };
}).Capacitor?.Plugins?.OmpNativeUpgrade;

// Serialize StrictMode's duplicate effect without ever retaining credentials or
// large image payloads after an import settles.
const pending = new Map<string, Promise<string | undefined>>();
function recover(scope: Scope): Promise<string | undefined> {
  const namespace = offlineQueueNamespaceForCredential(scope.token);
  const key = `${namespace}:${scope.sessionPath}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const job = (async () => {
    const saved = await plugin!.readSession(scope);
    if (saved.text) recoverDraft(scope.sessionPath, saved.text, namespace);
    if (saved.images?.length) {
      const images = await loadDraftAttachments(scope.sessionPath, namespace);
      for (const image of saved.images) {
        if (!images.some((entry) => entry.data === image.data && entry.mimeType === image.mimeType)) {
          images.push({ ...image, previewUrl: `data:${image.mimeType};base64,${image.data}`, width: 0, height: 0 });
        }
      }
      await saveDraftAttachments(scope.sessionPath, images, namespace);
    }
    for (const command of saved.commands ?? []) {
      await recoverCommand({ ...command, sessionPath: scope.sessionPath, namespace });
    }
    if (saved.commands !== undefined) await plugin!.acknowledgeSession(scope);
    return saved.recording;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** Only installed native-UI upgrades pass through this; the PWA is unchanged. */
export function NativeUpgradeBoundary({ token, sessionPath, children, onBack }: {
  token: string;
  sessionPath: string | null;
  children: ReactNode;
  onBack: () => void;
}) {
  const [ready, setReady] = useState(!plugin);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [recording, setRecording] = useState<string>();
  useEffect(() => {
    if (!plugin || !sessionPath) return;
    let active = true;
    setError("");
    void recover({ token, sessionPath }).then((audio) => {
      if (active) { setRecording(audio); setReady(true); }
    }).catch((failure: unknown) => {
      if (active) setError(humanizeDaemonError(failure));
    });
    return () => { active = false; };
  }, [token, sessionPath, attempt]);
  if (!ready) {
    return (
      <main className="flex min-h-dvh flex-col gap-6 bg-background px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
        <Button variant="ghost" size="icon" aria-label="Back to sessions" className="-ml-2" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        {error ? (
          <Notice
            tone="danger"
            title="Couldn’t bring over your saved work."
            action={{ label: "Try again", onClick: () => setAttempt((n) => n + 1) }}
          >
            {error} Nothing from the previous app was deleted.
          </Notice>
        ) : (
          <p className="flex items-center gap-2 text-ui text-muted-foreground" role="status">
            <Spinner size={16} label={null} />
            Bringing over your saved work…
          </p>
        )}
      </main>
    );
  }
  return <>
    {children}
    {recording ? (
      <aside
        className="fixed inset-x-4 top-[max(4rem,calc(env(safe-area-inset-top)+3.5rem))] z-sheet flex items-center gap-2 rounded-lg bg-surface-1 py-1 pl-4 pr-1 shadow-[var(--shadow-card)]"
        aria-label="Recovered voice recording"
      >
        <span className="min-w-0 flex-1 text-ui">A voice recording from the previous app was recovered.</span>
        <Button
          variant="ghost"
          size="icon"
          nativeButton={false}
          aria-label="Save recording"
          render={<a download="recovered-recording.m4a" href={`data:audio/mp4;base64,${recording}`} />}
        >
          <DownloadIcon />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={() => setRecording(undefined)}>
          <XIcon />
        </Button>
      </aside>
    ) : null}
  </>;
}
