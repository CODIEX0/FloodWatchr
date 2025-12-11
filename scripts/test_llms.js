#!/usr/bin/env node
// Quick test script to verify Gemini keys from web/.env.local
// This prints concise responses but never echoes API keys.
const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = {};
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx+1).trim();
    out[key] = val;
  }
  return out;
}

function pickKey(env, ...candidates) {
  for (const k of candidates) if (env[k]) return env[k];
  return null;
}

function sanitizeBlock(text) {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```json\s*/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
  }
  return trimmed;
}

async function callGeminiRisk(apiKey) {
  if (!apiKey) {
    console.log('Gemini: No API key found, skipping.');
    return;
  }
  const prompt = `You are an experienced flood-risk analyst. Return only JSON {"riskLevel":"Low|Medium|High","explanation":"short"} for the inputs.`;
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  try {
    const res = await fetch(endpoint + `?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nSample:\ndistance_cm: 45\nrainfall_mm: 18\nhumidity: 87\ntemp: 16\ntrend: rising` }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      console.log(`Gemini: HTTP ${res.status} ${res.statusText}`);
      const txt = await res.text();
      if (txt) console.log('Gemini response body (trim):', txt.slice(0, 400));
      return;
    }
  const payload = await res.json();
  const text = sanitizeBlock(payload?.candidates?.[0]?.content?.parts?.[0]?.text || '');
    if (!text) { console.log('Gemini: Empty response'); return; }
    console.log('Gemini (risk) raw (trimmed):', text.slice(0, 1000));
    try {
      const parsed = JSON.parse(text);
      console.log('Gemini parsed:', { riskLevel: parsed.riskLevel, explanation: parsed.explanation });
    } catch (err) {
      console.log('Gemini: Failed to parse JSON — showing raw response snippet:');
      console.log(text.slice(0, 1000));
    }
  } catch (err) {
    console.log('Gemini: Request failed', err && err.message ? err.message : err);
  }
}

async function callGeminiSummary(apiKey) {
  if (!apiKey) {
    console.log('Gemini summary: No API key found, skipping.');
    return;
  }

  const prompt = `You are summarising a live flood monitoring feed for emergency teams. Provide:
1. A bold markdown headline describing the situation in <= 120 characters.
2. A short bullet list (2 bullets) of recommended actions written in markdown.
Respond ONLY in markdown with the headline on the first line followed by the list. Avoid extra commentary.

Context:
- Flood severity level (1-3): 2
- Current water height (cm): 82
- Distance to sensor (cm): 40
- Rainfall in last hour (mm): 22
- Recent alerts:
- sensorA (warning) -> 82 at 2025-11-19T10:00:00Z
- sensorB (info) -> 40 at 2025-11-19T09:55:00Z`;

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  try {
    const res = await fetch(endpoint + `?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35 },
      }),
    });

    if (!res.ok) {
      console.log(`Gemini summary: HTTP ${res.status} ${res.statusText}`);
      const txt = await res.text();
      if (txt) console.log('Gemini summary body (trim):', txt.slice(0, 400));
      return;
    }

    const payload = await res.json();
    const text = (payload?.candidates?.[0]?.content?.parts?.map(part => part.text?.trim() ?? '').join('\n') || '').trim();
    if (!text) {
      console.log('Gemini summary: Empty response');
      return;
    }
    console.log('Gemini summary (trimmed):\n', text.slice(0, 800));
  } catch (err) {
    console.log('Gemini summary: Request failed', err && err.message ? err.message : err);
  }
}

async function main() {
  const envPath = path.join(__dirname, '..', 'web', '.env.local');
  const env = loadEnv(envPath);
  const geminiKey = pickKey(env, 'GEMINI_API_KEY');

  console.log('Found keys:', {
    gemini: !!geminiKey,
    note: 'Script never prints key contents.'
  });

  await callGeminiRisk(geminiKey);
  await callGeminiSummary(geminiKey);
}

// Node global fetch is available in Node 18+. If not, warn.
if (typeof fetch === 'undefined') {
  console.error('Global fetch is not available in this Node runtime. Use Node 18+ or install a fetch polyfill.');
  process.exit(1);
}

main().catch(err => { console.error('Script error:', err); process.exit(2); });
