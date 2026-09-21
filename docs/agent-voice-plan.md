# Agent voice: validated route and implementation plan

Validated 2026-09-08. The investigation below records the original protocol probe; implementation status follows.

## Implementation status

The shared agent composer has microphone dictation, a per-message **Read aloud** action, **Stop voice**, an independent **Read responses** toggle, and a **Finish & Send** conversation mode. Read responses speaks new complete Rime messages without requesting microphone access. Dictation edits the saved draft and keeps the ordinary Send, steering, context, and approval paths. Stopping voice does not interrupt running agent tools.

Voice uses the existing Codex OAuth connection through authenticated ward signaling and the paired-device harness. OAuth tokens stay on the installation serving the call. A server control channel owns provider cleanup, one call per account, a renewable five-minute lease, and a 45-second client heartbeat deadline. Each accepted heartbeat extends the lease up to the provider deadline; a late heartbeat cannot revive an expired call. Expired login, unavailable voice, and another call leave typed chat usable. Voice transcripts and provider events have no tool execution or canonical-message path.

Dictation playback is muted: live validation found that the voice model can echo microphone speech despite its instructions. Read-aloud supplies only the selected assistant message. Numbers and code names can be pronounced differently; the displayed Rime message remains authoritative. No billing or plan-allowance claims are made.

macOS packaging includes the microphone usage description and audio-input entitlement. The user tested the signed 0.5.8 manual candidate and reported that it works very well, with playback stopping when leaving the chat. Playback ownership now follows the ward rather than its visible chat view; hiding a chat stops microphone capture while retaining playback and the read toggle. The client declares the native audio-session purpose where supported. These changes still require confirmation of the reported app/tab transition in the final signed build.

The implemented client and signaling helper passed an additional live synthetic check: dictation appended exactly “The purple bicycle is beside the garden gate.” to an edited draft, a 2.02-second Stop drain retained punctuation, read-aloud matched the selected ordinary sentence, and both provider calls acknowledged closure. Disposable ownership checks covered competing clients, revocation, malformed/oversized signaling, missing credentials, and uncertain-call protection across restart. Client lifecycle checks covered duplicate transcript fragments, draft edits, late start responses, permission failures, immediate capture stop, and navigation cleanup. Temporary credential fixtures were removed; production account data was unchanged.

Live synthetic checks of the implemented conversation client submitted the complete test sentence exactly once in each mode, retained its punctuation, and produced no extra submission during the following 3.5 seconds. Stop ended every synthetic capture track, closed both peers, and received acknowledged server closure. A separate read-only check kept playback alive after hiding the chat, made no microphone request, and maintained four successful status heartbeats. A 914-character ordinary reply was read in two complete-sentence chunks of 444 and 469 UTF-8 bytes, with all words in order and no repeated or dropped segment; the duplicate read key was ignored. Splitting mid-sentence had caused the voice model to complete the fragment and repeat words, so complete sentence boundaries are preferred where they fit. These browser checks do not establish macOS app-switch or real acoustic echo/barge-in behavior.

A disposable built-UI check also passed: the Read responses checkbox never requested microphone access; direct-stream and delayed mirror delivery spoke a stable event ID once; distinct events with identical text both spoke; `done` and history refresh did not replay speech. Switching Home/Away pages preserved playback, queued replies, and the toggle. Typed Enter still submitted during conversational playback and connection startup. The fixture made three synthetic agent requests, no provider calls, and reported no page errors.

The manual-flow gate is satisfied by the earlier user report. Hands-free automatic submission has been removed; provider-driven conversational submission has not shipped. The removed mode guessed at turn boundaries from microphone loudness followed by 2.5 seconds of silence and 1.2 seconds of transcript quiet, which was an explicit heuristic and never a provider finalization guarantee. The sampler remains for barge-in and requires sustained sound rather than accumulating unrelated noise bursts. Finish & Send and manual Stop drain for at least two seconds and 1.2 seconds of transcript quiet, with a six-second ceiling. An unsettled transcript stays editable. Live testing showed that `session.close` is not a transcript flush: closing about 800 ms after speech cut off punctuation.

Only input transcript fragments edit the draft. Provider delegation text and voice output never become agent requests or approvals. Newly received `says` and `reply` messages carry stable event identifiers shared by the direct stream and live mirror, preventing duplicate speech across those deliveries; stored history and repeated `done` data do not enqueue speech. Speech is sent sequentially in chunks of at most 500 UTF-8 bytes. Barge-in immediately mutes playback and clears queued speech, then closes the old call and waits for server acknowledgement before reconnecting capture. The UI shows Connecting during that gap; it does not promise to capture words spoken before Listening.

