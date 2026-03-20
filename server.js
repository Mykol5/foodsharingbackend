const express = require('express');
const cors = require('cors');
const http = require('http');
require('dotenv').config();

// Import routes
const authRoutes = require('./routes/auth');
const gardenRoutes = require('./routes/gardens');
const cropRoutes = require('./routes/crops');
const sharedItemsRoutes = require('./routes/sharedItems');
const chatRoutes = require('./routes/chats');
const messageRoutes = require('./routes/messages');

// Import WebSocket server
const WebSocketServer = require('./websocket/server');

const app = express();
const server = http.createServer(app);

// Initialize WebSocket server with path
const wsServer = new WebSocketServer(server, { path: '/ws' });

// Make WebSocket server available to routes
app.set('wsServer', wsServer);

// Update CORS configuration - THIS IS THE KEY PART
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:8080', 
    'http://localhost:56172',
    'https://mykol5.github.io'  // ADD YOUR GITHUB PAGES DOMAIN
  ],
  credentials: true,              // IMPORTANT: Allow credentials (cookies, authorization headers)
  optionsSuccessStatus: 200,       // Some legacy browsers choke on 204
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

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
      shared: '/api/shared-items',
      chats: '/api/chats',
      messages: '/api/messages',
      health: '/health'
    }
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/gardens', gardenRoutes);
app.use('/api/crops', cropRoutes);
app.use('/api/shared-items', sharedItemsRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server with WebSocket support
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Auth: http://localhost:${PORT}/api/auth`);
  console.log(`🌿 Gardens: http://localhost:${PORT}/api/gardens`);
  console.log(`🥦 Crops: http://localhost:${PORT}/api/crops`);
  console.log(`📦 Shared Items: http://localhost:${PORT}/api/shared-items`);
  console.log(`💬 Chats: http://localhost:${PORT}/api/chats`);
  console.log(`✉️ Messages: http://localhost:${PORT}/api/messages`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
});





// const express = require('express');
// const cors = require('cors');
// require('dotenv').config();

// // Import routes
// const authRoutes = require('./routes/auth');
// const gardenRoutes = require('./routes/gardens');
// const cropRoutes = require('./routes/crops');
// const sharedItemsRoutes = require('./routes/sharedItems');

// const app = express();

// // Update CORS configuration - THIS IS THE KEY PART
// const corsOptions = {
//   origin: [
//     'http://localhost:3000',
//     'http://localhost:8080', 
//     'http://localhost:56172',
//     'https://mykol5.github.io'  // ADD YOUR GITHUB PAGES DOMAIN
//   ],
//   credentials: true,              // IMPORTANT: Allow credentials (cookies, authorization headers)
//   optionsSuccessStatus: 200,       // Some legacy browsers choke on 204
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
// };

// app.use(cors(corsOptions));

// // Handle preflight requests explicitly
// app.options('*', cors(corsOptions));

// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// // Health check
// app.get('/health', (req, res) => {
//   res.status(200).json({ 
//     status: 'OK', 
//     message: 'Harvest Hub API is running',
//     timestamp: new Date().toISOString()
//   });
// });

// // API Documentation
// app.get('/api', (req, res) => {
//   res.json({
//     message: 'Harvest Hub API',
//     endpoints: {
//       auth: '/api/auth',
//       gardens: '/api/gardens',
//       crops: '/api/crops',
//       shared: '/api/shared-items',
//       health: '/health'
//     }
//   });
// });

// // Routes
// app.use('/api/auth', authRoutes);
// app.use('/api/gardens', gardenRoutes);
// app.use('/api/crops', cropRoutes);
// app.use('/api/shared-items', sharedItemsRoutes);

// // Basic error handler
// app.use((err, req, res, next) => {
//   console.error(err.stack);
//   res.status(500).json({ error: 'Something went wrong!' });
// });

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Start server
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`📡 Health check: http://localhost:${PORT}/health`);
//   console.log(`🔐 Auth: http://localhost:${PORT}/api/auth`);
//   console.log(`🌿 Gardens: http://localhost:${PORT}/api/gardens`);
//   console.log(`🥦 Crops: http://localhost:${PORT}/api/crops`);
//   console.log(`📦 Shared Items: http://localhost:${PORT}/api/shared-items`);
// });
