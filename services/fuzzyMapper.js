// services/fuzzyMapper.js
// ─────────────────────────────────────────────────────────────────
// Maps detected spreadsheet headers to internal schema fields using:
//   1. Exact synonym match       → score 1.0
//   2. Substring containment     → score 0.85
//   3. Token Jaccard similarity  → score 0.45 – 0.84
//
// No external dependencies — pure Node.js string operations.
// ─────────────────────────────────────────────────────────────────

const { SYNONYM_MAP } = require('./synonyms');

const INTERNAL_FIELDS = Object.keys(SYNONYM_MAP);

/**
 * mapHeadersFuzzy(detectedHeaders)
 * Returns a mapping of internalField → { column, score, source }
 * Only fields with score ≥ 0.45 are included.
 */
function mapHeadersFuzzy(detectedHeaders) {
  const mapping  = {};
  const usedCols = new Set();

  for (const field of INTERNAL_FIELDS) {
    const synonyms   = SYNONYM_MAP[field] || [];
    let bestScore    = 0;
    let bestCol      = null;
    let bestSource   = 'fuzzy';

    for (const col of detectedHeaders) {
      if (usedCols.has(col)) continue;

      const colClean = normalise(col);
      let   score    = 0;
      let   source   = 'fuzzy';

      for (const synonym of synonyms) {
        const synClean = normalise(synonym);

        // 1. Exact match
        if (colClean === synClean) {
          score  = 1.0;
          source = 'synonym';
          break;
        }

        // 2. Substring containment (either direction)
        if (colClean.includes(synClean) || synClean.includes(colClean)) {
          const sub = Math.max(0.82, score); // at least 0.82
          if (sub > score) { score = sub; source = 'substring'; }
        }

        // 3. Token Jaccard similarity
        const jaccard = tokenJaccard(colClean, synClean);
        if (jaccard > score) { score = jaccard; source = 'fuzzy'; }
      }

      if (score > bestScore) {
        bestScore  = score;
        bestCol    = col;
        bestSource = source;
      }

      if (bestScore === 1.0) break; // can't do better
    }

    if (bestCol && bestScore >= 0.45) {
      mapping[field] = {
        column: bestCol,
        score:  Math.round(bestScore * 1000) / 1000,
        source: bestSource,
      };
      usedCols.add(bestCol);
    }
  }

  return mapping;
}

// ── Helpers ────────────────────────────────────────────────────

/** Normalise a header for comparison: lowercase, remove punctuation */
function normalise(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * tokenJaccard(a, b)
 * Jaccard similarity on word-token sets.
 * "student name" vs "name student" → 1.0
 * "candidate id"  vs "student id"  → 0.5
 */
function tokenJaccard(a, b) {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  let intersection = 0;
  for (const token of setA) { if (setB.has(token)) intersection++; }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

module.exports = { mapHeadersFuzzy };


// ─────────────────────────────────────────────────────────────────
// services/confidence.js  (exported from same file for convenience)
// ─────────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['student_name', 'grade'];

/**
 * getConfidenceLevel(score)
 * 'high'   → score ≥ 0.85  — auto-select, no user action needed
 * 'medium' → score ≥ 0.60  — pre-select, ask user to confirm
 * 'low'    → score <  0.60  — blank, require manual selection
 */
function getConfidenceLevel(score) {
  if (score >= 0.85) return 'high';
  if (score >= 0.60) return 'medium';
  return 'low';
}

/**
 * requiresAiAssist(fuzzyMapping)
 * Returns true only when AI help would add genuine value.
 * Avoids unnecessary API calls when fuzzy matching is sufficient.
 */
function requiresAiAssist(fuzzyMapping) {
  // Any required field is missing or low confidence
  for (const field of REQUIRED_FIELDS) {
    if (!fuzzyMapping[field]) return true;
    if (getConfidenceLevel(fuzzyMapping[field].score) === 'low') return true;
  }

  // Two or more fields are medium confidence
  const mediumCount = Object.values(fuzzyMapping)
    .filter(v => getConfidenceLevel(v.score) === 'medium').length;

  return mediumCount >= 2;
}

/**
 * mergeConfidence(fuzzy, ai)
 * Combines fuzzy and AI results. Fuzzy wins if its score is higher.
 * AI fills in gaps where fuzzy found nothing.
 */
function mergeConfidence(fuzzy, ai) {
  const merged = { ...fuzzy };

  for (const [field, aiResult] of Object.entries(ai)) {
    if (!merged[field] || merged[field].score < aiResult.score) {
      merged[field] = { ...aiResult, source: 'ai' };
    }
  }

  return merged;
}

/**
 * serializeMapping(mappingWithScores)
 * Converts internal ConfidenceScore objects to JSON-safe plain objects
 * for storage in the session and transmission to the frontend.
 */
function serializeMapping(mappingWithScores) {
  const out = {};
  for (const [field, val] of Object.entries(mappingWithScores)) {
    out[field] = {
      column:     val.column,
      score:      val.score,
      source:     val.source || 'fuzzy',
      confidence: getConfidenceLevel(val.score),
    };
  }
  return out;
}

module.exports = {
  ...module.exports,
  getConfidenceLevel,
  requiresAiAssist,
  mergeConfidence,
  serializeMapping,
};
