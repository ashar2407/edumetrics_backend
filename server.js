const express = require('express');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const crypto = require('crypto'); // built-in Node.js
const SALT_ROUNDS = 12;
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
    const { username, password, email } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists. Please choose another or log in.' });
    }

    // Hash password with bcrypt before storing
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.user.create({
      data: { username, password: hashedPassword, role: 'Teacher', isPremium: false, email: email || null }
    });

    res.json({
      message: 'User created successfully',
      user: { id: user.id, username: user.username, isPremium: false, email: user.email || null }
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

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password. Have you created an account?' });
    }

    // Compare submitted password against the stored hash
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password. Have you created an account?' });
    }

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        isPremium: user.isPremium ?? false,
        email: user.email || null
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



// ==========================================
// UPDATE EMAIL ENDPOINT
// ==========================================

// Allow a user to add or update their email after account creation
app.post('/api/user/email', async (req, res) => {
  try {
    const { userId, email } = req.body;
    if (!userId || !email) return res.status(400).json({ error: 'userId and email are required' });

    const user = await prisma.user.update({
      where: { id: userId },
      data: { email }
    });

    res.json({ success: true, email: user.email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

// ==========================================
// AT-RISK EMAIL NOTIFICATIONS
// ==========================================

app.post('/api/notify/at-risk', async (req, res) => {
  try {
    const { userId } = req.body;

    // Get teacher with email
    const teacher = await prisma.user.findUnique({ where: { id: userId } });
    if (!teacher?.email) {
      return res.status(400).json({ error: 'No email address on file for this account.' });
    }

    // Find all high-risk students across teacher's classes
    const classes = await prisma.class.findMany({
      where: { userId },
      include: {
        students: { include: { scores: true } },
        assessments: { orderBy: { date: 'asc' } }
      }
    });

    const atRiskStudents = [];
    classes.forEach(cls => {
      cls.students.forEach(stu => {
        const scoreVals = stu.scores.map(s => s.score);
        if (scoreVals.length < 2) return;
        const mean = scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length;
        const last = scoreVals[scoreVals.length - 1];
        // Flag if last score is more than 15% below mean OR mean is below 55
        if (last < mean - 15 || mean < 55) {
          atRiskStudents.push({ name: stu.name, subject: cls.name, mean: mean.toFixed(1), last: last.toFixed(1) });
        }
      });
    });

    if (atRiskStudents.length === 0) {
      return res.json({ sent: 0, message: 'No at-risk students found — great news!' });
    }

    // Build email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    const tableRows = atRiskStudents.map(s =>
      `<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${s.name}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${s.subject}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${s.mean}%</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;color:#ef4444;font-weight:bold">${s.last}%</td></tr>`
    ).join('');

    await transporter.sendMail({
      from: `"Grade Lens" <${process.env.EMAIL_USER}>`,
      to: teacher.email,
      subject: `⚠️ ${atRiskStudents.length} At-Risk Student${atRiskStudents.length > 1 ? 's' : ''} — Grade Lens Alert`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1e40af;padding:24px;border-radius:12px 12px 0 0">
            <h1 style="color:white;margin:0;font-size:20px">⚠️ At-Risk Student Report</h1>
            <p style="color:#bfdbfe;margin:4px 0 0;font-size:14px">Generated by Grade Lens Analytics</p>
          </div>
          <div style="padding:24px;background:#f8fafc;border-radius:0 0 12px 12px">
            <p style="color:#475569">Hi ${teacher.username}, the following students have been flagged as at-risk based on their recent performance:</p>
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;margin:16px 0">
              <thead><tr style="background:#f1f5f9">
                <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase">Student</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase">Subject</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase">Avg</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase">Last Score</th>
              </tr></thead>
              <tbody>${tableRows}</tbody>
            </table>
            <p style="color:#94a3b8;font-size:12px">Log in to Grade Lens to view full profiles and take action.</p>
          </div>
        </div>`
    });

    res.json({ sent: atRiskStudents.length });
  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ error: 'Failed to send notifications' });
  }
});


// ==========================================
// PASSWORD RESET ENDPOINTS
// ==========================================

// Step 1 — Teacher requests a reset link
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await prisma.user.findFirst({ where: { email } });

    // Always return 200 even if no account found — prevents email enumeration
    if (!user) {
      return res.json({ message: 'If that email is registered, a reset link has been sent.' });
    }

    // Generate a secure random token valid for 1 hour
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: token, resetTokenExpiry: expiry }
    });

    // Send reset email
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    const resetUrl = `https://edu-metrics-gray.vercel.app/#/reset-password?token=${token}`;

    await transporter.sendMail({
      from: `"Grade Lens" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: 'Reset your Grade Lens password',
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <div style="background:#1e40af;padding:24px;border-radius:12px 12px 0 0">
            <h1 style="color:white;margin:0;font-size:20px">Password Reset</h1>
            <p style="color:#bfdbfe;margin:4px 0 0;font-size:14px">Grade Lens Analytics</p>
          </div>
          <div style="padding:24px;background:#f8fafc;border-radius:0 0 12px 12px">
            <p style="color:#475569">Hi ${user.username}, we received a request to reset your password.</p>
            <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
              Reset My Password
            </a>
            <p style="color:#94a3b8;font-size:12px;margin-top:16px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
          </div>
        </div>`
    });

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// Step 2 — Teacher submits new password using the token
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required.' });

    // Find user with this valid, non-expired token
    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() } // token must not be expired
      }
    });

    if (!user) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    // Hash the new password and clear the token
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null
      }
    });

    res.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Grade Lens API is running on http://localhost:${PORT}`);
});
