// Blockchain Configuration
const USDT_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"; // BEP20 USDT
const GAS_THRESHOLD = "0.0005"; // Minimum gas balance threshold
const GAS_TOP_UP_AMOUNT = "0.001"; // Amount to top up when below threshold

// USDT Contract ABI (minimal required functions)
const USDT_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// API Configuration
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.HMAC_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

module.exports = {
  USDT_CONTRACT,
  USDT_ABI,
  GAS_THRESHOLD,
  GAS_TOP_UP_AMOUNT,
  PORT,
  WEBHOOK_URL,
  WEBHOOK_SECRET
}; 