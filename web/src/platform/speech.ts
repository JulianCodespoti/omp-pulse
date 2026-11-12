import { useSyncExternalStore } from "react";

/**
 * Read a reply aloud with the platform's speech synthesis. One reading at a
 * time: starting another cancels the first. A reading is queued as sentence
 * chunks because Chrome silently stops a single utterance after ~15 s.
 */

let current: object | null = null;
const listeners = new Set<() => void>();

function setCurrent(next: object | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export type SpeechFailure = "no-voice" | "failed";
const failureListeners = new Set<(reason: SpeechFailure) => void>();

/** Hear why a reading could not play, so Stop does not just flash and clear with no explanation. */
export function onSpeechFailure(listener: (reason: SpeechFailure) => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

function fail(reading: object, reason: SpeechFailure): void {
  if (current !== reading) return;
  setCurrent(null);
  window.speechSynthesis.cancel();
  for (const listener of failureListeners) listener(reason);
}

// `interrupted` and `canceled` are our own cancel() (a newer reading or Stop), not failures.
const NO_VOICE_ERRORS: Record<string, true> = { "synthesis-unavailable": true, "voice-unavailable": true, "language-unavailable": true };
const VOICE_WAIT_MS = 1500;

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";
}

/** Markdown to what a person would say: no fences, link targets or markers. */
export function plainSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " code block. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.split("-")[0]!.toLowerCase();
  const matches = voices.filter((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === base);
  const exact = matches.filter((voice) => voice.lang.toLowerCase().replace("_", "-") === lang.toLowerCase());
  return [...exact, ...matches].find((voice) => voice.default) ?? exact[0] ?? matches[0];
}

/** Sentences packed into chunks of at most `max` chars (a lone longer sentence stays whole). */
export function speechChunks(plain: string, max = 200): string[] {
  const sentences = plain.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [plain];
  const chunks: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last]!.length + sentence.length + 1 <= max) chunks[last] += ` ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}

export function speak(text: string): void {
  if (!speechAvailable()) return;
  const plain = plainSpeech(text);
  if (!plain) return;
  window.speechSynthesis.cancel();
  const lang = navigator.language || "en-US";
  const voice = defaultVoice(lang);
  const reading = {};
  const chunks = speechChunks(plain);
  let started = false;
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = lang;
    if (voice) utterance.voice = voice;
    // A cancelled reading reports its end after the next one began; only the
    // current reading's last chunk (or any error) may clear the state.
    const done = () => { if (current === reading) setCurrent(null); };
    if (index === chunks.length - 1) utterance.onend = done;
    utterance.onstart = () => { started = true; };
    utterance.onerror = (event) => {
      if (event.error === "interrupted" || event.error === "canceled") done();
      else fail(reading, NO_VOICE_ERRORS[event.error] ? "no-voice" : "failed");
    };
    window.speechSynthesis.speak(utterance);
  });
  setCurrent(reading);
  if (!voice && window.speechSynthesis.getVoices().length === 0) awaitVoices(reading, () => started);
}

/**
 * Voices load asynchronously (Chrome fires `voiceschanged`; some WebViews never
 * do), so an empty list at speak time proves nothing. Only a list still empty
 * after `voiceschanged` or a short wait, with nothing spoken yet, means this
 * device has no voice.
 */
function awaitVoices(reading: object, hasStarted: () => boolean): void {
  const synth = window.speechSynthesis;
  let timer = 0;
  const check = () => {
    synth.removeEventListener("voiceschanged", check);
    window.clearTimeout(timer);
    if (current === reading && !hasStarted() && synth.getVoices().length === 0) fail(reading, "no-voice");
  };
  synth.addEventListener("voiceschanged", check);
  timer = window.setTimeout(check, VOICE_WAIT_MS);
}

export function stopSpeaking(): void {
  if (!speechAvailable()) return;
  window.speechSynthesis.cancel();
  setCurrent(null);
}

// A reading must not talk on from a backgrounded app or a locked phone.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && current !== null) stopSpeaking();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSpeaking(): boolean {
  return useSyncExternalStore(subscribe, () => current !== null, () => false);
}
