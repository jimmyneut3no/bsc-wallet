const { ethers } = require('ethers');
const walletService = require('../services/walletService');

class HealthController {
  /**
   * Get system health status
   */
  async getHealth(req, res) {
    const healthCheck = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      components: {
        api: {
          status: 'ok',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage()
        },
        blockchain: {
          status: 'checking',
          network: null,
          blockNumber: null,
          gasPrice: null
        },
        wallet: {
          status: 'checking',
          address: null,
          balance: null
        }
      }
    };

    try {
      // Check blockchain provider connection
      const blockNumber = await walletService.provider.getBlockNumber();
      const network = await walletService.provider.getNetwork();
      const gasPrice = await walletService.provider.getGasPrice();

      healthCheck.components.blockchain = {
        status: 'ok',
        network: network.name,
        chainId: network.chainId,
        blockNumber: blockNumber,
        gasPrice: ethers.utils.formatUnits(gasPrice, 'gwei') + ' gwei',
        lastChecked: new Date().toISOString()
      };

      // Check wallet status
      if (walletService.centralWallet) {
        const balance = await walletService.centralWallet.getBalance();
        healthCheck.components.wallet = {
          status: 'ok',
          address: walletService.centralAddress,
          balance: ethers.utils.formatEther(balance) + ' BNB',
          lastChecked: new Date().toISOString()
        };
      } else {
        healthCheck.components.wallet = {
          status: 'error',
          error: 'Wallet not initialized',
          lastChecked: new Date().toISOString()
        };
      }
    } catch (err) {
      healthCheck.status = 'degraded';
      healthCheck.components.blockchain = {
        status: 'error',
        error: err.message,
        lastChecked: new Date().toISOString()
      };
    }

    // Set overall status based on components
    const hasError = Object.values(healthCheck.components).some(
      component => component.status === 'error'
    );

    if (hasError) {
      healthCheck.status = 'degraded';
      healthCheck.message = 'API is running but some components are not healthy';
    } else {
      healthCheck.message = 'USDT wallet API is fully operational';
    }

    // Return appropriate status code
    const statusCode = healthCheck.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(healthCheck);
  }
}

module.exports = new HealthController(); 