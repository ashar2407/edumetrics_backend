// services/aiMapper.js
// ─────────────────────────────────────────────────────────────────
// Uses Claude to map ambiguous spreadsheet headers to internal fields.
// Called ONLY when fuzzyMapper.js cannot confidently map required fields.
// Failure is non-fatal — the system falls back to fuzzy-only results.
// ─────────────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are a data schema expert helping educators import gradebook spreadsheets.

Your job is to map spreadsheet column headers to a fixed internal schema.

Internal schema fields:
- student_name   : Full name of the student
- first_name     : Student's first/given name (if split from last name)
- last_name      : Student's surname/family name (if split from first name)
- student_id     : Unique student identifier (UPN, ref number, admission number, etc.)
- grade          : The numeric score, percentage, mark, or letter grade achieved
- max_score      : The maximum possible score for the assessment (e.g. "out of 100")
- subject        : The subject, course, or module name
- assessment     : The name of the test, exam, or assignment
- date           : Date of the test, submission, or reporting period
- teacher        : The teacher or instructor's name
- class          : Class, form group, set, or cohort
- attendance     : Attendance percentage or session count
- notes          : Free-text comments or remarks

Rules:
- Only map a column if you are at least 40% confident
- A column can only map to ONE field
- Consider the sample data values, not just the header name
- Return ONLY valid JSON. No explanation, no markdown, no prose.`;

const USER_PROMPT_TEMPLATE = (headers, sampleRows) => `
Spreadsheet column headers: ${JSON.stringify(headers)}

Sample data (first 3 rows):
${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

Map these headers to the internal schema. Return a JSON object:
{
  "student_name": { "column": "<exact header name>", "confidence": 0.97 },
  "grade":        { "column": "<exact header name>", "confidence": 0.88 },
  ...
}

Include only fields you can map with at least 0.40 confidence.
Use the exact header string as the "column" value.`;

/**
 * aiMapHeaders(headers, sampleRows)
 * Returns a mapping of internalField → { column, score, source }
 * or empty object on failure.
 */
async function aiMapHeaders(headers, sampleRows) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[aiMapper] ANTHROPIC_API_KEY not set — skipping AI mapping');
    return {};
  }

  try {
    const message = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 600,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: USER_PROMPT_TEMPLATE(headers, sampleRows),
      }],
    });

    const raw = message.content[0]?.text?.trim() || '';

    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    // Convert to our internal format with validation
    const result = {};
    for (const [field, val] of Object.entries(parsed)) {
      if (
        val &&
        typeof val.column === 'string' &&
        typeof val.confidence === 'number' &&
        val.confidence >= 0.4 &&
        headers.includes(val.column) // only accept real column names
      ) {
        result[field] = {
          column: val.column,
          score:  Math.min(1, Math.max(0, val.confidence)),
          source: 'ai',
        };
      }
    }

    return result;

  } catch (err) {
    // AI failure is never fatal — fuzzy-only results are used instead
    console.warn('[aiMapper] AI mapping failed:', err.message);
    return {};
  }
}

// Re-export requiresAiAssist so the router only needs one import
const { requiresAiAssist } = require('./fuzzyMapper');

module.exports = { aiMapHeaders, requiresAiAssist };
