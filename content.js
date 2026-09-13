// content.js — captures Google Meet's live captions (with speaker attribution)
// and turns them into a timestamped transcript, optionally translated live
// using Chrome's built-in on-device Translator/Language Detector APIs
// (Chrome 138+, desktop only).
//
// Google Meet's caption UI is built with auto-generated, frequently-rotating
// CSS class names (e.g. .iOzk7, .VfPpkd-Bz112c-LgbsSe...), which is why the
// old version of this script broke. Instead we target the stable, semantic
// attribute Meet exposes for the caption panel — role="region" +
// aria-label="Captions" — and the aria-label text on the CC toggle button.
// Speaker names aren't exposed via a stable attribute, so we use a
// structural heuristic instead of a fixed class name (see parseRow below);
// this is the same approach other current Meet-caption extensions use since
// there's no other reliable hook.

let observer = null;
let debounceTimer = null;
let previousTurns = new Map(); // speaker -> last seen text for that speaker's row
let transcript = []; // [{ timestamp, speaker, text, translated }]
let weEnabledCaptions = false;
let capturing = false;

let targetLang = null; // BCP 47 code the user picked, or null for "no translation"
let languageDetector = null;
const translators = new Map(); // "src->tgt" -> Translator instance
let aiSupport = { translator: false, detector: false };

function getCaptionsContainer() {
  return document.querySelector('[role="region"][aria-label="Captions"]');
}

function getCaptionsToggleButton() {
  return document.querySelector(
    'button[aria-label="Turn on captions"], button[aria-label="Turn off captions"], button[aria-label="Captions"]'
  );
}

function captionsAreOn() {
  const btn = getCaptionsToggleButton();
  return !!btn && btn.getAttribute('aria-label') === 'Turn off captions';
}

function timestamp() {
  return new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
}

// Meet renders each currently-speaking person as their own row inside the
// captions container, usually one level (or two) of wrapper divs down. We
// don't know the exact depth or class names, so we walk down while there's
// exactly one child, then stop once we find multiple sibling rows with their
// own text — that's the actual list of per-speaker rows.
function getCaptionRows(container) {
  let level = Array.from(container.children).filter((el) => el.innerText && el.innerText.trim());
  let guard = 0;
  while (level.length === 1 && level[0].children.length && guard < 5) {
    const next = Array.from(level[0].children).filter((el) => el.innerText && el.innerText.trim());
    if (next.length <= 1) break;
    level = next;
    guard++;
  }
  return level;
}

// Within a row, Meet typically shows the speaker's name on its own short
// line above the spoken text. We treat a short, punctuation-free first line
// as the name; if that heuristic doesn't hold, we just label it "Unknown".
function parseRow(row) {
  const text = (row.innerText || '').trim();
  if (!text) return null;

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (
    lines.length >= 2 &&
    lines[0].length <= 40 &&
    lines[0].split(' ').length <= 5 &&
    !/[.?!]$/.test(lines[0])
  ) {
    return { speaker: lines[0], text: lines.slice(1).join(' ') };
  }
  return { speaker: 'Unknown', text: lines.join(' ') };
}

function checkAiSupport() {
  aiSupport = {
    translator: typeof self !== 'undefined' && 'Translator' in self,
    detector: typeof self !== 'undefined' && 'LanguageDetector' in self,
  };
}

async function getLanguageDetector() {
  if (!aiSupport.detector) return null;
  if (!languageDetector) {
    languageDetector = await LanguageDetector.create();
  }
  return languageDetector;
}

async function getTranslatorFor(sourceLanguage, targetLanguage) {
  const key = `${sourceLanguage}->${targetLanguage}`;
  if (translators.has(key)) return translators.get(key);

  const availability = await Translator.availability({ sourceLanguage, targetLanguage });
  if (availability === 'unavailable') return null;

  const translator = await Translator.create({ sourceLanguage, targetLanguage });
  translators.set(key, translator);
  return translator;
}

// Detects the line's language on-device and, if it differs from the chosen
// target language, translates it on-device. Returns null if translation
// isn't requested/available or the line is already in the target language.
async function translateLine(line) {
  if (!targetLang || !aiSupport.translator) return null;

  try {
    let sourceLang = null;
    const detector = await getLanguageDetector();
    if (detector) {
      const results = await detector.detect(line);
      if (results && results[0] && results[0].confidence > 0.4) {
        sourceLang = results[0].detectedLanguage;
      }
    }
    if (!sourceLang || sourceLang === 'und') return null;
    if (sourceLang === targetLang) return null;

    const translator = await getTranslatorFor(sourceLang, targetLang);
    if (!translator) return null;
    return await translator.translate(line);
  } catch (err) {
    console.log('Translation skipped for this line:', err);
    return null;
  }
}

async function finalizeTurn(speaker, text) {
  if (!text) return;
  const translated = await translateLine(text);
  const entry = { timestamp: timestamp(), speaker, text, translated: translated || null };
  transcript.push(entry);
  chrome.storage.local.set({ transcript });
}

// A speaker's row disappearing from the current snapshot means their turn
// finished (Meet scrolled it out / they stopped talking), so we archive it.
async function snapshotCaptions() {
  const container = getCaptionsContainer();
  if (!container) return;

  const rows = getCaptionRows(container).map(parseRow).filter(Boolean);
  const currentTurns = new Map(rows.map((r) => [r.speaker, r.text]));

  for (const [speaker, text] of previousTurns) {
    if (!currentTurns.has(speaker)) {
      await finalizeTurn(speaker, text);
    }
  }

  previousTurns = currentTurns;
}

function startCapture(requestedTargetLang) {
  if (capturing) return { ok: true, alreadyCapturing: true };

  const toggleBtn = getCaptionsToggleButton();
  if (!toggleBtn) {
    return {
      ok: false,
      error: 'Could not find the captions button — make sure you are on an active Google Meet call.',
    };
  }

  checkAiSupport();
  targetLang = requestedTargetLang || null;
  const translationRequested = !!targetLang;
  const translationAvailable = translationRequested && aiSupport.translator && aiSupport.detector;
  if (translationRequested && !translationAvailable) {
    targetLang = null; // fall back to original-language capture only
  }

  if (!captionsAreOn()) {
    toggleBtn.click();
    weEnabledCaptions = true;
  }

  transcript = [];
  previousTurns = new Map();
  chrome.storage.local.set({ transcript: [] });

  observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(snapshotCaptions, 300);
  });

  const waitForContainer = setInterval(() => {
    const container = getCaptionsContainer();
    if (container) {
      clearInterval(waitForContainer);
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    }
  }, 300);
  setTimeout(() => clearInterval(waitForContainer), 10000);

  capturing = true;
  return { ok: true, translationRequested, translationAvailable };
}

async function stopCapture() {
  if (!capturing) return { ok: true, transcript };

  clearTimeout(debounceTimer);
  if (observer) observer.disconnect();
  observer = null;

  for (const [speaker, text] of previousTurns) {
    await finalizeTurn(speaker, text);
  }
  previousTurns = new Map();

  if (weEnabledCaptions) {
    const toggleBtn = getCaptionsToggleButton();
    if (toggleBtn && captionsAreOn()) toggleBtn.click();
    weEnabledCaptions = false;
  }

  capturing = false;
  return { ok: true, transcript };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'startCapture') {
    sendResponse(startCapture(message.targetLang));
  } else if (message.type === 'stopCapture') {
    stopCapture().then(sendResponse);
    return true; // async response
  } else if (message.type === 'getStatus') {
    checkAiSupport();
    sendResponse({ capturing, transcript, aiSupport });
  }
  return true;
});
