// pricing.js
// Prices are per 1M tokens from OpenAI docs.
// Divide token counts by 1,000,000 when calculating.

const MODEL_PRICING = {
  "gpt-5":        { input: 1.25,  cached: 0.125, output: 10.00 },
  "gpt-5-mini":   { input: 0.25,  cached: 0.025, output: 2.00 },
  "gpt-5-nano":   { input: 0.05,  cached: 0.005, output: 0.40 },
  "gpt-4.1":      { input: 2.00,  cached: 0.50,  output: 8.00 },
  "gpt-4.1-mini": { input: 0.40,  cached: 0.10,  output: 1.60 },
  "gpt-4.1-nano": { input: 0.10,  cached: 0.025, output: 0.40 },
  "gpt-4o":       { input: 2.50,  cached: 1.25,  output: 10.00 },
  "gpt-4o-mini":  { input: 0.15,  cached: 0.075, output: 0.60 },
  "gpt-3.5-turbo":{ input: 0.50,  cached: 0.00,  output: 1.50 },
  "o1":           { input: 15.00, cached: 7.50,  output: 60.00 },
  "o1-pro":       { input: 150.0, cached: 0.00,  output: 600.0 },
  "o3":           { input: 2.00,  cached: 0.50,  output: 8.00 },
  "o4-mini":      { input: 1.10,  cached: 0.275, output: 4.40 },
  // add others as needed
};

/**
 * Calculate cost in USD for a given model + token usage.
 */
function calculateCost(model, promptTokens, completionTokens, cachedTokens = 0) {
  const key = Object.keys(MODEL_PRICING).find(k => model.startsWith(k));
  if (!key) {
    console.warn(`⚠️ No pricing found for model ${model}, defaulting to $0`);
    return { inputCost: 0, cachedCost: 0, outputCost: 0, total: 0 };
  }

  const m = MODEL_PRICING[key];

  const inputCost  = (promptTokens     / 1_000_000) * m.input;
  const cachedCost = (cachedTokens     / 1_000_000) * (m.cached || 0);
  const outputCost = (completionTokens / 1_000_000) * m.output;

  return {
    inputCost,
    cachedCost,
    outputCost,
    total: inputCost + cachedCost + outputCost
  };
}

module.exports = { calculateCost };
