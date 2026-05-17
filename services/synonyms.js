// services/synonyms.js
// ─────────────────────────────────────────────────────────────────
// Master synonym map: keys are internal schema fields,
// values are all known column header variants from real-world
// exports (Canvas, Google Classroom, SIMS, Arbor, MIS systems, etc.)
//
// To support a new export format: just add its header variants here.
// Case-insensitive comparison is done in fuzzyMapper.js.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const SYNONYM_MAP = {
  student_name: [
    'student name', 'student', 'name', 'full name', 'fullname',
    'pupil name', 'pupil', 'candidate', 'candidate name',
    'learner', 'learner name', 'child', 'child name',
    'first name last name', 'firstname lastname',
    'first last', 'given name', 'student full name',
    'preferred name', 'legal name', 'display name',
    // MIS-specific
    'pupil forename surname', 'student forename surname',
  ],

  first_name: [
    'first name', 'firstname', 'first', 'given name', 'forename',
    'given', 'christian name', 'preferred first name',
  ],

  last_name: [
    'last name', 'lastname', 'last', 'surname', 'family name',
    'familyname', 'second name',
  ],

  student_id: [
    'student id', 'id', 'student number', 'pupil id', 'upn',
    'urn', 'ref', 'reference', 'learner id', 'candidate number',
    'candidate id', 'enrollment number', 'roll number', 'code',
    'student ref', 'student reference', 'internal id',
    'external id', 'mis id', 'school id',
    // Arbor / SIMS
    'admissions number', 'admission number', 'uln', 'student uln',
  ],

  grade: [
    'grade', 'mark', 'score', 'result', 'final result',
    'final grade', 'percentage', 'pct', '%', 'percent', 'overall',
    'total mark', 'total marks', 'raw score', 'scaled score',
    'achievement', 'attainment', 'level', 'band', 'points',
    'total score', 'total points', 'final mark', 'final score',
    'weighted score', 'scaled mark', 'adjusted score',
    // Canvas
    'final score (unposted)', 'current score', 'final score',
    // Google Classroom
    'points earned',
  ],

  max_score: [
    'max score', 'max', 'out of', 'total possible', 'maximum',
    'max marks', 'maximum marks', 'possible points', 'total possible points',
    'points possible', 'full marks',
  ],

  subject: [
    'subject', 'course', 'module', 'class', 'topic', 'unit',
    'program', 'programme', 'department', 'area', 'strand',
    'qualification', 'paper', 'component', 'discipline', 'field',
    'course name', 'subject name', 'module name',
  ],

  assessment: [
    'assessment', 'test', 'exam', 'assignment', 'task',
    'component', 'paper', 'quiz', 'examination', 'assessment name',
    'test name', 'exam name', 'assignment name', 'activity name',
    'activity', 'title', 'assessment title', 'work',
    // Canvas
    'assignment name', 'assignment title',
  ],

  date: [
    'date', 'test date', 'exam date', 'assessment date',
    'submission date', 'due date', 'deadline', 'completed date',
    'semester', 'term', 'week', 'period', 'session', 'year',
    'academic year', 'school year', 'reporting period',
  ],

  teacher: [
    'teacher', 'instructor', 'educator', 'staff', 'tutor',
    'teacher name', 'taught by', 'form tutor', 'mentor',
    'class teacher', 'subject teacher', 'assigned teacher',
    'marked by', 'graded by',
  ],

  class: [
    'class', 'form', 'group', 'set', 'cohort', 'year group',
    'registration group', 'homeroom', 'section', 'stream',
    'band', 'tier', 'ability group', 'teaching group',
    'class name', 'group name', 'form group',
    // Arbor / SIMS
    'reg group', 'teaching set',
  ],

  attendance: [
    'attendance', 'present', 'absent', 'sessions attended',
    'attendance %', 'attendance rate', 'attendance percentage',
    'days present', 'days absent', 'sessions present',
    'total sessions', 'attended', 'absences',
  ],

  notes: [
    'notes', 'comments', 'remarks', 'annotation', 'feedback',
    'teacher comments', 'narrative', 'teacher feedback',
    'additional notes', 'comment', 'note', 'observations',
  ],
};

/**
 * fingerprintHeaders(headers)
 * Creates a stable MD5 hash from the sorted, normalised headers.
 * Used to auto-detect if a re-uploaded file matches a saved template.
 */
function fingerprintHeaders(headers) {
  const normalised = [...headers]
    .map(h => h.toLowerCase().trim().replace(/[^a-z0-9]/g, ''))
    .filter(h => h.length > 0)
    .sort()
    .join('|');

  return crypto.createHash('md5').update(normalised).digest('hex');
}

module.exports = { SYNONYM_MAP, fingerprintHeaders };
