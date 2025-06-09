// File: index.js
require('dotenv').config();
const crypto = require('crypto');
const { getWalletCredentials } = require('./dbCredentials');
const Queue = require('bull');

function verifyHmac(req, res, next) {
  const secret = process.env.HMAC_SECRET;
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-hmac-signature'];
  if (!timestamp || !signature) {
    return res.status(401).json({ error: 'Missing HMAC signature or timestamp' });
  }

  // For GET requests, use only timestamp
  const dataToSign = req.method === 'GET' ? timestamp : JSON.stringify(req.body || {}) + timestamp;

  try {
    const digest = crypto.createHmac('sha256', secret)
      .update(dataToSign)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }

    next();
  } catch (err) {
    return res.status(500).json({ error: 'HMAC verification failed', details: err.message });
  }
}


const express = require('express');
const { ethers } = require('ethers');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', verifyHmac);
let MNEMONIC, CENTRAL_WALLET, CENTRAL_PK;
async function initializeWallet() {
  try {
    const credentials = await getWalletCredentials();
    CENTRAL_PK = credentials.CENTRAL_PK;
    MNEMONIC = credentials.MNEMONIC;
    CENTRAL_WALLET = credentials.CENTRAL_WALLET;

    const wallet = new ethers.Wallet(CENTRAL_PK, provider);

    console.log(`Wallet initialized: ${CENTRAL_WALLET}`);
    console.log(`Current balance: ${ethers.utils.formatEther(await wallet.getBalance())} ETH`);

    return wallet;
  } catch (err) {
    console.error('Failed to initialize wallet:', err);
    process.exit(1);
  }
}

initializeWallet();
console.log(MNEMONIC);
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"; // BEP20 USDT
const BSC_RPC = process.env.BSC_RPC;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const provider = new ethers.providers.JsonRpcProvider(BSC_RPC);
const hdNode = ethers.utils.HDNode.fromMnemonic(MNEMONIC);

const usdtAbi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const usdtContract = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);


