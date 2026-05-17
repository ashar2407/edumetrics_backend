// services/tableDetector.js
// ─────────────────────────────────────────────────────────────────
// Finds the primary data table inside a sheet's 2D grid.
// Handles: title rows, blank separators, notes, multi-table sheets.
// Pure heuristics — no AI calls here.
// ─────────────────────────────────────────────────────────────────

const HEADER_KEYWORDS = new Set([
  'name', 'id', 'score', 'grade', 'mark', 'result', 'subject',
  'class', 'student', 'pupil', 'candidate', 'date', 'assessment',
  'teacher', 'course', 'percentage', 'attendance', 'topic', 'learner',
  'first', 'last', 'surname', 'forename', 'module', 'unit', 'test',
  'exam', 'assignment', 'total', 'average', 'group', 'form', 'year',
  'ref', 'reference', 'number', 'upn', 'urn', 'code',
]);

const DATA_SHEET_KEYWORDS = new Set([
  'student', 'grade', 'mark', 'score', 'result', 'class', 'name',
  'data', 'report', 'assessment', 'roster', 'gradebook', 'record',
]);

/**
 * detectTable(sheetName, rows)
 * rows: string[][] — the raw 2D grid from fileParser
 *
 * Returns: {
 *   sheetName, headerRow (index), dataStartRow, dataEndRow,
 *   headers (string[]), sampleRows (object[])
 * } | null
 */
function detectTable(sheetName, rows) {
  if (!rows || rows.length < 2) return null;

  // Step 1: Score every row by "density" = fraction of non-empty cells
  const densities = rows.map((row, i) => ({
    index: i,
    density: row.length === 0 ? 0 : row.filter(c => c !== '').length / row.length,
    row,
  }));

  // Step 2: Find the first dense region (density > 35%)
  const DENSITY_THRESHOLD = 0.35;
  const firstDenseRow = densities.find(d => d.density >= DENSITY_THRESHOLD);
  if (!firstDenseRow) return null;

  const searchStart = firstDenseRow.index;

  // Step 3: Find the best header row in the first 25 rows from the dense region
  const headerRowIndex = findHeaderRow(rows, searchStart, Math.min(searchStart + 25, rows.length));
  if (headerRowIndex === null) return null;

  // Step 4: Extract and clean headers
  const rawHeaders = rows[headerRowIndex];
  const headers    = deduplicateHeaders(rawHeaders.filter((_, i) =>
    // Keep only columns that have any data in the rows beneath them
    hasDataBelow(rows, headerRowIndex + 1, i)
  ));

  if (headers.length < 2) return null;

  // Rebuild column indices after filtering
  const colIndices = rawHeaders
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => hasDataBelow(rows, headerRowIndex + 1, i))
    .map(({ i }) => i);

  // Step 5: Find data end (stop at 3+ consecutive empty rows)
  const dataStart = headerRowIndex + 1;
  const dataEnd   = findDataEnd(rows, dataStart);

  if (dataEnd <= dataStart) return null;

  // Step 6: Build sample rows as objects keyed by header name
  const sampleRows = [];
  for (let r = dataStart; r < Math.min(dataStart + 10, dataEnd + 1); r++) {
    const row = rows[r];
    if (row.every(c => c === '')) continue; // skip blank rows in sample

    const obj = {};
    headers.forEach((h, idx) => {
      const colIdx = colIndices[idx];
      obj[h] = row[colIdx] !== undefined ? row[colIdx] : '';
    });
    sampleRows.push(obj);
    if (sampleRows.length >= 5) break;
  }

  return {
    sheetName,
    headerRow:    headerRowIndex,
    dataStartRow: dataStart,
    dataEndRow:   dataEnd,
    colIndices,
    headers,
    sampleRows,
  };
}

/**
 * findHeaderRow(rows, searchStart, searchEnd)
 * Scores candidate rows. A real header row has:
 *   - Multiple keyword matches
 *   - Mostly text cells (not numbers)
 *   - Good density
 *   - Comes before rows that contain numeric data
 */
function findHeaderRow(rows, searchStart, searchEnd) {
  let bestScore = -1;
  let bestRow   = null;

  for (let i = searchStart; i < Math.min(searchEnd, rows.length); i++) {
    const row   = rows[i];
    const cells = row.filter(c => c !== '');
    if (cells.length < 2) continue;

    // Keyword score
    const keywordHits = cells.filter(c =>
      HEADER_KEYWORDS.has(c.toLowerCase().replace(/[^a-z]/g, '')) ||
      [...HEADER_KEYWORDS].some(kw => c.toLowerCase().includes(kw))
    ).length;

    // Text ratio (headers are usually all text)
    const textCount = cells.filter(c => !isNumericLike(c)).length;
    const textRatio = textCount / cells.length;

    // Penalise rows that look like data (e.g. all numbers)
    const numericPenalty = (1 - textRatio) * cells.length;

    const score = keywordHits * 4 + textCount - numericPenalty;

    if (score > bestScore && score > 0) {
      bestScore = score;
      bestRow   = i;
    }
  }

  return bestRow;
}

/**
 * findDataEnd(rows, dataStart)
 * Walk down from dataStart. Stop when we see 3+ consecutive blank rows,
 * which signals end of table or start of a footer note section.
 */
function findDataEnd(rows, dataStart) {
  let end              = dataStart - 1;
  let consecutiveEmpty = 0;

  for (let i = dataStart; i < rows.length; i++) {
    const isEmpty = rows[i].every(c => c === '');
    if (isEmpty) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
    } else {
      consecutiveEmpty = 0;
      end = i;
    }
  }

  return end;
}

/**
 * hasDataBelow(rows, startRow, colIdx)
 * Returns true if any cell in column colIdx below startRow has content.
 * Used to filter out decorative columns.
 */
function hasDataBelow(rows, startRow, colIdx) {
  for (let r = startRow; r < Math.min(startRow + 20, rows.length); r++) {
    if (rows[r][colIdx] && rows[r][colIdx] !== '') return true;
  }
  return false;
}

/**
 * deduplicateHeaders(headers)
 * Handles duplicate column names (common with merged cells or
 * copy-paste artifacts). Appends _2, _3 etc.
 */
function deduplicateHeaders(headers) {
  const seen   = {};
  const result = [];

  for (const h of headers) {
    const clean = h.trim() || `_col_${result.length}`;
    if (seen[clean] !== undefined) {
      seen[clean]++;
      result.push(`${clean}_${seen[clean]}`);
    } else {
      seen[clean] = 1;
      result.push(clean);
    }
  }

  return result;
}

/**
 * pickBestSheet(sheets)
 * When there are multiple sheets, score them by:
 *   - How many education keywords appear in the first 10 rows
 *   - How many rows × columns of data they contain
 */
function pickBestSheet(sheets) {
  let bestScore = -1;
  let bestName  = Object.keys(sheets)[0];

  for (const [name, rows] of Object.entries(sheets)) {
    if (!rows || rows.length === 0) continue;

    const preview = rows.slice(0, 10).flat().join(' ').toLowerCase();
    const keywordScore = [...DATA_SHEET_KEYWORDS]
      .filter(kw => preview.includes(kw)).length;

    const sizeScore = Math.min(rows.length * (rows[0]?.length || 0), 5000) / 5000;

    const score = keywordScore * 10 + sizeScore * 5;

    if (score > bestScore) {
      bestScore = score;
      bestName  = name;
    }
  }

  return bestName;
}

function isNumericLike(val) {
  return !isNaN(parseFloat(val.replace(/[%,$,£,€]/g, '')));
}

module.exports = { detectTable, pickBestSheet };
