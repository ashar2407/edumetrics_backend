// routes/classes.js
// ─────────────────────────────────────────────────────────────────
// Class management endpoints:
//   GET    /api/classes                        → list user's classes
//   PATCH  /api/classes/:id                    → rename a class
//   DELETE /api/classes/:id                    → delete class + all data
//   GET    /api/classes/:id/students           → list students in a class
//   DELETE /api/classes/:classId/students/:studentId → remove a student
// ─────────────────────────────────────────────────────────────────

const express           = require('express');
const { PrismaClient }  = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// Helper: verify the class belongs to the requesting user
async function getOwnedClass(classId, userId) {
  const cls = await prisma.class.findFirst({
    where: { id: classId, userId: String(userId) },
  });
  return cls; // null if not found or not owned
}

// ────────────────────────────────────────────────────────────────
// GET /api/classes
// Returns all classes for the logged-in user with summary counts.
// ────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const classes = await prisma.class.findMany({
      where:   { userId: String(userId) },
      orderBy: { createdAt: 'desc' },
      select: {
        id:        true,
        name:      true,
        createdAt: true,
        _count: {
          select: {
            students:    true,
            assessments: true,
          },
        },
      },
    });

    return res.json({ classes });
  } catch (err) {
    console.error('[classes/list]', err);
    return res.status(500).json({ error: 'Failed to fetch classes.' });
  }
});

// ────────────────────────────────────────────────────────────────
// PATCH /api/classes/:id
// Rename a class. Name must be unique per user.
// Body: { name: string }
// ────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Class name cannot be empty.' });
  }

  try {
    const cls = await getOwnedClass(req.params.id, userId);
    if (!cls) return res.status(404).json({ error: 'Class not found.' });

    // Check for name collision with another class owned by this user
    const collision = await prisma.class.findFirst({
      where: {
        userId: String(userId),
        name:   name.trim(),
        NOT:    { id: req.params.id },
      },
    });
    if (collision) {
      return res.status(409).json({ error: `You already have a class named "${name.trim()}".` });
    }

    const updated = await prisma.class.update({
      where: { id: req.params.id },
      data:  { name: name.trim() },
      select: { id: true, name: true },
    });

    return res.json({ class: updated });
  } catch (err) {
    console.error('[classes/rename]', err);
    return res.status(500).json({ error: 'Failed to rename class.' });
  }
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/classes/:id
// Deletes the class and all associated data (students, assessments,
// scores) via Prisma cascade (onDelete: Cascade is set in schema).
// ────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const cls = await getOwnedClass(req.params.id, userId);
    if (!cls) return res.status(404).json({ error: 'Class not found.' });

    await prisma.class.delete({ where: { id: req.params.id } });
    // Cascade in schema handles: students → scores, assessments → scores

    return res.json({ status: 'deleted', id: req.params.id });
  } catch (err) {
    console.error('[classes/delete]', err);
    return res.status(500).json({ error: 'Failed to delete class.' });
  }
});

// ────────────────────────────────────────────────────────────────
// GET /api/classes/:id/students
// Returns all students in a class with their average score.
// ────────────────────────────────────────────────────────────────
router.get('/:id/students', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const cls = await getOwnedClass(req.params.id, userId);
    if (!cls) return res.status(404).json({ error: 'Class not found.' });

    const students = await prisma.student.findMany({
      where:   { classId: req.params.id },
      orderBy: { name: 'asc' },
      select: {
        id:         true,
        name:       true,
        externalId: true,
        createdAt:  true,
        scores: {
          select: { score: true },
        },
      },
    });

    const enriched = students.map(s => ({
      id:         s.id,
      name:       s.name,
      externalId: s.externalId,
      createdAt:  s.createdAt,
      scoreCount: s.scores.length,
      avgScore:   s.scores.length
        ? parseFloat((s.scores.reduce((sum, sc) => sum + sc.score, 0) / s.scores.length).toFixed(1))
        : null,
    }));

    return res.json({ students: enriched });
  } catch (err) {
    console.error('[classes/students]', err);
    return res.status(500).json({ error: 'Failed to fetch students.' });
  }
});

// ────────────────────────────────────────────────────────────────
// DELETE /api/classes/:classId/students/:studentId
// Removes a student and all their scores from a class.
// ────────────────────────────────────────────────────────────────
router.delete('/:classId/students/:studentId', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  try {
    const cls = await getOwnedClass(req.params.classId, userId);
    if (!cls) return res.status(404).json({ error: 'Class not found.' });

    // Confirm student belongs to this class
    const student = await prisma.student.findFirst({
      where: { id: req.params.studentId, classId: req.params.classId },
    });
    if (!student) return res.status(404).json({ error: 'Student not found in this class.' });

    await prisma.student.delete({ where: { id: req.params.studentId } });
    // Cascade in schema handles: student → scores

    return res.json({ status: 'deleted', id: req.params.studentId });
  } catch (err) {
    console.error('[classes/delete-student]', err);
    return res.status(500).json({ error: 'Failed to remove student.' });
  }
});

module.exports = router;
