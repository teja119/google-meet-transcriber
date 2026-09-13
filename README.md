# Google Meet Transcriber

Captures Google Meet's live captions in the background, with speaker
attribution, and can:

- download a timestamped `.txt` transcript
- optionally translate captions live, entirely on-device
- generate a **speaker-wise summary** using a free LLM (Groq)

## What changed in this update

### Fixing capture
The extension had stopped working because it located the captions panel and
the CC button using **hardcoded, auto-generated CSS class names**. Google
rotates those on Meet UI updates. This version instead targets the **stable,
semantic attributes** Meet exposes:

- Captions panel: `[role="region"][aria-label="Captions"]`
- CC toggle button: `button[aria-label="Turn on captions" / "Turn off captions"]`

Speaker names have no equivalent stable attribute, so speaker attribution
uses a structural heuristic instead (see `parseRow` in `content.js`): within
each per-speaker caption row, a short line with no ending punctuation is
treated as the name, and the rest as the spoken text. This is the same
approach other current Meet-transcript extensions use, since Google doesn't
expose speaker identity any other way.

Also removed the old, unused `getUserMedia`/`MediaRecorder` microphone-capture
code — it never sent audio anywhere and just triggered a needless mic prompt.

### Live translation (on-device)
Pick a language from the popup dropdown and captions are translated as
they're captured, using Chrome's built-in, on-device Translator and Language
Detector APIs — no API key, no server, nothing leaves your machine.

- Requires **Chrome 138+, desktop only**. On unsupported Chrome, capture still
  works — translation is just skipped, and the popup tells you why.
- First use of a language pair may pause briefly while Chrome downloads a
  small model in the background.
- Meet itself only shows captions in one language at a time, so this
  translates whatever Meet already gives it.

### Speaker-wise summary (Groq)
Click **Summarize by Speaker** after stopping a capture to get:

```
Alice
-----
• Sent the proposal
• Asked about timeline

Bob
---
• Suggested using Kubernetes

Overall Summary
---------------
The team aligned on next steps for deployment...
```

This calls Groq's free-tier API (`openai/gpt-oss-120b` — Groq retired
`llama-3.3-70b-versatile` in August 2026) directly from the popup, entirely
client-side. You need your own free Groq API key:

1. Get one at [console.groq.com/keys](https://console.groq.com/keys) — no
   credit card required.
2. Paste it into the **Groq API key** field in the popup and click **Save
   key**. It's stored only in your browser's local extension storage, never
   sent anywhere except directly to `api.groq.com`.

Note: transcripts sent to Groq leave your machine (unlike the on-device
translation). Don't use this on meetings you need to keep fully local — the
capture and translation features still work without ever calling Groq.

## Features

- Join a Google Meet call and click the extension icon in the toolbar.
- Optionally pick a language from **Translate captions to**.
- Click **Start Capture** — turns on Meet's captions (if not already on) and
  records them, with speaker names, in the background.
- Click **Stop & Download** to stop and download the transcript.
- Click **Summarize by Speaker** to get a per-person + overall summary via
  Groq (requires a free API key, see above).

**Note:** transcript quality depends on Google Meet's own captions — they're
auto-generated and may paraphrase or drop punctuation. Speaker labels are a
best-effort heuristic and may show "Unknown" if Meet's layout doesn't match
the expected pattern.

## Setup Instructions

### For Developers and Testers

1. Clone/unzip this project.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer Mode** (top right).
4. Click **Load Unpacked** and select the project folder.
5. Open (or refresh, if already open) a `meet.google.com` call — content
   scripts only attach to tabs opened/refreshed *after* the extension loads.
6. Click the extension icon and use **Start Capture** / **Stop & Download**.
7. (Optional) Add a free Groq API key to use **Summarize by Speaker**.

After any code change, reload the extension from `chrome://extensions/` **and**
refresh any open Meet tab.

## Author
Tejas Mahajan