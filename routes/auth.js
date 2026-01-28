const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
require('dotenv').config();

// Register user
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    // Validate input
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if user already exists
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user in Supabase
    const { data: user, error } = await supabase
      .from('users')
      .insert([
        {
          email,
          password_hash: hashedPassword,
          name,
          phone: phone || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Error creating user' });
    }

    // Create JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        name: user.name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = user;

    res.status(201).json({
      message: 'User registered successfully',
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Get user from Supabase
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        name: user.name 
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = user;

    res.status(200).json({
      message: 'Login successful',
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user
// Get current user
router.get('/me', async (req, res) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).json({ 
        success: false,
        error: 'Authorization header is required' 
      });
    }

    // Check if it's a Bearer token
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid authorization format. Use: Bearer <token>' 
      });
    }

    const token = authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ 
        success: false,
        error: 'Token is required' 
      });
    }

    console.log('🔍 Verifying token for /me endpoint');
    
    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('✅ Token decoded:', { id: decoded.id, email: decoded.email });
    
    // Get user from database
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, phone, created_at, updated_at')
      .eq('id', decoded.id)
      .single();

    if (error) {
      console.error('❌ Supabase error:', error);
      return res.status(404).json({ 
        success: false,
        error: 'User not found in database' 
      });
    }

    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found' 
      });
    }

    console.log('✅ User found:', user.email);
    
    res.status(200).json({ 
      success: true,
      user 
    });

  } catch (error) {
    console.error('💥 /me endpoint error:', error.name, error.message);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid token',
        details: error.message
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false,
        error: 'Token expired',
        details: 'Please login again'
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Logout (client-side token removal - this is just for API consistency)
router.post('/logout', (req, res) => {
  res.status(200).json({ message: 'Logged out successfully' });
});

module.exports = router;