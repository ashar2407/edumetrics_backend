// services/importer.js
// ─────────────────────────────────────────────────────────────────
// Reads a fully parsed session and writes all confirmed data to the
// database via Prisma. Processes rows in chunks (500) for performance.
// Row-level errors are collected — import never crashes on bad rows.
// ─────────────────────────────────────────────────────────────────

const { parseFile }   = require('./fileParser');
const { detectTable } = require('./tableDetector');

const CHUNK_SIZE = 500;

/**
 * importSessionData(session, prisma)
 * Returns: { imported: number, skipped: number, errors: Array }
 */
async function importSessionData(session, prisma) {
  const {
    filePath, filename, sheetName,
    headerRow, dataStartRow, dataEndRow, colIndices, headers,
    confirmedMapping, userId,
  } = session;

  // Re-read the full file (we only stored 5 sample rows in session)
  const sheets = await parseFile(filePath, filename);
  const rows   = sheets[sheetName];

  if (!rows) {
    throw new Error(`Sheet "${sheetName}" not found when re-reading file.`);
  }

  // Build a fast header → colIndex map for the confirmed mapping
  // confirmedMapping shape: { student_name: "Name", grade: "Score", ... }
  // We need to find which column index each source column corresponds to
  const headerToColIdx = {};
  headers.forEach((h, i) => {
    headerToColIdx[h] = colIndices ? colIndices[i] : i;
  });

  const imported = [];
  const errors   = [];
  let   skipped  = 0;

  // Process every data row
  for (let rowIdx = dataStartRow; rowIdx <= dataEndRow; rowIdx++) {
    const rawRow = rows[rowIdx];
    if (!rawRow || rawRow.every(c => c === '')) continue; // skip blank rows

    try {
      const record = extractRecord(rawRow, confirmedMapping, headerToColIdx, headers);

      if (!record) {
        skipped++;
        continue;
      }

      imported.push({ rowIdx, record });

    } catch (err) {
      errors.push({ row: rowIdx + 1, reason: err.message });
      skipped++;
    }
  }

  // Write to DB in chunks using Prisma
  let importedCount = 0;

  for (let i = 0; i < imported.length; i += CHUNK_SIZE) {
    const chunk = imported.slice(i, i + CHUNK_SIZE);

    const chunkErrors = await writeChunk(chunk, parseInt(userId), prisma);
    importedCount += chunk.length - chunkErrors.length;
    errors.push(...chunkErrors);
    skipped += chunkErrors.length;
  }

  return {
    imported: importedCount,
    skipped,
    errors,
  };
}

/**
 * extractRecord(rawRow, mapping, headerToColIdx, headers)
 * Returns a normalised record object or null if the row is invalid.
 */
function extractRecord(rawRow, mapping, headerToColIdx, headers) {
  const get = (field) => {
    const sourceCol = mapping[field];
    if (!sourceCol) return '';
    const colIdx = headerToColIdx[sourceCol];
    if (colIdx === undefined) return '';
    return rawRow[colIdx] || '';
  };

  // Build student name: prefer combined, fall back to first+last
  let studentName = get('student_name').trim();
  if (!studentName) {
    const first = get('first_name').trim();
    const last  = get('last_name').trim();
    if (first || last) studentName = `${first} ${last}`.trim();
  }

  if (!studentName) return null; // Can't import without a name

  // Grade: normalise to float percentage
  const rawGrade   = get('grade');
  const maxRaw     = get('max_score');
  const gradeValue = normaliseGrade(rawGrade, maxRaw);

  if (gradeValue === null) {
    throw new Error(`Unrecognised grade value: "${rawGrade}"`);
  }

  return {
    studentName,
    studentId:  get('student_id')  || null,
    subject:    get('subject')     || 'General',
    assessment: get('assessment')  || get('date') || 'Assessment',
    date:       get('date')        || null,
    teacher:    get('teacher')     || null,
    class:      get('class')       || null,
    grade:      gradeValue,
    notes:      get('notes')       || null,
  };
}

/**
 * normaliseGrade(raw, maxRaw)
 * Converts any grade representation to a float (0-100) or null.
 * Handles: "87", "87%", "43/50", "A", "A*", "7", "2:1"
 */
