const MODEL_CAPABILITIES = {
  'anthropic/claude-haiku-4-5-20251001': { supportsCaching: true },
  'anthropic/claude-sonnet-4-6': { supportsCaching: true },
  'anthropic/claude-opus-4-6': { supportsCaching: true },
};

let pendingController = null;

async function runCleanup(apiKey, { systemPrompt, userMessage, model, timeoutMs }) {
  if (pendingController) {
    pendingController.abort();
    pendingController = null;
  }

  const controller = new AbortController();
  pendingController = controller;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const capabilities = MODEL_CAPABILITIES[model] || { supportsCaching: false };

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    if (capabilities.supportsCaching) {
      messages[0] = {
        role: 'system',
        content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      };
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://adamwispr.local',
        'X-Title': 'AdamWispr',
      },
      body: JSON.stringify({ model, messages, max_tokens: 2000, temperature: 0.1 }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown');
      return {
        cleanedText: '',
        status: 'error',
        errorMessage: `API error ${response.status}: ${errorBody}`,
      };
    }

    const data = await response.json();
    const cleanedText = data.choices?.[0]?.message?.content?.trim();
    return {
      cleanedText: cleanedText || '',
      status: cleanedText ? 'success' : 'error',
      errorMessage: cleanedText ? undefined : 'Empty response',
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return {
        cleanedText: '',
        status: 'timeout',
        errorMessage: `Timed out after ${timeoutMs}ms`,
      };
    }
    return { cleanedText: '', status: 'error', errorMessage: err.message };
  } finally {
    pendingController = null;
  }
}

async function autoCategorize(apiKey, { appName, url, categories, model }) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 20,
        temperature: 0,
        messages: [{
          role: 'user',
          content: `Categorize this app/website into one of these categories: ${categories.join(', ')}\n\nApp: ${appName}${url ? `\nURL: ${url}` : ''}\n\nReply with ONLY the category name.`,
        }],
      }),
    });
    const data = await response.json();
    const cat = data.choices?.[0]?.message?.content?.trim();
    return (cat && categories.includes(cat)) ? cat : null;
  } catch {
    return null;
  }
}

module.exports = { runCleanup, autoCategorize };
