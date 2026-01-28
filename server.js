const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Import routes
// Import routes
const authRoutes = require('./routes/auth');
const gardenRoutes = require('./routes/gardens');
const cropRoutes = require('./routes/crops');

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:8080'], // Add your Flutter web URL
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Harvest Hub API is running',
    timestamp: new Date().toISOString()
  });
});

// API Documentation
app.get('/api', (req, res) => {
  res.json({
    message: 'Harvest Hub API',
    endpoints: {
      auth: '/api/auth',
      gardens: '/api/gardens',
      crops: '/api/crops',
      health: '/health'
    }
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/gardens', gardenRoutes);
app.use('/api/crops', cropRoutes);

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Auth: http://localhost:${PORT}/api/auth`);
  console.log(`🌿 Gardens: http://localhost:${PORT}/api/gardens`);
  console.log(`🥦 Crops: http://localhost:${PORT}/api/crops`);
});