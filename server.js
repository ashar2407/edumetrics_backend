const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');

// Initialize Prisma to connect to PostgreSQL
const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5173', 
    'https://edu-metrics-gray.vercel.app' // <-- PUT YOUR REAL VERCEL LINK HERE!
  ]
})); // Allows your React frontend to communicate with this backend
app.use(express.json()); // Parses incoming JSON requests

// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================

// Create a new Educator account
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Check if username is taken
    const existingUser = await prisma.user.findUnique({ where: { username } });
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists. Please choose another or log in.' });
    }
    
    // Save new user (Note: Use a library like bcrypt to hash the password before saving!)
    const user = await prisma.user.create({
      data: { username, password, role: 'Teacher' }
    });
    
    res.json({ message: 'User created successfully', user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Educator Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await prisma.user.findUnique({ where: { username } });
    
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid username or password. Have you created an account?' });
    }
    
    res.json({ message: 'Login successful', user: { id: user.id, username: user.username } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ==========================================
// DATA RETRIEVAL ENDPOINTS
// ==========================================

// Fetch the complete dashboard payload for a specific teacher
app.get('/api/dashboard/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Prisma easily fetches all relational data (Classes -> Students & Assessments -> Scores)
    const classes = await prisma.class.findMany({
      where: { userId },
      include: {
        students: {
          include: { scores: true }
        },
        assessments: {
          orderBy: { date: 'asc' }, // Automatically sorts tests longitudinally!
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

// Start the server
app.listen(PORT, () => {
  console.log(`Grade Lens API is running on http://localhost:${PORT}`);
});