### Voice implementation review (2026-09-21)

Call admission reserves the account before asynchronous orphan recovery. A durable lease records the original account, credential generation, and owning process; another live process cannot take it over. Recovery requires `session.closed` from the provider. A refused socket, timeout, changed credential, or old record without account identity remains uncertain until expiry. The diagnostic probe uses the same admission and cleanup path and refuses all existing leases. These changes do not establish that every provider-side orphan can be recovered.

The client shares audio ownership across live voice and clip dictation. Teardown waits preserve every unconfirmed result. Delayed Stop/drain/permission/recording callbacks cannot close a newer capture, and queued read-aloud does not interrupt manual dictation or an unsent draft. Retired Hands-free mode has no submission path.

`tests/voice-delegation-probe.mjs --check` performs local, read-only preflight without refreshing tokens or calling the provider. An actual run uses one Chromium instance and a loopback page, injects synthetic audio only after the connection and context seed are ready, maintains the lease, records each incoming/outgoing frame, and waits for acknowledged provider closure in cleanup. Unknown probe names fail before admission. `p5` isolates the commentary and omitted-channel cases; `p6` isolates baseline, initial history, and a tools array, so all six probe groups make nine calls. Accepting a tools field does not establish executable function tools.

Run on an installation with the existing ChatGPT connection. Select `RIMEWARD_PROBE_USER` and `RIMEWARD_PROBE_WARD` when ambiguous. macOS uses `say`; elsewhere supply synthetic WAV files named for each case through `RIMEWARD_PROBE_AUDIO_DIR`. No build is needed:

```sh
node --env-file-if-exists=.env tests/voice-delegation-probe.mjs --check
node --env-file-if-exists=.env tests/voice-delegation-probe.mjs p1 p5
```

The probe is diagnostic and creates real provider usage when run without `--check`. No protocol conclusions, silent-channel guarantee, acoustic echo validation, or completed persistent voice conversation are implied by its presence. Delegation behavior still needs observed provider results; real speaker/microphone behavior needs the target signed desktop app.


## Clip dictation (the other credentials)

The live route above needs a ChatGPT login. For an OpenAI API key, an OpenAI-compatible endpoint on
the ward, or OpenRouter, the composer records instead: press the microphone, speak, press again. The
clip is decoded and re-encoded in the browser as 16 kHz mono WAV — the one format every route takes,
since OpenRouter accepts only WAV or MP3 — and POSTed to `/api/agent/<ward>/transcribe`, which
answers with text. The text is appended to the draft the person is already editing; it is never sent,
never a turn, and never a tool call.

`lib/agent/transcribe.ts` picks the route: the ward's own provider first, so dictation is billed
where the conversation is, then an account-wide OpenAI or OpenRouter key. A compat endpoint is used
only when the ward is already on it — the name of someone's own server is a choice, not a default.
OpenAI and compat go to `/audio/transcriptions` (`gpt-4o-mini-transcribe`, and `whisper-1` for compat,
which is the name those servers answer to). OpenRouter has no such endpoint, so the clip rides an
`input_audio` content part on the ward's own model; a model that cannot hear is reported as exactly
that, with no substitution. The ward surface reports `dictation: 'live' | 'clip' | null`, and the
composer hides the microphone when it is null rather than offering a control that cannot work. Read
aloud and the conversation modes stay on the live route only.

Not established: no clip has been transcribed against a real provider from this build. The wire
shapes follow the current OpenRouter and OpenAI documentation; the client's WAV encoder, the route's
bounds and the provider selection have not been exercised end to end.

## Decision

Use the existing Codex OAuth connection to create a separate WebRTC voice session. Keep the current Rime agent as the only executor of tools and approvals. Start with microphone dictation and explicit read-aloud; add automatic conversation only after turn boundaries and interruption are reliable.

No Platform API key or bundled Codex CLI is needed for the route validated here. This is an experimental backend protocol observed in Codex 0.153.4, not a documented compatibility guarantee for the public Audio API.

## Live validation

The final probe called OpenAI from the Rimeward server using its existing stored Codex access token. It did not refresh, replace, or print credentials. The server account was also confirmed to match the local Codex account without printing account identifiers.

