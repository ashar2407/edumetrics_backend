// services/importer.js
// ─────────────────────────────────────────────────────────────────
// Reads a fully parsed session and writes all confirmed data to the
// database via Prisma. Processes rows in chunks (500) for performance.
// Row-level errors are collected — import never crashes on bad rows.
// ─────────────────────────────────────────────────────────────────

const { parseFile }   = require('./fileParser');
const { detectTable } = require('./tableDetector');

const CONCURRENCY = 25; // parallel score upserts per batch

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

  // ── Phase 1: Pre-create all unique Classes (O(unique subjects) DB calls)
  // Classes repeat across every row — cache them upfront instead of
  // re-upserting on every single row.
  const uniqueSubjects = [...new Set(imported.map(r => r.record.subject))];
  const classMap = new Map(); // subject → classId

  for (const subject of uniqueSubjects) {
    const cls = await prisma.class.upsert({
      where:  { userId_name: { userId: String(userId), name: subject } },
      update: {},
      create: { userId: String(userId), name: subject },
      select: { id: true },
    });
    classMap.set(subject, cls.id);
  }

  // ── Phase 2: Pre-create all unique Assessments (O(unique assessments) calls)
  const uniqueAssessmentKeys = new Map(); // `classId:name` → { classId, name, date, notes }
  for (const { record } of imported) {
    const classId = classMap.get(record.subject);
    const key = `${classId}:${record.assessment}`;
    if (!uniqueAssessmentKeys.has(key)) {
      uniqueAssessmentKeys.set(key, { classId, name: record.assessment, date: record.date, notes: record.notes });
    }
  }

  const assessmentMap = new Map(); // `classId:name` → assessmentId
  for (const [key, { classId, name, date, notes }] of uniqueAssessmentKeys) {
    const a = await prisma.assessment.upsert({
      where:  { name_classId: { name, classId } },
      update: { date: date || undefined },
      create: { classId, name, date: date || null, topic: notes || null },
      select: { id: true },
    });
    assessmentMap.set(key, a.id);
  }

  // ── Phase 3: Batch-create Students per class, then fetch their IDs in bulk
  // createMany + skipDuplicates is far faster than N individual upserts.
  // We then fetch all IDs in a single query per class.
  const studentMap = new Map(); // `classId:name` → studentId

  // Group by classId to keep createMany payloads scoped
  const studentsByClass = new Map();
  for (const { record } of imported) {
    const classId = classMap.get(record.subject);
    if (!studentsByClass.has(classId)) studentsByClass.set(classId, new Map());
    const key = record.studentName;
    if (!studentsByClass.get(classId).has(key)) {
      studentsByClass.get(classId).set(key, {
        classId,
        name:       record.studentName,
        externalId: record.studentId || null,
      });
    }
  }

  for (const [classId, studentsForClass] of studentsByClass) {
    const studentRows = [...studentsForClass.values()];

    // Insert any that don't exist yet (existing ones silently skipped)
    await prisma.student.createMany({ data: studentRows, skipDuplicates: true });

    // Fetch all IDs for this class in one query
    const fetched = await prisma.student.findMany({
      where:  { classId, name: { in: studentRows.map(s => s.name) } },
      select: { id: true, name: true },
    });
    for (const s of fetched) {
      studentMap.set(`${classId}:${s.name}`, s.id);
    }
  }

  // ── Phase 4: Parallel Score upserts in batches of CONCURRENCY
  // Scores are unique per (student, assessment) so we can't skip them —
  // a re-import should update the grade. Run in parallel groups to avoid
  // overwhelming the connection pool.
  let importedCount = 0;

  const scoreJobs = [];
  for (const { rowIdx, record } of imported) {
    const classId      = classMap.get(record.subject);
    const studentId    = studentMap.get(`${classId}:${record.studentName}`);
    const assessmentId = assessmentMap.get(`${classId}:${record.assessment}`);

    if (!studentId || !assessmentId) {
      errors.push({ row: rowIdx + 1, reason: 'Could not resolve student or assessment — row skipped.' });
      skipped++;
      continue;
    }

    scoreJobs.push({ rowIdx, studentId, assessmentId, score: record.grade });
  }

  for (let i = 0; i < scoreJobs.length; i += CONCURRENCY) {
    const batch = scoreJobs.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map(({ rowIdx, studentId, assessmentId, score }) =>
        prisma.score.upsert({
          where:  { studentId_assessmentId: { studentId, assessmentId } },
          update: { score },
          create: { studentId, assessmentId, score },
        })
        .then(() => null)
        .catch(err => ({ row: rowIdx + 1, reason: `Score write failed: ${err.message}` }))
      )
    );

    for (const result of results) {
      if (result) { errors.push(result); skipped++; }
      else        { importedCount++; }
    }
  }

  return { imported: importedCount, skipped, errors };
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

module.exports = { importSessionData };
