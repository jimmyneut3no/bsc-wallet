const walletService = require('../services/walletService');
const webhookService = require('../services/webhookService');
const queueService = require('../services/queueService');
const { ethers } = require('ethers');

class WalletController {
  /**
   * Generate deposit address and top up gas if needed
   */
  async generateAddress(req, res) {
    try {
      const { userId } = req.params;
      const address = await walletService.generateAddress(userId);
      const txHash = await walletService.topUpGas(address);
      
      res.json({
        address,
        gasStatus: txHash ? `Funded with gas` : 'Sufficient gas',
        txHash: txHash || undefined
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  /**
   * Get USDT balance for a user
   */
  async getBalance(req, res) {
    try {
      const { userId } = req.params;
      const address = await walletService.generateAddress(userId);
      const balance = await walletService.getUsdtBalance(address);
      
      res.json({
        address,
        balance
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Sweep USDT from user wallet to central wallet
   */
  async sweepUsdt(req, res) {
    try {
      const { userId } = req.params;

      // Generate a unique request ID
      const requestId = Date.now().toString();

      // Send immediate response
      res.json({
        status: 'processing',
        message: 'Sweep request received',
        requestId,
        timestamp: new Date().toISOString()
      });

      // Process sweep in background
      setImmediate(async () => {
        try {
          const result = await walletService.sweepUsdt(userId);

          if (result) {
            // Send webhook notification
            await webhookService.sendDepositNotification(userId, {
              status: 'completed',
              amount: result.amount,
              txHash: result.txHash,
              from: result.from,
              to: result.to,
              timestamp: new Date().toISOString()
            });

            console.log('Sweep processed successfully:', {
              requestId,
              result,
              timestamp: new Date().toISOString()
            });
          } else {
            console.log('No funds to sweep:', {
              requestId,
              userId,
              timestamp: new Date().toISOString()
            });
          }
        } catch (error) {
          console.error('Background sweep processing failed:', {
            requestId,
            userId,
            error: error.message,
            timestamp: new Date().toISOString()
          });

          // Send failure webhook
          await webhookService.sendDepositNotification(userId, {
            status: 'failed',
            error: error.message,
            timestamp: new Date().toISOString()
          });
        }
      });

    } catch (error) {
      console.error('Sweep request failed:', {
        error: error.message,
        endpoint: '/sweep',
        userId: req.params.userId,
        timestamp: new Date().toISOString()
      });

      // Only send error response if we haven't sent a response yet
      if (!res.headersSent) {
        res.status(500).json({
          status: 'error',
          message: 'Failed to process sweep request',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Initiate USDT withdrawal
   */
  async withdrawUsdt(req, res) {
    try {
      const { to, amount, userId, from } = req.body;

      // Input validation
      if (!to || !amount || !userId) {
        return res.status(400).json({
          status: 'error',
          message: 'Missing required fields: to, amount, or userId',
          timestamp: new Date().toISOString()
        });
      }

      // Validate address format
      if (!ethers.utils.isAddress(to)) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid recipient address format',
          timestamp: new Date().toISOString()
        });
      }

      // Validate amount format
      try {
        const parsedAmount = ethers.utils.parseUnits(amount, 18);
        if (parsedAmount.lte(0)) {
          return res.status(400).json({
            status: 'error',
            message: 'Amount must be greater than 0',
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid amount format',
          timestamp: new Date().toISOString()
        });
      }

      // Check central wallet balance before proceeding
      const balance = await walletService.getUsdtBalance(walletService.centralAddress);
      if (parseFloat(balance) < parseFloat(amount)) {
        return res.status(400).json({
          status: 'error',
          message: `Insufficient balance. Available: ${balance} USDT, Required: ${amount} USDT`,
          timestamp: new Date().toISOString()
        });
      }

      // Generate a unique request ID
      const requestId = Date.now().toString();

      // Send immediate response
      res.json({
        status: 'processing',
        message: 'Withdrawal request received',
        requestId,
        timestamp: new Date().toISOString(),
        details: {
          to,
          amount,
          userId
        }
      });

      // Process withdrawal in background
      setImmediate(async () => {
        try {
          // Try to use queue if available, otherwise process directly
          const result = await queueService.processWithdrawal({
            userId,
            to,
            amount,
            fromAddress: walletService.centralAddress,
            requestId
          });

          // Webhook will be sent by the queue service or direct processor
          console.log('Withdrawal processed:', {
            requestId,
            result,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.error('Background withdrawal processing failed:', {
            requestId,
            error: error.message,
            timestamp: new Date().toISOString()
          });
        }
      });

    } catch (error) {
      console.error('Withdrawal request failed:', {
        error: error.message,
        endpoint: '/withdraw',
        payload: req.body,
        timestamp: new Date().toISOString()
      });

      // Only send error response if we haven't sent a response yet
      if (!res.headersSent) {
        res.status(500).json({
          status: 'error',
          message: 'Failed to process withdrawal request',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Get batch wallet information
   */
  async getBatchWalletInfo(req, res) {
    try {
      const { userIds } = req.body;
      if (!Array.isArray(userIds)) {
        return res.status(400).json({ error: 'userIds must be an array' });
      }

      const results = await Promise.all(userIds.map(async (id) => {
        try {
          const address = await walletService.generateAddress(id);
          const [gasBalance, usdtBalance] = await Promise.all([
            walletService.getGasBalance(address),
            walletService.getUsdtBalance(address)
          ]);

          return {
            userId: id,
            address,
            gas: parseFloat(gasBalance),
            usdt: parseFloat(usdtBalance)
          };
        } catch (err) {
          return { userId: id, error: err.message };
        }
      }));

      res.json(results);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new WalletController(); 