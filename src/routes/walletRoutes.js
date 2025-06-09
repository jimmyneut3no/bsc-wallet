const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const healthController = require('../controllers/healthController');
const serverController = require('../controllers/serverController');
const queueService = require('../services/queueService');
const verifyHmac = require('../middleware/hmacVerification');

// Apply HMAC verification middleware to all routes
router.use(verifyHmac);

// Wallet routes
router.get('/generate-address/:userId', walletController.generateAddress);
router.get('/balance/:userId', walletController.getBalance);
router.post('/sweep/:userId', walletController.sweepUsdt);
router.post('/withdraw', walletController.withdrawUsdt);
router.get('/withdraw/:jobId', async (req, res) => {
  try {
    const status = await queueService.getJobStatus(req.params.jobId);
    if (!status) {
      return res.status(404).json({
        status: 'error',
        message: 'Withdrawal job not found',
        timestamp: new Date().toISOString()
      });
    }
    res.json(status);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to get withdrawal status',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});
router.post('/batch-wallet-info', walletController.getBatchWalletInfo);

// Health check route
router.get('/health', healthController.getHealth);

// Server management routes
router.post('/restart', serverController.restartServer);
router.get('/status', serverController.getServerStatus);

module.exports = router; 