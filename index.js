// File: index.js
require('dotenv').config();
const crypto = require('crypto');

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
// app.use('/api', verifyHmac);

// Load environment variables
const MNEMONIC = process.env.MNEMONIC;
const CENTRAL_WALLET = process.env.CENTRAL_WALLET;
const CENTRAL_PK = process.env.CENTRAL_PK;
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

// Sweep USDT from user wallet to central wallet
app.post('/api/sweep/:userId', async (req, res) => {
  try {
    const index = parseInt(req.params.userId);
    const wallet = new ethers.Wallet(hdNode.derivePath(`m/44'/60'/0'/0/${index}`).privateKey, provider);
    const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, wallet);
    const balance = await usdt.balanceOf(wallet.address);

    if (balance.gt(0)) {
      const tx = await usdt.transfer(CENTRAL_WALLET, balance);
      await tx.wait();

      await sendWebhook({
        type: 'deposit',
        userId: req.params.userId,
        amount: ethers.utils.formatUnits(balance, 18),
        txHash: tx.hash,
        from:CENTRAL_WALLET,
        to: wallet.address
      });

      res.json({ status: 'swept', txHash: tx.hash });
    } else {
      res.json({ status: 'no funds to sweep' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Withdraw USDT from central wallet to an external address
app.post('/api/withdraw', async (req, res) => {
  try {
    const { from, to, amount, userId } = req.body;
    if (!to || !amount) {
      return res.status(400).json({ error: 'Missing "to" or "amount" in request body' });
    }

    const centralWallet = new ethers.Wallet(CENTRAL_PK, provider);
    const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, centralWallet);

    // Check balance
    const balance = await usdt.balanceOf(centralWallet.address);
    const parsedAmount = ethers.utils.parseUnits(amount, 18);

    if (balance.lt(parsedAmount)) {
      return res.status(400).json({
        error: `Insufficient balance. Available: ${ethers.utils.formatUnits(balance, 18)} USDT, Required: ${amount} USDT`
      });
    }

    // Proceed with transfer
    const tx = await usdt.transfer(to, parsedAmount);
    await tx.wait();

    await sendWebhook({
      type: 'withdrawal',
      userId,
      amount,
      txHash: tx.hash,
      from: from,
      to: to
    });

    res.json({ status: 'withdrawn', txHash: tx.hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

//Auto detect transfer and sweep it
// usdtContract.on("Transfer", async (from, to, value, event) => {
//   try {
//     for (let i = 0; i < 1000; i++) {
//       const derivedNode = getDerivedWallet(i);
//       const userAddress = derivedNode.address;

//       if (to.toLowerCase() === userAddress.toLowerCase()) {
//         const derivedWallet = new ethers.Wallet(derivedNode.privateKey, provider);
//         const usdt = new ethers.Contract(USDT_CONTRACT, usdtAbi, derivedWallet);

//         // Send webhook for deposit
//         await sendWebhook({
//           type: 'deposit',
//           userId: i,
//           amount: ethers.utils.formatUnits(value, 18),
//           txHash: event.transactionHash,
//           wallet: to
//         });

//         // Check gas and top up if needed
//         const gasBalance = await provider.getBalance(userAddress);
//         const gasThreshold = ethers.utils.parseEther("0.0005");
//         const gasTopUpAmount = ethers.utils.parseEther("0.001");

//         if (gasBalance.lt(gasThreshold)) {
//           const centralWallet = new ethers.Wallet(CENTRAL_PK, provider);
//           const tx = await centralWallet.sendTransaction({
//             to: userAddress,
//             value: gasTopUpAmount
//           });
//           await tx.wait(); // wait for gas tx
//         }

//         // Sweep the USDT to central wallet
//         const usdtBalance = await usdt.balanceOf(userAddress);
//         if (usdtBalance.gt(0)) {
//           const sweepTx = await usdt.transfer(CENTRAL_WALLET, usdtBalance);
//           await sweepTx.wait();

//           // Notify again with sweep info
//           await sendWebhook({
//             type: 'auto-sweep',
//             userId: i,
//             amount: ethers.utils.formatUnits(usdtBalance, 18),
//             txHash: sweepTx.hash,
//             wallet: userAddress
//           });
//         }

//         break; // stop loop once found
//       }
//     }
//   } catch (err) {
//     console.error("Auto sweep on Transfer error:", err.message);
//   }
// });


// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'USDT wallet API is running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`USDT Wallet API running on port ${PORT}`));
