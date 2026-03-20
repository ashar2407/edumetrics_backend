const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Prisma to connect to PostgreSQL
const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3001;

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://edu-metrics-gray.vercel.app'
  ]
}));

// IMPORTANT: The Stripe webhook endpoint MUST use raw body (before express.json())
// Stripe signs the raw request body — express.json() would break signature verification
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// All other routes use JSON
app.use(express.json());


// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================

// Create a new Educator account
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists. Please choose another or log in.' });
    }

    // NOTE: Use bcrypt to hash passwords before saving in production!
    const user = await prisma.user.create({
      data: { username, password, role: 'Teacher', isPremium: false }
    });

    res.json({
      message: 'User created successfully',
      user: { id: user.id, username: user.username, isPremium: false }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Educator Login — now returns isPremium so the frontend knows instantly
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid username or password. Have you created an account?' });
    }

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        isPremium: user.isPremium ?? false  // <-- frontend uses this to unlock features
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error during login' });
  }
});


// ==========================================
// STRIPE WEBHOOK
// ==========================================

// Stripe calls this URL automatically after every successful payment.
// Register this in: Stripe Dashboard → Developers → Webhooks → Add endpoint
//   URL:    https://edumetrics-api-kro4.onrender.com/api/stripe/webhook
//   Events: checkout.session.completed

app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  // Verify the request actually came from Stripe (not a forged request)
  try {
    event = stripe.webhooks.constructEvent(
      req.body,                           // raw body — must NOT be parsed JSON
      sig,                                // stripe-signature header
      process.env.STRIPE_WEBHOOK_SECRET   // signing secret from Stripe Dashboard
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Fires when a customer successfully completes checkout
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // We pass the username as client_reference_id when building the Stripe URL
    // in App.jsx so we know exactly which account to upgrade
    const username = session.client_reference_id;

    if (!username) {
      console.error('No username found in client_reference_id');
      return res.status(400).json({ error: 'No username in session' });
    }

    try {
      await prisma.user.update({
        where: { username },
        data: { isPremium: true }
      });
      console.log(`Premium unlocked for: ${username}`);
    } catch (dbError) {
      console.error('Failed to update premium status:', dbError);
      return res.status(500).json({ error: 'Database update failed' });
    }
  }

  // Always return 200 — Stripe will retry if it doesn't get this
  res.json({ received: true });
});


// ==========================================
// PREMIUM STATUS CHECK
// ==========================================

// Frontend calls this after Stripe redirects back to the app,
// to immediately reflect updated premium status without re-logging in
app.get('/api/user/:username/premium', async (req, res) => {
  try {
    const { username } = req.params;
    const user = await prisma.user.findUnique({
      where: { username },
      select: { isPremium: true }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ isPremium: user.isPremium ?? false });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to check premium status' });
  }
});


// ==========================================
// DATA RETRIEVAL ENDPOINTS
// ==========================================

app.get('/api/dashboard/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const classes = await prisma.class.findMany({
      where: { userId },
      include: {
        students: { include: { scores: true } },
        assessments: {
          orderBy: { date: 'asc' },
          include: { scores: true }
        }
      }
    });

    res.json({ classes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});



// ==========================================
// NOTES & GOALS ENDPOINTS
// ==========================================

// Save or update a teacher note + goal for a student
app.post('/api/notes', async (req, res) => {
  try {
    const { userId, studentId, note, goal } = req.body;
    if (!userId || !studentId) return res.status(400).json({ error: 'userId and studentId are required' });

    // Upsert: create if not exists, update if it does
    const record = await prisma.studentNote.upsert({
      where: { userId_studentId: { userId, studentId } },
      update: { note: note || '', goal: goal ?? null },
      create: { userId, studentId, note: note || '', goal: goal ?? null }
    });

    res.json({ success: true, record });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

// Fetch note + goal for a specific student
app.get('/api/notes/:userId/:studentId', async (req, res) => {
  try {
    const { userId, studentId } = req.params;
    const record = await prisma.studentNote.findUnique({
      where: { userId_studentId: { userId, studentId: decodeURIComponent(studentId) } }
    });
    res.json(record || { note: '', goal: null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch note' });
  }
});

// Fetch all notes for a teacher (useful for bulk exports)
app.get('/api/notes/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const records = await prisma.studentNote.findMany({ where: { userId } });
    res.json({ records });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Grade Lens API is running on http://localhost:${PORT}`);
});



