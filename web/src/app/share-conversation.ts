import type { UiMessage } from "@/domain/messages";
import { copyText } from "@/platform/clipboard";
import { fileSaveMode, isNativeShell, saveBlob } from "@/platform/native-shell";
import { showToast } from "./Notices";

/** The visible conversation as Markdown: prose only, each run of tool calls as one italic line. */
export function conversationMarkdown(messages: readonly UiMessage[], title: string): string {
  const blocks = [`# ${title.trim() || "Conversation"}`];
  let tools = 0;
  const flush = () => {
    if (tools) blocks.push(`_Used ${tools} ${tools === 1 ? "tool" : "tools"}_`);
    tools = 0;
  };
  for (const message of messages) {
    const text = message.text.trim();
    if (text) {
      flush();
      blocks.push(message.role === "user" ? "**You**" : "**omp**", text);
    }
    if (message.role === "assistant") tools += message.parts.filter((part) => part.kind === "tool").length;
  }
  flush();
  return `${blocks.join("\n\n")}\n`;
}

function fileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "conversation"}.md`;
}

export async function shareConversation(messages: readonly UiMessage[], title: string): Promise<void> {
  const markdown = conversationMarkdown(messages, title);
  const name = fileName(title);
  const blob = new Blob([markdown], { type: "text/markdown" });
  try {
    const file = new File([blob], name, { type: blob.type });
    if (typeof navigator.canShare === "function" && typeof navigator.share === "function" && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
    // The shell's save route (share sheet) wins over the clipboard; in a
    // browser without file sharing a silent download would be a surprise.
    if (isNativeShell() && fileSaveMode(name, blob.type)) {
      await saveBlob(blob, name);
      return;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    // Any other share failure falls through to the clipboard.
  }
  if (await copyText(markdown)) showToast("Conversation copied as Markdown");
  else showToast("Couldn't copy the conversation", "error");
}
