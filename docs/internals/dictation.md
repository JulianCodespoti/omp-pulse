# Dictation

This page covers local speech-to-text: how the composer's microphone turns a
recording into editable text without sending audio off the machine, and why the model
is Parakeet. The overview is in [architecture.md](architecture.md); installing the
model is in the user docs ([configuration](../user/configuration.md)).

## How it works

Both the chat composer and the new-session composer include a microphone.
Audio is transcribed LOCALLY: `POST /api/transcribe` hands the recording to `src/server/asr.rs`, which
decodes it with ffmpeg to 16 kHz mono and passes it to a warm Python sidecar
(`src/server/asr-server.py`) running NVIDIA Parakeet 0.6B int8 through sherpa-onnx.
Nothing leaves the machine, and the daemon gains no Rust dependency, which is what
keeps the Windows and musl targets building (see the dependency rules in
`AGENTS.md`).

The sidecar exists only around dictation: the phone calls `POST /api/transcribe/warm`
as recording starts so the model load overlaps the speech, `/api/transcribe` spawns
it itself if that was missed, and it is reaped after 3 minutes idle because it holds
~1.3 GiB resident. Spawning happens under the same lock that serializes requests:
dictation is one-at-a-time per person, so a mutex is simpler and more predictable
than a correlation map, and concurrent callers never start a second model.

Insert adds the transcript to the current draft for review; Insert and send
explicitly sends the whole draft. In an existing chat, the transcript always
belongs to the chat the recording started in: opening another chat remounts the
composer, but a recording already stopped still transcribes and goes to its own
chat's live editor or saved draft. A recording still running is discarded.

Before a session exists, the new-session screen uses the same recording controls
and transcription hook. Insert and send creates the session with the selected
project and model, then sends the full draft through the durable outbox. Leaving
the screen ignores a late transcript and never creates a session. Retrying a
cancelled or failed transcription only inserts its words; it does not retain a
previous send intent.

The upload has its own deadline, 30 s plus the audio's length (the shared request
deadline covers reads only). Cancelling the upload, the deadline, or a failure keeps
the recording so Retry can post it again without speaking again; a new recording, a
send, dismissing, or leaving that chat drops it.

Dictation needs a secure context, so it is unavailable on a plain-HTTP origin; see
[web-client.md](web-client.md#https-is-a-feature-not-a-detail).

## Why Parakeet and not Whisper

Measured rather than assumed: on the Open ASR Leaderboard English sets Parakeet
averages 5.91% WER against Whisper large-v3's ~7.4%, at a third of the parameters. On
a laptop CPU (Core Ultra 9 285H, 6 threads) it decodes 7.4 s of speech in 0.45 s
warm, and the full round trip through the daemon is 0.55 s. The deciding property is
structural, though: a transducer cannot emit tokens without audio evidence, so it
does not invent sentences during the silence that starts and ends every recording.
Whisper's decoder can, and does, and the output here is about to instruct a coding
agent.

## Licensing

Model weights are CC-BY-4.0 and are downloaded by `omp-pulse asr install`, never
bundled, so the binary itself carries no CC-BY material.
