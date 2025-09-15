// pricing.js  (complete)
// - Text/chat tokens  -> calculateCost(model, promptTokens, completionTokens, cachedTokens)
// - Audio minutes     -> calculateAudioCost({ model, minutes, io })          // io: 'input' | 'output'
// - TTS characters    -> calculateTTSCost({ model, characters })             // 'tts' | 'tts-hd'
// - Image generation  -> calculateImageCost({ model, size, quality, images })
//
// Notes:
// • TEXT_PRICING numbers are USD per 1,000 tokens (converted from per-1M rates).
// • Unknown models safely price at $0 (see calculateCost).

///////////////////////////////
// UTIL
///////////////////////////////
const clamp0 = (n) => (Number.isFinite(+n) && +n > 0 ? +n : 0);
const round  = (n, dp = 6) => Math.round((+n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const toNum  = (n) => (Number.isFinite(+n) ? +n : 0);
const formatUSD = (n) => `$${round(n, 4).toFixed(4)}`; // e.g., $0.0123

const norm = (s) => (s || '').toString().trim().toLowerCase();

///////////////////////////////
// TEXT / TOKEN PRICING (per 1K tokens)
///////////////////////////////
const TEXT_PRICING = Object.freeze({
  'gpt-4o':       { prompt: 0.0025, completion: 0.0100, cached: 0.00125 },
  'gpt-4o-mini':  { prompt: 0.0006, completion: 0.0024, cached: 0.0003 },
  'gpt-realtime': { prompt: 0.0040, completion: 0.0160, cached: 0.0004 },
});

// Map dated snapshot names → canonical keys used in TEXT_PRICING
const aliasTextModel = (m) => {
  const s = norm(m);
  if (s.startsWith('gpt-4o-mini'))     return 'gpt-4o-mini';    // e.g., gpt-4o-mini-2024-07-18
  if (s.startsWith('gpt-4o-realtime')) return 'gpt-realtime';   // e.g., gpt-4o-realtime-preview
  if (s.startsWith('gpt-4o'))          return 'gpt-4o';         // e.g., gpt-4o-2024-05-13
  return s;
};

function calcTextUSD(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0) {
  const key  = aliasTextModel(model);
  const plan = TEXT_PRICING[key] || null;
  const pTok = clamp0(promptTokens);
  const cTok = clamp0(completionTokens);
  const kTok = clamp0(cachedTokens);

  if (!plan) {
    return {
      promptUSD: 0, completionUSD: 0, cachedUSD: 0,
      total: 0, model: key, unknown: true
    };
  }

  const promptUSD     = round((pTok / 1000) * toNum(plan.prompt));
  const completionUSD = round((cTok / 1000) * toNum(plan.completion));
  const cachedUSD     = round((kTok / 1000) * toNum(plan.cached || 0));
  const total = round(promptUSD + completionUSD + cachedUSD);

  return { promptUSD, completionUSD, cachedUSD, total, model: key, unknown: false };
}

// Back-compat export used by server.js:
function calculateCost(model, promptTokens = 0, completionTokens = 0, cachedTokens = 0) {
  return calcTextUSD(model, promptTokens, completionTokens, cachedTokens);
}

///////////////////////////////
// AUDIO PRICING (per minute)
///////////////////////////////
//
// io meaning:
//  - For transcription (ASR), set io: 'input' (you pay per minute of audio in)
//  - For TTS per-minute models, set io: 'output' (you pay per minute of audio out)
const AUDIO_PER_MIN = Object.freeze({
  'gpt-4o-transcribe':       { input: 0.006 },
  'gpt-4o-mini-transcribe':  { input: 0.003 },
  'gpt-4o-mini-tts':         { output: 0.015 },
  'whisper':                 { input: 0.006 },
});

function calculateAudioCost({ model, minutes = 0, io = 'input' }) {
  const key  = norm(model);
  const plan = AUDIO_PER_MIN[key];
  if (!plan) return { total: 0, model: key, minutes: 0, io, ratePerMinute: 0, unknown: true };

  const rate = io === 'output' ? toNum(plan.output) : toNum(plan.input);
  const min  = clamp0(minutes);
  const total = round(min * rate);

  return { total, model: key, minutes: min, io, ratePerMinute: rate, unknown: false };
}

///////////////////////////////
// TTS (per character via per-million rate)
///////////////////////////////
const TTS_PER_MILLION = Object.freeze({
  'tts':    15.00,
  'tts-hd': 30.00
});

const normalizeTTSModel = (m) => (norm(m).includes('hd') ? 'tts-hd' : 'tts');

function calculateTTSCost({ model = 'tts', characters = 0 }) {
  const key  = normalizeTTSModel(model);
  const perM = toNum(TTS_PER_MILLION[key] || 0);
  const chars = Math.max(0, Math.floor(characters || 0));
  const total = round(chars * (perM / 1_000_000));
  return { total, model: key, characters: chars, ratePerMillionChars: perM };
}

///////////////////////////////
// IMAGE GENERATION PRICING (per image)
///////////////////////////////
const normImgModel = (m) => {
  const x = norm(m).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ');
  if (x.includes('gpt image 1') || x.includes('gpt-image-1')) return 'gpt image 1';
  if (x.includes('dall') && x.includes('3')) return 'dall-e 3';
  if (x.includes('dall') && x.includes('2')) return 'dall-e 2';
  return x;
};
const normQuality = (q) => norm(q);
const normSize = (w, h) => {
  if (typeof w === 'string' && w.includes('x')) return w.toLowerCase();
  if (w && h) return `${w}x${h}`.toLowerCase();
  return String(w || '').toLowerCase();
};

const IMG = Object.freeze({
  'gpt image 1': Object.freeze({
    low:    Object.freeze({ '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 }),
    medium: Object.freeze({ '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 }),
    high:   Object.freeze({ '1024x1024': 0.167, '1024x1536': 0.25,  '1536x1024': 0.25  }),
  }),
  'dall-e 3': Object.freeze({
    standard: Object.freeze({ '1024x1024': 0.04, '1024x1792': 0.08, '1792x1024': 0.08 }),
    hd:       Object.freeze({ '1024x1024': 0.08, '1024x1792': 0.12, '1792x1024': 0.12 }),
  }),
  'dall-e 2': Object.freeze({
    standard: Object.freeze({ '256x256': 0.016, '512x512': 0.018, '1024x1024': 0.02 }),
  }),
});

function getImageUnitPrice(model, size, quality) {
  const m = IMG[normImgModel(model)];
  if (!m) return 0;
  const q = m[normQuality(quality)];
  if (!q) return 0;
  return toNum(q[normSize(size)]);
}

function calculateImageCost({ model, size, quality, images = 1 }) {
  const unit  = getImageUnitPrice(model, size, quality);
  const count = Math.max(0, Math.floor(images || 0));
  const total = round(unit * count);
  return {
    total,
    model: normImgModel(model),
    size: normSize(size),
    quality: normQuality(quality),
    images: count,
    unitPrice: unit,
    unknown: unit === 0
  };
}

///////////////////////////////
// EXPORTS
///////////////////////////////
module.exports = {
  // text
  calculateCost,          // (model, promptTokens, completionTokens, cachedTokens)
  // audio
  calculateAudioCost,     // ({ model, minutes, io })
  // tts
  calculateTTSCost,       // ({ model: 'tts'|'tts-hd', characters })
  // images
  calculateImageCost,     // ({ model, size, quality, images })

  // helpers & tables
  formatUSD,
  TEXT_PRICING,
  AUDIO_PER_MIN,
  TTS_PER_MILLION,
  IMG
};
