/**
 * Claude-generated executive commentary for the monthly investor report.
 * Sends the fully-computed ReportPayload as structured data and asks Claude
 * to write investor-facing prose from it. Throws on any failure (missing key,
 * network error, malformed response) — the caller (pdf-report.ts) is
 * responsible for falling back to the rule-based generateCommentary().
 */

import { ReportPayload } from './report-types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 45_000;

function buildPrompt(payload: ReportPayload): string {
  return `You are writing the Executive Summary section of a monthly investor report for "Shannon's Demon," \
a volatility-harvesting rebalancing strategy that mechanically rebalances a 50% ${payload.baseAsset} / 50% BRL \
portfolio whenever drift from that target exceeds an adaptive threshold, harvesting a return from price \
oscillation rather than from forecasting direction.

Below is the complete, already-computed structured performance data for ${payload.monthly.reportLabel}, as JSON. \
Write 3-5 short paragraphs of plain-English, investor-facing commentary based ONLY on this data.

Rules:
- Tone: measured, analytical, hedge-fund-letter style. Confident but not promotional. No hype, no emoji.
- Be factually precise. Every number you cite must come directly from the JSON below — never invent, round
  loosely, or extrapolate a figure that isn't present.
- Cover, in order: (1) this month's portfolio return vs. the base asset's own price move, and what that
  implies about market conditions (trending vs. mean-reverting); (2) rebalancing activity this month and what
  it cost in fees; (3) how this month fits into the cumulative track record (CAGR, Sharpe, max drawdown);
  (4) anything notable in the tax/unrealized-gain situation, only if it's actually notable.
- If a benchmark (CDI or IBOV) is unavailable in the data, do not mention it.
- If "monthly.isSparse" is true, lead with a caveat that this is a partial month and figures should be read
  with that in mind.
- Output plain prose paragraphs separated by a single blank line. No markdown headers, no bullet lists, no
  bold/italic markup, no preamble like "Here is the commentary" — just the paragraphs themselves.

DATA:
${JSON.stringify(payload, null, 2)}`;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
}

export async function generateClaudeCommentary(payload: ReportPayload): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — skipping Claude commentary');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: buildPrompt(payload) }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API returned ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    const text = data.content?.find((b) => b.type === 'text')?.text?.trim();
    if (!text) {
      throw new Error('Anthropic API response contained no text content');
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