function normaliseGrade(raw, maxRaw) {
  if (!raw || raw.trim() === '') return null;

  const cleaned = raw.toString().trim();

  // Fraction: "43/50"
  if (cleaned.includes('/')) {
    const [num, den] = cleaned.split('/').map(p => parseFloat(p.trim()));
    if (!isNaN(num) && !isNaN(den) && den > 0) {
      return parseFloat(((num / den) * 100).toFixed(2));
    }
  }

  // Percentage: "87%" or plain "87"
  const asNum = parseFloat(cleaned.replace(/[%,]/g, ''));
  if (!isNaN(asNum)) {
    // If max_score is given, convert raw mark to percentage
    if (maxRaw) {
      const max = parseFloat(maxRaw.replace(/[^0-9.]/g, ''));
      if (!isNaN(max) && max > 0) {
        return parseFloat(((asNum / max) * 100).toFixed(2));
      }
    }
    // If value looks like a raw percentage (0-100), use as-is
    return parseFloat(asNum.toFixed(2));
  }

  // Letter grades (US)
  const letterGrades = {
    'a+': 100, 'a': 95, 'a-': 90,
    'b+': 85,  'b': 80, 'b-': 75,
    'c+': 70,  'c': 65, 'c-': 60,
    'd+': 55,  'd': 50, 'd-': 45,
    'f': 0,    'e': 40,
  };
  const letterKey = cleaned.toLowerCase();
  if (letterGrades[letterKey] !== undefined) return letterGrades[letterKey];

  // UK A-Level
  const aLevel = { 'a*': 100, 'a': 85, 'b': 70, 'c': 55, 'd': 40, 'e': 25, 'u': 0 };
  if (aLevel[letterKey] !== undefined) return aLevel[letterKey];

  // UK GCSE numeric (9-1)
  const gcseNum = parseInt(cleaned);
  if (!isNaN(gcseNum) && gcseNum >= 1 && gcseNum <= 9) {
    return Math.round((gcseNum / 9) * 100);
  }

  // UK Degree classification
  const ukDegree = {
    '1st': 85, 'first': 85, '2:1': 65, '2.1': 65,
    '2:2': 55, '2.2': 55, '3rd': 45, 'third': 45, 'fail': 0,
  };
  if (ukDegree[letterKey] !== undefined) return ukDegree[letterKey];

  return null;
}

/**
 * writeChunk(chunk, userId, prisma)
 * Upserts a chunk of records into the database.
 * Returns array of row-level errors for rows that failed.
 */
async function writeChunk(chunk, userId, prisma) {
  const chunkErrors = [];

  for (const { rowIdx, record } of chunk) {
    try {
      // 1. Find or create the Class
      const classRecord = await prisma.class.upsert({
        where:  { userId_name: { userId, name: record.subject } },
        update: {},
        create: { userId, name: record.subject },
      });

      // 2. Find or create the Student within that class
      const studentRecord = await prisma.student.upsert({
        where: {
          name_classId: { name: record.studentName, classId: classRecord.id },
        },
        update: { externalId: record.studentId || undefined },
        create: {
          classId:    classRecord.id,
          name:       record.studentName,
          externalId: record.studentId || null,
        },
      });

      // 3. Find or create the Assessment
      const assessmentRecord = await prisma.assessment.upsert({
        where:  { name_classId: { name: record.assessment, classId: classRecord.id } },
        update: { date: record.date || undefined },
        create: {
          classId: classRecord.id,
          name:    record.assessment,
          date:    record.date   || null,
          topic:   record.notes  || null,
        },
      });

      // 4. Upsert the Score (update if student retook the same assessment)
      await prisma.score.upsert({
        where: {
          studentId_assessmentId: {
            studentId:    studentRecord.id,
            assessmentId: assessmentRecord.id,
          },
        },
        update: { score: record.grade },
        create: {
          studentId:    studentRecord.id,
          assessmentId: assessmentRecord.id,
          score:        record.grade,
        },
      });

    } catch (err) {
      chunkErrors.push({
        row:    rowIdx + 1,
        reason: `DB write failed: ${err.message}`,
        data:   record.studentName,
      });
    }
  }

  return chunkErrors;
}

module.exports = { importSessionData };
