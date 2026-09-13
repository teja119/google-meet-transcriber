document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startCapture');
  const stopBtn = document.getElementById('stopCapture');
  const statusEl = document.getElementById('status');
  const langSelect = document.getElementById('targetLang');
  const groqKeyInput = document.getElementById('groqKey');
  const saveKeyBtn = document.getElementById('saveKey');
  const summarizeBtn = document.getElementById('summarize');
  const summaryResultEl = document.getElementById('summaryResult');
  const downloadSummaryBtn = document.getElementById('downloadSummary');

  const GROQ_MODEL = 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile was retired by Groq in Aug 2026
  let lastSummaryText = '';

  // Languages supported by Chrome's built-in Translator API.
  // https://developer.chrome.com/docs/ai/translator-api#supported_languages
  const LANGUAGES = [
    ['ar', 'Arabic'], ['bg', 'Bulgarian'], ['bn', 'Bengali'], ['cs', 'Czech'],
    ['da', 'Danish'], ['de', 'German'], ['el', 'Greek'], ['en', 'English'],
    ['es', 'Spanish'], ['fi', 'Finnish'], ['fr', 'French'], ['he', 'Hebrew'],
    ['hi', 'Hindi'], ['hr', 'Croatian'], ['hu', 'Hungarian'], ['id', 'Indonesian'],
    ['it', 'Italian'], ['ja', 'Japanese'], ['kn', 'Kannada'], ['ko', 'Korean'],
    ['lt', 'Lithuanian'], ['mr', 'Marathi'], ['nl', 'Dutch'], ['no', 'Norwegian'],
    ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'],
    ['sk', 'Slovak'], ['sl', 'Slovenian'], ['sv', 'Swedish'], ['ta', 'Tamil'],
    ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'],
    ['vi', 'Vietnamese'], ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
  ];
  LANGUAGES.forEach(([code, name]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    langSelect.appendChild(opt);
  });

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function withActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes('meet.google.com')) {
        setStatus('Open a Google Meet call first.');
        return;
      }
      callback(tab);
    });
  }

  function sendToContent(tabId, message, onDone) {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        setStatus('Could not reach the Meet tab — try refreshing it, then reopen this popup.');
        return;
      }
      onDone(response);
    });
  }

  function turnsToLines(turns) {
    return (turns || []).map((t) => {
      let line = `${t.timestamp}: ${t.speaker}: ${t.text}`;
      if (t.translated) line += `\n    ↳ ${t.translated}`;
      return line;
    });
  }

  function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  startBtn.addEventListener('click', () => {
    withActiveTab((tab) => {
      const targetLang = langSelect.value || null;
      sendToContent(tab.id, { type: 'startCapture', targetLang }, (response) => {
        if (!response || !response.ok) {
          setStatus((response && response.error) || 'Could not start capture.');
          return;
        }
        if (response.translationRequested && !response.translationAvailable) {
          setStatus(
            "Capturing (translation needs Chrome 138+ on desktop — this browser doesn't support it, so only the original captions were saved)."
          );
        } else if (response.translationRequested) {
          setStatus('Capturing & translating captions… (first use may pause briefly to download the language model)');
        } else {
          setStatus('Capturing captions…');
        }
      });
    });
  });

  stopBtn.addEventListener('click', () => {
    withActiveTab((tab) => {
      setStatus('Stopping…');
      sendToContent(tab.id, { type: 'stopCapture' }, (response) => {
        if (response && response.ok) {
          const lines = turnsToLines(response.transcript);
          if (!lines.length) {
            setStatus('No captions were captured.');
            return;
          }
          setStatus('Stopped. Downloading transcript…');
          downloadTextFile(lines.join('\n'), `meet-transcript-${Date.now()}.txt`);
          setStatus('Transcript downloaded. You can now Summarize by Speaker.');
        } else {
          setStatus('Could not stop capture.');
        }
      });
    });
  });

  // Reflect current state whenever the popup is (re)opened.
  withActiveTab((tab) => {
    sendToContent(tab.id, { type: 'getStatus' }, (response) => {
      if (response && response.capturing) setStatus('Capturing captions…');
    });
  });

  // --- Groq API key storage ---
  chrome.storage.local.get('groqApiKey', (data) => {
    if (data && data.groqApiKey) groqKeyInput.value = data.groqApiKey;
  });

  saveKeyBtn.addEventListener('click', () => {
    const key = groqKeyInput.value.trim();
    chrome.storage.local.set({ groqApiKey: key }, () => {
      setStatus(key ? 'Groq API key saved.' : 'Groq API key cleared.');
    });
  });

  // --- Speaker-wise summary via Groq ---
  summarizeBtn.addEventListener('click', () => {
    chrome.storage.local.get(['transcript', 'groqApiKey'], async (data) => {
      const transcript = data.transcript || [];
      const apiKey = data.groqApiKey;

      if (!transcript.length) {
        setStatus('No captured captions yet — start and stop a capture first.');
        return;
      }
      if (!apiKey) {
        setStatus('Add your Groq API key above first (free at console.groq.com/keys).');
        document.getElementById('settingsDetails').open = true;
        return;
      }

      summaryResultEl.style.display = 'none';
      downloadSummaryBtn.style.display = 'none';
      setStatus('Asking Groq for a speaker-wise summary…');

      const transcriptText = transcript
        .map((t) => `${t.speaker}: ${t.text}`)
        .join('\n');

      const systemPrompt =
        'You summarize meeting transcripts. Respond ONLY with valid JSON matching this shape: ' +
        '{"speakers":[{"name":"string","points":["string", "..."]}],"overall":"string"}. ' +
        'Group points by speaker based on what they said. Keep each point short (under 15 words). ' +
        'The "overall" field is a 2-4 sentence summary of the whole meeting. Do not include markdown or code fences.';

      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Transcript:\n${transcriptText}` },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.3,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 200)}`);
        }

        const data2 = await res.json();
        const raw = data2.choices && data2.choices[0] && data2.choices[0].message && data2.choices[0].message.content;
        if (!raw) throw new Error('Empty response from Groq.');

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          // Model didn't return clean JSON — show the raw text instead of failing silently.
          lastSummaryText = raw;
          summaryResultEl.textContent = raw;
          summaryResultEl.style.display = 'block';
          downloadSummaryBtn.style.display = 'block';
          setStatus('Summary ready (unstructured — model did not return valid JSON).');
          return;
        }

        const parts = [];
        (parsed.speakers || []).forEach((s) => {
          parts.push(`${s.name}\n${'-'.repeat(s.name.length)}`);
          (s.points || []).forEach((p) => parts.push(`• ${p}`));
          parts.push('');
        });
        parts.push('Overall Summary\n---------------');
        parts.push(parsed.overall || '');

        lastSummaryText = parts.join('\n');
        summaryResultEl.textContent = lastSummaryText;
        summaryResultEl.style.display = 'block';
        downloadSummaryBtn.style.display = 'block';
        setStatus('Speaker-wise summary ready.');
      } catch (err) {
        console.log(err);
        setStatus(`Could not generate summary: ${err.message}`);
      }
    });
  });

  downloadSummaryBtn.addEventListener('click', () => {
    if (!lastSummaryText) return;
    downloadTextFile(lastSummaryText, `meet-summary-${Date.now()}.txt`);
  });
});
