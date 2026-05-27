// routes/import.js
// ─────────────────────────────────────────────────────────────────
// All spreadsheet import endpoints:
//   POST /api/import/upload            → parse file, suggest mapping
//   POST /api/import/:id/confirm       → teacher confirms mapping
//   GET  /api/import/:id/preview       → preview mapped rows
//   POST /api/import/:id/run           → execute the import to DB
//   GET  /api/import/templates         → fetch saved mapping templates
//   POST /api/import/templates         → save a new template
// ─────────────────────────────────────────────────────────────────

const express       = require('express');
const multer        = require('multer');
const path          = require('path');
const fs            = require('fs');
const { v4: uuidv4 } = require('uuid');
const { PrismaClient } = require('@prisma/client');

const { parseFile }                   = require('../services/fileParser');
const { detectTable, pickBestSheet }  = require('../services/tableDetector');
const { mapHeadersFuzzy }             = require('../services/fuzzyMapper');
const { aiMapHeaders, requiresAiAssist } = require('../services/aiMapper');
const { mergeConfidence, serializeMapping } = require('../services/confidence');
const { importSessionData }           = require('../services/importer');
const { fingerprintHeaders }          = require('../services/synonyms');

const router = express.Router();
const prisma = new PrismaClient();

// ── In-memory session store (survives for duration of server process)
// In production: swap this Map for Redis with a 2-hour TTL
const uploadSessions = new Map();

