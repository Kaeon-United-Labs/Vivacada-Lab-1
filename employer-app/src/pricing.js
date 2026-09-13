'use strict';
// A "token" here is just a relabeled cent (1 token = $0.01) — buying tokens
// credits an account's balanceCents directly. TOKEN_PRICING_MODE picks how a
// query's cost is computed, not how the balance itself is stored.
const MODE = (process.env.TOKEN_PRICING_MODE || 'flat').toLowerCase(); // 'flat' | 'metered'
const FLAT_COST_CENTS = parseInt(process.env.TOKEN_QUERY_FLAT_COST_CENTS, 10) || 25;
const INPUT_RATE = parseFloat(process.env.MODEL_COST_PER_1K_INPUT_TOKENS_CENTS) || 0.3;
const OUTPUT_RATE = parseFloat(process.env.MODEL_COST_PER_1K_OUTPUT_TOKENS_CENTS) || 1.5;
const MARKUP = parseFloat(process.env.TOKEN_MARKUP_MULTIPLIER) || 2.0;
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || 1024;

// Rough, conservative estimate — good enough for a pre-call ceiling check,
// not for the actual charge. ~4 characters per token is the standard rule of
// thumb for English text; erring high here is the safe direction.
function estimateInputTokens(text) { return Math.ceil((text || '').length / 4); }

function centsForUsage(inputTokens, outputTokens) {
  return ((inputTokens / 1000) * INPUT_RATE + (outputTokens / 1000) * OUTPUT_RATE) * MARKUP;
}

// Called BEFORE the model call. In flat mode this is just the flat fee. In
// metered mode it's a worst-case ceiling (known input size + the max_tokens
// cap we're about to pass to the model) — always >= the real eventual cost,
// so a balance that clears this check can never go negative from the query
// that follows. No overdraft/grace-period logic needed anywhere as a result.
function preCallCeilingCents(promptText) {
  if (MODE === 'flat') return Math.ceil(FLAT_COST_CENTS);
  return Math.ceil(centsForUsage(estimateInputTokens(promptText), MAX_OUTPUT_TOKENS));
}

// Called AFTER the model call, with its real reported usage (or omitted
// entirely in flat mode, where the charge never depends on usage).
function actualCostCents({ inputTokens, outputTokens }) {
  if (MODE === 'flat') return FLAT_COST_CENTS;
  return Math.ceil(centsForUsage(inputTokens || 0, outputTokens || 0));
}

module.exports = { MODE, MAX_OUTPUT_TOKENS, preCallCeilingCents, actualCostCents, estimateInputTokens };