| Check | Result |
| --- | --- |
| Create call with existing provider credentials | HTTP 201 and SDP answer |
| Requested model | `gpt-live-1-codex`, V3 protocol |
| Selected voice | `cove` |
| Browser WebRTC connection | `connected` |
| STT input | Synthetic speech: “The purple bicycle is beside the garden gate.” |
| Final STT text | Exact match after trimming whitespace |
| Speakable text | “Rimeward voice validation is working.” |
| TTS output transcript | Exact match twice in one session |
| Received audio | 49,836 bytes, 1,207 packets, positive total audio energy: 0.7123274769458936 |
| Executed agent tools | None |
| Real microphone recording | None; synthetic audio used |

The probe checked completed input/output transcripts and nonzero received audio energy with runnable assertions. This establishes working speech transport and matching output transcripts, not a human listening assessment or a production reliability benchmark.

Earlier probes exposed useful constraints:

- App-server realtime requires the `realtime_conversation` experimental feature.
- Its direct WebSocket startup rejects ChatGPT OAuth with `realtime conversation requires API key auth`. Source inspection confirms this is the WebSocket branch; WebRTC uses the ordinary authenticated model client.
- An accepted `thread/realtime/start` RPC is not proof of connection: startup failures arrive asynchronously.
- Initial speakable-text probes did not reliably produce the intended speech. The successful probe used an active audio track, a connected data channel, and instructions to speak supplied text while withholding independent answers. These changes were made together; their individual necessity has not been isolated.
- In the successful probe, the final user `turn.done` arrived after the next speakable context append. Do not assume that event always finalizes a dictation promptly while the voice model waits for Rime.
- Only `gpt-live-1-codex` with `cove` was validated end to end. Other model names and listed voices are not verified account capabilities.

All temporary app-server processes and headless browser sessions were stopped. No project files, chat history, or real microphone audio were supplied to voice sessions.

## Working wire contract

Call creation:

```text
POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas
Authorization: Bearer <existing Codex OAuth access token>
chatgpt-account-id: <existing account id>
Content-Type: application/json
openai-alpha: quicksilver=v2
originator: codex_cli_rs
```

The body is JSON, unlike the public API's multipart call-creation example:

```json
{
  "sdp": "<browser SDP offer>",
  "session": {
    "model": "gpt-live-1-codex",
    "instructions": "You are the voice interface for Rimeward. Say supplied speakable context aloud verbatim. Never repeat microphone speech or answer it yourself. Wait for speakable context from the agent. Do not use tools.",
    "audio": { "output": { "voice": "cove" } },
    "delegation": { "type": "client", "ack_filler": false }
  }
}
```

Success returns an SDP answer; upstream also supplies a call identifier through the Location header. The validated minimal client needed only the SDP. Credentials stay on the server.

Browser setup uses native `RTCPeerConnection`, an audio track, and an `oai-events` data channel. Audio travels over WebRTC; JSON control and transcript events travel over the data channel. No audio needs to enter the existing model-result relay.

Send text to speak:

```json
{
  "type": "session.context.append",
  "channel": "speakable",
  "content": [{ "type": "input_text", "text": "Rimeward voice validation is working." }]
}
```

Observed events: `session.started`, `session.context.appended`, `input_transcript.added`, `output_transcript.added`, `turn.created`, `turn.delta`, `turn.done`, and `session.usage.updated`. `turn.done.turn` carries role and transcript. Avoid concatenating both the item transcript stream and turn deltas into the same text: they overlap.

The source defines `session.close`; explicitly validate its acknowledgement and billing/session cleanup during implementation. The probes closed their media connections, but did not prove a server-side close acknowledgement.

App-server remains a reference/debug option: `thread/realtime/start`, `appendAudio`, `appendText`, `appendSpeech`, `listVoices`, and `stop`. Its returned voice catalog grouped V1 voices (`juniper`, `maple`, `spruce`, `ember`, `vale`, `breeze`, `arbor`, `sol`, `cove`) and V2 voices (`alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`). V3 uses the V1 voice group in the inspected source. Do not present the whole catalog as live-tested.

## Implementation sequence

### 1. Add a small authenticated signaling bridge