// ── Multer: store uploads to /tmp, 50MB max, validated extensions
const upload = multer({
  dest: '/tmp/gradelens-uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xlsx', '.xls'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type "${ext}". Please upload a .csv, .xlsx, or .xls file.`));
    }
  },
});

// ────────────────────────────────────────────────────────────────
// POST /api/import/upload
// Accepts a spreadsheet, runs the full parse + mapping pipeline,
// stores an upload session, returns mapping suggestions for the UI.
// ────────────────────────────────────────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file received. Please select a file to upload.' });
  }

  const filePath  = req.file.path;
  const filename  = req.file.originalname;
  const userId    = req.body.userId || req.headers['x-user-id'];

  if (!userId) {
    fs.unlinkSync(filePath);
    return res.status(401).json({ error: 'User not authenticated.' });
  }

  try {
    // 1. Parse all sheets from the file
    const sheets = await parseFile(filePath, filename);

    if (!sheets || Object.keys(sheets).length === 0) {
      return res.status(422).json({ error: 'No readable sheets found in the file.' });
    }

    const availableSheets = Object.keys(sheets);

    // 2. Pick the most data-rich sheet
    const bestSheet = pickBestSheet(sheets);

    // 3. Detect the data table within that sheet
    const table = detectTable(bestSheet, sheets[bestSheet]);

    if (!table) {
      return res.status(422).json({
        error: 'Could not locate a data table in this file. '
             + 'Please ensure it has column headers and at least one row of data.',
      });
    }

    // 4. Check for a saved template that matches these headers
    const fingerprint = fingerprintHeaders(table.headers);
    const savedTemplate = await prisma.mappingTemplate.findFirst({
      where: { userId: String(userId), sourceFingerprint: fingerprint },
      orderBy: { updatedAt: 'desc' },
    });

    let finalMapping, mappingSource, templateName;

    if (savedTemplate) {
      // Wrap plain string values in serialized format so frontend dropdowns pre-fill
      const wrapped = {};
      for (const [field, col] of Object.entries(savedTemplate.mappings || {})) {
        if (typeof col === 'string' && col) {
          wrapped[field] = { column: col, score: 1.0, source: 'template', confidence: 'high' };
        }
      }
      finalMapping  = wrapped;
      mappingSource = 'template';
      templateName  = savedTemplate.name;
    } else {
      // 5. Fuzzy-match headers against internal schema
      const fuzzyMapping = mapHeadersFuzzy(table.headers);

      // 6. Call Claude only when fuzzy results are insufficient
      if (requiresAiAssist(fuzzyMapping)) {
        const aiMapping = await aiMapHeaders(table.headers, table.sampleRows);
        finalMapping    = serializeMapping(mergeConfidence(fuzzyMapping, aiMapping));
        mappingSource   = 'ai';
      } else {
        finalMapping  = serializeMapping(fuzzyMapping);
        mappingSource = 'fuzzy';
      }
      templateName = null;
    }

    // 7. Persist the session so /confirm and /run can retrieve state
    const sessionId = uuidv4();
    uploadSessions.set(sessionId, {
      userId,
      filename,
      filePath,          // temp file kept until /run completes
      sheetName: bestSheet,
      availableSheets,
      headers: table.headers,
      colIndices: table.colIndices,
      headerRow: table.headerRow,
      dataStartRow: table.dataStartRow,
      dataEndRow: table.dataEndRow,
      sampleRows: table.sampleRows,
      suggestedMapping: finalMapping,
      confirmedMapping: null,
      fingerprint,
      mappingSource,
      status: 'pending',
      createdAt: Date.now(),
    });

    // Auto-expire sessions after 2 hours
    setTimeout(() => {
      const s = uploadSessions.get(sessionId);
      if (s?.filePath) {
        try { fs.unlinkSync(s.filePath); } catch (_) {}
      }
      uploadSessions.delete(sessionId);
    }, 2 * 60 * 60 * 1000);

    return res.json({
      sessionId,
      availableSheets,
      detectedSheet:    bestSheet,
      headers:          table.headers,
      sampleRows:       table.sampleRows,
      rowCount:         table.dataEndRow - table.dataStartRow,
      mapping:          finalMapping,
      mappingSource,
      templateName:     templateName || null,
      templateId:       savedTemplate?.id || null,
      needsConfirmation: mappingSource !== 'template',
    });

  } catch (err) {
    console.error('[import/upload]', err);
    try { fs.unlinkSync(filePath); } catch (_) {}
    return res.status(500).json({ error: `Failed to process file: ${err.message}` });
  }
});

// ────────────────────────────────────────────────────────────────
// POST /api/import/:sessionId/confirm
// Teacher has reviewed and approved (or adjusted) the mapping.
// Optionally saves as a reusable template.
// ────────────────────────────────────────────────────────────────
router.post('/:sessionId/confirm', async (req, res) => {
  const session = uploadSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found or expired. Please re-upload the file.' });
  }

  const { mapping, saveTemplate, templateName } = req.body;

  // Validate required fields are present
  const REQUIRED = ['student_name', 'grade'];
  const missing  = REQUIRED.filter(f => !mapping[f]);
  if (missing.length > 0) {
    return res.status(400).json({
      error: `The following required fields must be mapped: ${missing.join(', ')}`,
    });
  }

  // Store confirmed mapping back into session
  session.confirmedMapping = mapping;
  session.status = 'confirmed';

  // Optionally persist as a reusable template
  if (saveTemplate && templateName) {
    try {
      await prisma.mappingTemplate.upsert({
        where: {
          userId_sourceFingerprint: {
            userId:            String(session.userId),
            sourceFingerprint: session.fingerprint,
          },
        },
        update: { mappings: mapping, name: templateName, updatedAt: new Date() },
        create: {
          userId:            String(session.userId),
          name:              templateName,
          sourceFingerprint: session.fingerprint,
          mappings:          mapping,
        },
      });
    } catch (err) {
      console.warn('[import/confirm] Template save failed:', err.message);
      // Non-fatal — continue with import
    }
  }

  return res.json({ status: 'confirmed', sessionId: req.params.sessionId });
});

// ────────────────────────────────────────────────────────────────
// GET /api/import/:sessionId/preview
// Returns the first 20 rows with the confirmed mapping applied,
// so the UI can show a final preview before committing.
// ────────────────────────────────────────────────────────────────
router.get('/:sessionId/preview', async (req, res) => {
  const session = uploadSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired.' });
  }

  const mapping = session.confirmedMapping || session.suggestedMapping;
  const preview = session.sampleRows.map(row => {
    const mapped = {};
    for (const [internalField, sourceCol] of Object.entries(mapping)) {
      if (sourceCol && row[sourceCol] !== undefined) {
        mapped[internalField] = row[sourceCol];
      }
    }
    return mapped;
  });

  return res.json({ rows: preview, mapping });
});

// ────────────────────────────────────────────────────────────────
// POST /api/import/:sessionId/run
// Executes the import: reads the full file, applies mapping,
// validates each row, writes to the database via Prisma.
// ────────────────────────────────────────────────────────────────
router.post('/:sessionId/run', async (req, res) => {
  const session = uploadSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired. Please re-upload.' });
  }
  if (session.status !== 'confirmed') {
    return res.status(400).json({ error: 'Mapping has not been confirmed yet.' });
  }

  try {
    // If max_score wasn't mapped by the user but was detected by fuzzy/AI, apply it automatically
    if (!session.confirmedMapping.max_score && session.suggestedMapping?.max_score?.column) {
      session.confirmedMapping = {
        ...session.confirmedMapping,
        max_score: session.suggestedMapping.max_score.column,
      };
    }

    const result = await importSessionData(session, prisma);

    // Clean up temp file
    try { fs.unlinkSync(session.filePath); } catch (_) {}
    session.status = 'imported';

    return res.json({
      status:        'complete',
      rowsImported:  result.imported,
      rowsSkipped:   result.skipped,
      errors:        result.errors.slice(0, 50), // cap at 50 for UI
    });

  } catch (err) {
    console.error('[import/run]', err);
    return res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/import/templates
// Fetch all saved mapping templates for the logged-in user.
// ────────────────────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const templates = await prisma.mappingTemplate.findMany({
      where: { userId: String(userId) },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, mappings: true, updatedAt: true },
    });
    return res.json({ templates });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch templates.' });
  }
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/import/templates/:id
// Remove a saved mapping template.
// ────────────────────────────────────────────────────────────────
router.delete('/templates/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    await prisma.mappingTemplate.deleteMany({
      where: { id: req.params.id, userId: String(userId) },
    });
    return res.json({ status: 'deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete template.' });
  }
});

module.exports = router;
