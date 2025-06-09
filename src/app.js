require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PORT } = require('./config/constants');
const walletRoutes = require('./routes/walletRoutes');
const walletService = require('./services/walletService');

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', walletRoutes);

// Initialize wallet service
walletService.initialize()
  .then(() => {
    console.log('Wallet service initialized successfully');
  })
  .catch((error) => {
    console.error('Failed to initialize wallet service:', error);
    process.exit(1);
  });

// Start server
const server = app.listen(PORT, () => {
  console.log(`USDT Wallet API running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/api/health`);
});

// Handle startup errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
    process.exit(1);
  } else {
    console.error('Server startup error:', error);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server terminated');
    process.exit(0);
  });
}); 