const sendWebhook = async (payload) => {
  if (!WEBHOOK_URL || !process.env.HMAC_SECRET) return;

  const timestamp = Date.now().toString();
  const bodyString = JSON.stringify(payload);

  const dataToSign = bodyString + timestamp;
  const signature = crypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(dataToSign)
    .digest('hex');

  const headers = {
    'X-Timestamp': timestamp,
    'X-Hmac-Signature': signature,
    'Content-Type': 'application/json',
  };

  try {
    await axios.post(WEBHOOK_URL, payload, { headers });
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
};
// Restart server function
const { exec } = require('child_process');
app.post('/api/restart', (req, res) => {
    res.json({ status: 'processing', message: 'Server restart initiated' });

    setTimeout(() => {
        exec('pm2 restart usdt-api', (error, stdout, stderr) => {
            if (error) {
                console.error('Restart failed:', error.message);
                // Optionally send to log monitoring system
                return;
            }
            console.log('Restart output:', stdout);
        });
    }, 500);
});

// Generate a deposit address from user ID (deterministic), and top up gas if needed
app.get('/api/generate-address/:userId', async (req, res) => {
  try {
    const index = parseInt(req.params.userId);
    const walletNode = hdNode.derivePath(`m/44'/60'/0'/0/${index}`);
    const address = walletNode.address;

    const balance = await provider.getBalance(address);
    const balanceInEth = parseFloat(ethers.utils.formatEther(balance));

    const threshold = 0.0005;
    const topUpAmount = "0.001";

    if (balanceInEth < threshold) {
      const centralWallet = new ethers.Wallet(CENTRAL_PK, provider);
      const tx = await centralWallet.sendTransaction({
        to: address,
        value: ethers.utils.parseEther(topUpAmount)
      });
      await tx.wait();
      res.json({ address, gasStatus: `Funded with ${topUpAmount} BNB`, txHash: tx.hash });
    } else {
      res.json({ address, gasStatus: `Sufficient gas (${balanceInEth} BNB)` });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get USDT balance of a user-derived wallet
app.get('/api/balance/:userId', async (req, res) => {
  try {
    const index = parseInt(req.params.userId);
    const wallet = hdNode.derivePath(`m/44'/60'/0'/0/${index}`);
    const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);
    const balance = await usdt.balanceOf(wallet.address);
    res.json({
      address: wallet.address,
      balance: ethers.utils.formatUnits(balance, 18)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// // Sweep USDT from user wallet to central wallet
// app.post('/api/sweep/:userId', async (req, res) => {
//   try {
//     const index = parseInt(req.params.userId);
//     const wallet = new ethers.Wallet(hdNode.derivePath(`m/44'/60'/0'/0/${index}`).privateKey, provider);
//     const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, wallet);
//     const balance = await usdt.balanceOf(wallet.address);

//     if (balance.gt(0)) {
//       const tx = await usdt.transfer(CENTRAL_WALLET, balance);
//       await tx.wait();

//       await sendWebhook({
//         type: 'deposit',
//         userId: req.params.userId,
//         amount: ethers.utils.formatUnits(balance, 18),
//         txHash: tx.hash,
//         from:CENTRAL_WALLET,
//         to: wallet.address
//       });

//       res.json({ status: 'swept', txHash: tx.hash });
//     } else {
//       res.json({ status: 'no funds to sweep' });
//     }
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });
// app.post('/api/sweep/:userId', async (req, res) => {
//   try {
//     const index = parseInt(req.params.userId);
//     const wallet = new ethers.Wallet(hdNode.derivePath(`m/44'/60'/0'/0/${index}`).privateKey, provider);
//     const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, wallet);
//     const balance = await usdt.balanceOf(wallet.address);

//     if (balance.gt(0)) {
//       // Send immediate response
//       res.json({ status: 'processing', message: 'Transaction initiated' });

//       // Process transaction in background
//       process.nextTick(async () => {
//         try {
//           const tx = await usdt.transfer(CENTRAL_WALLET, balance);
//           await tx.wait();

//           // Process webhook in background
//           setTimeout(() => {
//             sendWebhook({
//               type: 'deposit',
//               userId: req.params.userId,
//               amount: ethers.utils.formatUnits(balance, 18),
//               txHash: tx.hash,
//               from: CENTRAL_WALLET,
//               to: wallet.address
//             }).catch(console.error); // Silently fail webhook if needed
//           }, 0);
          
//         } catch (err) {
//           console.error('Background processing error:', err);
//           // Optionally log this error to a monitoring system
//         }
//       });
      
//     } else {
//       res.json({ status: 'no funds to sweep' });
//     }
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

app.post('/api/sweep/:userId', async (req, res) => {
  try {
    const index = parseInt(req.params.userId);
    const wallet = new ethers.Wallet(hdNode.derivePath(`m/44'/60'/0'/0/${index}`).privateKey, provider);
    const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, wallet);
    const balance = await usdt.balanceOf(wallet.address);

    if (balance.gt(0)) {
      // Send immediate response with request ID for tracking
      res.json({ 
        status: 'processing', 
        message: 'Sweep initiated',
        requestId,
        timestamp: new Date().toISOString()
      });

      // Process transaction in background with proper error handling
      setImmediate(async () => {
        try {
          const tx = await usdt.transfer(CENTRAL_WALLET, balance);
          const receipt = await tx.wait();

          // Parallelize non-critical operations
          await Promise.allSettled([
            // Webhook notification
            sendWebhook({
              type: 'deposit',
              userId: req.params.userId,
              amount: ethers.utils.formatUnits(balance, 18),
              txHash: tx.hash,
              from: wallet.address,
              to: CENTRAL_WALLET,
              status: receipt.status === 1 ? 'completed' : 'failed',
              requestId
            }),
            
            // Database logging
            // storeTransaction({
            //   type: 'sweep',
            //   userId: req.params.userId,
            //   amount: ethers.utils.formatUnits(balance, 18),
            //   txHash: tx.hash,
            //   status: receipt.status === 1 ? 'completed' : 'failed',
            //   requestId,
            //   timestamp: new Date()
            // })
          ]);

        } catch (err) {
          console.error(`Sweep failed for request ${requestId}:`, err);
          // Critical failure - notify monitoring system
          res.json({ 
        status: 'sweep_failed', 
        message: 'Unable to sweep funds',
        timestamp: new Date().toISOString()
      });
        }
      });
      
    } else {
      res.json({ 
        status: 'no_funds', 
        message: 'No funds available to sweep',
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    res.status(500).json({ 
      error: 'Internal server error',
      message: err.message,
      timestamp: new Date().toISOString()
    });
  }
});


// Refresh wallet: add gas if needed, sweep USDT
app.post('/api/refresh-wallet/:userId', async (req, res) => {
  try {
    const index = parseInt(req.params.userId);
    const path = `m/44'/60'/0'/0/${index}`;
    const derivedWallet = new ethers.Wallet(hdNode.derivePath(path).privateKey, provider);
    const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, derivedWallet);

    const gasBalance = await provider.getBalance(derivedWallet.address);
    const gasThreshold = ethers.utils.parseEther("0.0005");
    const gasTopUpAmount = ethers.utils.parseEther("0.001");

    if (gasBalance.lt(gasThreshold)) {
      const centralWallet = new ethers.Wallet(CENTRAL_PK, provider);
      const tx = await centralWallet.sendTransaction({
        to: derivedWallet.address,
        value: gasTopUpAmount
      });
      await tx.wait();
    }

    const usdtBalance = await usdt.balanceOf(derivedWallet.address);
    if (usdtBalance.gt(0)) {
      const tx = await usdt.transfer(CENTRAL_WALLET, usdtBalance);
      await tx.wait();

      await sendWebhook({
        type: 'deposit',
        userId: req.params.userId,
        amount: ethers.utils.formatUnits(usdtBalance, 18),
        txHash: tx.hash,
        from:CENTRAL_WALLET,
        to: derivedWallet.address
      });

      res.json({ status: 'refreshed and swept', txHash: tx.hash });
    } else {
      res.json({ status: 'no USDT to sweep' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// // Withdraw USDT from central wallet to an external address
// app.post('/api/withdraw', async (req, res) => {
//   try {
//     const { from, to, amount, userId } = req.body;
//     if (!to || !amount) {
//       return res.status(400).json({ error: 'Missing "to" or "amount" in request body' });
//     }

//     const centralWallet = new ethers.Wallet(CENTRAL_PK, provider);
//     const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, centralWallet);

//     // Check balance
//     const balance = await usdt.balanceOf(centralWallet.address);
//     const parsedAmount = ethers.utils.parseUnits(amount, 18);

//     if (balance.lt(parsedAmount)) {
//       return res.status(400).json({
//         error: `Insufficient balance. Available: ${ethers.utils.formatUnits(balance, 18)} USDT, Required: ${amount} USDT`
//       });
//     }

//     // Proceed with transfer
//     const tx = await usdt.transfer(to, parsedAmount);
//     await tx.wait();

//     await sendWebhook({
//       type: 'withdrawal',
//       userId,
//       amount,
//       txHash: tx.hash,
//       from: from,
//       to: to
//     });

//     res.json({ status: 'withdrawn', txHash: tx.hash });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });
// const withdrawQueue = new Queue('withdraw-transactions');
const withdrawQueue = new Queue('withdraw-transactions', {
  redis: { port: 6379, host: '127.0.0.1' }
});
app.post('/api/withdraw', async (req, res) => {
  try {
    const { from, to, amount, userId } = req.body;
    if (!to || !amount) {
      return res.status(400).json({ error: 'Missing "address" or "amount" in request body' });
    }

    const centralWallet = new ethers.Wallet(CENTRAL_PK, provider);
    const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, centralWallet);
    const balance = await usdt.balanceOf(centralWallet.address);
    const parsedAmount = ethers.utils.parseUnits(amount, 18);

    if (balance.lt(parsedAmount)) {
      return res.status(400).json({
        error: `Insufficient balance. Available: ${ethers.utils.formatUnits(balance, 18)} USDT, Required: ${amount} USDT`
      });
    }

    // Add to queue and respond immediately
    await withdrawQueue.add({
      userId,
      to,
      amount: parsedAmount.toString(),
      fromAddress: centralWallet.address
    });
    
    res.json({ status: 'queued', message: 'Withdrawal processing started' });
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Queue processor
withdrawQueue.process(async (job) => {
  const { userId, to, amount, fromAddress } = job.data;
  const centralWallet = new ethers.Wallet(CENTRAL_PK, provider);
  const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, centralWallet);
  const bigNumAmount = ethers.BigNumber.from(amount);
  
  const tx = await usdt.transfer(to, bigNumAmount);
  const receipt = await tx.wait();
  
  // Send webhook
  await sendWebhook({
    type: 'withdrawal',
    userId,
    amount: ethers.utils.formatUnits(bigNumAmount, 18),
    txHash: tx.hash,
    from: fromAddress,
    to: to
  });

  // Store transaction in DB
  // await storeTransactionInDB({
  //   userId,
  //   amount: ethers.utils.formatUnits(bigNumAmount, 18),
  //   txHash: tx.hash,
  //   status: receipt.status === 1 ? 'completed' : 'failed',
  //   timestamp: new Date()
  // });
});
// New endpoint: Get USDT and gas balances for multiple userIds
app.post('/api/batch-wallet-info', async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds must be an array' });

    const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, provider);

    const results = await Promise.all(userIds.map(async (id) => {
      try {
        const index = parseInt(id);
        const path = `m/44'/60'/0'/0/${index}`;
        const wallet = hdNode.derivePath(path);
        const gasBalance = await provider.getBalance(wallet.address);
        const usdtBalance = await usdt.balanceOf(wallet.address);
        return {
          userId: id,
          address: wallet.address,
          gas: parseFloat(ethers.utils.formatEther(gasBalance)),
          usdt: parseFloat(ethers.utils.formatUnits(usdtBalance, 18))
        };
      } catch (err) {
        return { userId: id, error: err.message };
      }
    }));

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enhanced health check endpoint
app.get('/api/health', async (req, res) => {
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
      database: {
        status: 'ok' // Assuming you'll add DB checks later
      }
    }
  };

  try {
    // Check blockchain provider connection
    const blockNumber = await provider.getBlockNumber();
    const network = await provider.getNetwork();
    const gasPrice = await provider.getGasPrice();

    healthCheck.components.blockchain = {
      status: 'ok',
      network: network.name,
      chainId: network.chainId,
      blockNumber: blockNumber,
      gasPrice: ethers.utils.formatUnits(gasPrice, 'gwei') + ' gwei',
      lastChecked: new Date().toISOString()
    };
  } catch (err) {
    healthCheck.status = 'degraded';
    healthCheck.components.blockchain = {
      status: 'error',
      error: err.message,
      lastChecked: new Date().toISOString()
    };
  }

  // Set overall status based on components
  if (healthCheck.components.blockchain.status === 'error') {
    healthCheck.status = 'degraded';
    healthCheck.message = 'API is running but blockchain connection failed';
  } else {
    healthCheck.message = 'USDT wallet API is fully operational';
  }

  // Return appropriate status code
  const statusCode = healthCheck.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(healthCheck);
});

// Server startup with error handling
const PORT = process.env.PORT || 3000;
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