- Add a voice call helper beside `src/lib/agent/codex.ts`; reuse `ensureFreshTokens` and existing account lookup. Fix the upstream destination, model, and initial instructions on the server rather than accepting arbitrary provider URLs or session objects from clients.
- Expose a bounded, authenticated voice-start action scoped to an accessible agent ward. Validate the SDP and cap its size; return the answer with `Cache-Control: no-store`. Never return OAuth credentials or log request bodies.
- For desktop users sharing server credentials, extend `src/lib/agent/sync.ts` and `src/pages/api/devices/harness/[...action].ts` with a signaling action that follows existing paired-device authorization. Keep voice media out of `sharedModel`.
- Allow one explicitly owned voice session per user initially, with expiry and cleanup. Do not blindly retry an uncertain successful call creation, which could create duplicate sessions.
- Surface unavailable voice, expired login, permission failures, and upstream errors without breaking typed chat. API-key fallback is a separate product choice, not an automatic credential substitution.

Exit check: browser and desktop can create a session through Rimeward authorization; another user/device cannot create or control it; tokens never reach browser state.

### 2. Add dictation and read-aloud to the shared chat composer

- Implement native WebRTC/media handling in a small `src/scripts/app/agent-voice.ts` module, integrated with the existing `agent.ts` state and views.
- Put microphone, read-aloud, and stop-speaking controls in the agent chat. Show connecting, listening, and speaking states with accessible labels. Require a user gesture before microphone capture or playback.
- Dictate into the existing draft and retain ordinary Send/edit behavior for the first version. Do not automatically submit partial transcripts. Account for late transcript deltas before closing a dictation session; finalize on a tested rule rather than assuming `turn.done` is prompt.
- Feed selected assistant text into `session.context.append`. Do not let voice output replace canonical Rime messages or invoke Rime tools. Instructions are not an authorization boundary: voice events must have no direct execution path.
- Keep one capture/playback owner across duplicated views of the same ward. Hiding the chat stops capture and preserves playback; full workspace navigation, user Stop voice, account disconnect, and ward deletion release the owner.
- Verify microphone permission handling in the signed Tauri host and add macOS usage-description/configuration support where required. Headless Chromium validation does not establish WKWebView microphone behavior.

Exit check: real microphone dictation reaches an editable draft; reading a chosen reply produces matching speech; Stop immediately silences audio and releases capture; typed chat and approvals still work normally.

### 3. Connect automatic voice turns only after the manual flow is reliable

- Reuse `agent.ts`'s existing `submit`/`steer` flow so spoken requests preserve ward context, persistence, cancellation, and approvals.
- Read the existing `says` and `reply` events once, deduplicated by conversation/turn ownership. `done` repeats final reply data and must not speak it again. Reconnecting mirrors must not replay old audio.
- Start by speaking complete agent messages. `codex.ts` currently buffers upstream SSE, and `sharedModel` returns a completed JSON result; sentence-level speech streaming would require changes across both paths. Keep that out of the first version.
- Define barge-in explicitly: stop playback first; stopping Rime's running tools remains a separate, existing interrupt action. Never claim the agent stopped merely because audio stopped.
- Test transcript finalization while the voice model waits for a long-running Rime turn, and prevent speculative voice responses from being treated as Rime answers.

Exit check: one spoken request yields one existing Rime turn and one spoken reply, including during steering, approvals, long tools, reconnects, and duplicate ward views.

### 4. Validate and release the completed implementation

- Use existing test/typecheck/desktop lint commands and existing UI goldens/smokes. Preserve every existing test; no new test suite is proposed.
- Run targeted synthetic audio checks for exact STT/TTS, first-audio behavior, transcript tails, stop/close, reconnect, unavailable credentials, and two competing clients. Add real microphone/echo/barge-in checks on the target desktop and browser.
- Test a small set of supplied text containing numbers, punctuation, and code-related names. A voice model's matching transcript in two samples is not a guarantee of deterministic TTS.
- Verify session expiry and actual provider usage reporting before describing plan allowances or costs to users. `session.usage.updated` exposed audio duration, but the probe did not measure billing or remaining allowance.
- Follow the normal Rimeward release workflow when implementation and release are authorized. This investigation does not require a build, commit, deploy, or installation.

## Sources and local evidence

- [Codex 0.153.4 call creation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-api/src/endpoint/realtime_call.rs)
- [Codex realtime authentication and model defaults](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/realtime_conversation.rs)
- [V3 session/context encoding](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs)
- [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [Official Voice availability](https://learn.chatgpt.com/docs/features/voice)

Temporary probe scripts, synthetic audio, and output are in `/tmp/rimeward-voice-probe`; generated app-server schemas are in `/tmp/rimeward-voice-schema-20260908`. They are diagnostic artifacts, not a shipping dependency. This document preserves the sanitized results if those temporary directories are removed.
