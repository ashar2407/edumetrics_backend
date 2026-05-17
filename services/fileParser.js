// services/fileParser.js
// ─────────────────────────────────────────────────────────────────
// Reads .xlsx, .xls, and .csv files into raw JavaScript arrays.
// Everything is returned as strings — type coercion happens later
// in the importer so we never silently corrupt data.
// ─────────────────────────────────────────────────────────────────

const XLSX = require('xlsx');
const path = require('path');

/**
 * parseFile(filePath, originalName)
 * Returns: { [sheetName]: rows[] }
 * where rows is an array of arrays (2D grid), all values as strings.
 */
async function parseFile(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();

  if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
    throw new Error(`Unsupported file type: "${ext}"`);
  }

  let workbook;

  try {
    // SheetJS handles all three formats; raw:true keeps values as-is
    workbook = XLSX.readFile(filePath, {
      type:       'file',
      raw:        false,       // format dates as strings
      cellText:   true,        // use formatted text not formula results
      cellDates:  false,       // keep dates as text strings
      dense:      false,
      defval:     '',          // empty cells → '' not undefined
    });
  } catch (err) {
    throw new Error(
      'Could not read the file. It may be password-protected, corrupted, '
    + 'or in an unsupported format. Error: ' + err.message
    );
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('The file contains no sheets.');
  }

  const sheets = {};

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];

    if (!ws || !ws['!ref']) {
      // Empty sheet — skip but record it exists
      sheets[sheetName] = [];
      continue;
    }

    // Unmerge cells: fill merged ranges with the top-left value
    // so our table detector doesn't see phantom blanks
    unmergeSheet(ws);

    // Convert to array-of-arrays: each inner array is one row
    // header: 1 → raw 2D array, defval: '' → no undefined cells
    const aoa = XLSX.utils.sheet_to_json(ws, {
      header:  1,
      defval:  '',
      raw:     false,
      blankrows: true,  // keep blank rows so table detector sees them
    });

    // Normalise: every cell to trimmed string
    sheets[sheetName] = aoa.map(row =>
      (row || []).map(cell => String(cell == null ? '' : cell).trim())
    );
  }

  return sheets;
}

/**
 * unmergeSheet(worksheet)
 * SheetJS leaves merged cells with only the top-left populated.
 * We propagate that value across the entire merged range so our
 * table detector doesn't interpret blanks as empty columns.
 */
function unmergeSheet(ws) {
  const merges = ws['!merges'];
  if (!merges) return;

  for (const merge of merges) {
    // Get the top-left cell's value
    const topLeft = ws[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })];
    if (!topLeft) continue;

    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r === merge.s.r && c === merge.s.c) continue; // skip origin
        const addr = XLSX.utils.encode_cell({ r, c });
        ws[addr] = { ...topLeft };
      }
    }
  }
}

module.exports = { parseFile };
