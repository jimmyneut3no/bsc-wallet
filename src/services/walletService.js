const { ethers } = require('ethers');
const { getWalletCredentials } = require('../utils/dbCredentials');
const { USDT_CONTRACT, USDT_ABI, GAS_THRESHOLD, GAS_TOP_UP_AMOUNT } = require('../config/constants');

class WalletService {
  constructor() {
    this.provider = null;
    this.hdNode = null;
    this.centralWallet = null;
    this.centralAddress = null;
    this.usdtContract = null;
  }

  /**
   * Initialize wallet service with provider and credentials
   */
  async initialize() {
    try {
      const credentials = await getWalletCredentials();
      this.provider = new ethers.providers.JsonRpcProvider(process.env.BSC_RPC);
      this.hdNode = ethers.utils.HDNode.fromMnemonic(credentials.MNEMONIC);
      this.centralWallet = new ethers.Wallet(credentials.CENTRAL_PK, this.provider);
      this.centralAddress = credentials.CENTRAL_WALLET;
      this.usdtContract = new ethers.Contract(USDT_CONTRACT, USDT_ABI, this.provider);

      console.log(`Wallet initialized: ${this.centralAddress}`);
      console.log(`Current balance: ${ethers.utils.formatEther(await this.centralWallet.getBalance())} ETH`);
    } catch (err) {
      console.error('Failed to initialize wallet:', err);
      throw err;
    }
  }

  /**
   * Generate a wallet address for a user ID
   */
  async generateAddress(userId) {
    const index = parseInt(userId);
    const walletNode = this.hdNode.derivePath(`m/44'/60'/0'/0/${index}`);
    return walletNode.address;
  }

  /**
   * Get USDT balance for a wallet
   */
  async getUsdtBalance(address) {
    const balance = await this.usdtContract.balanceOf(address);
    return ethers.utils.formatUnits(balance, 18);
  }

  /**
   * Get gas balance for a wallet
   */
  async getGasBalance(address) {
    const balance = await this.provider.getBalance(address);
    return ethers.utils.formatEther(balance);
  }

  /**
   * Top up gas for a wallet if below threshold
   */
  async topUpGas(address) {
    const balance = await this.getGasBalance(address);
    if (parseFloat(balance) < parseFloat(GAS_THRESHOLD)) {
      const tx = await this.centralWallet.sendTransaction({
        to: address,
        value: ethers.utils.parseEther(GAS_TOP_UP_AMOUNT)
      });
      await tx.wait();
      return tx.hash;
    }
    return null;
  }

  /**
   * Sweep USDT from a wallet to central wallet
   */
  async sweepUsdt(userId) {
    const index = parseInt(userId);
    const wallet = new ethers.Wallet(
      this.hdNode.derivePath(`m/44'/60'/0'/0/${index}`).privateKey,
      this.provider
    );
    const usdt = new ethers.Contract(USDT_CONTRACT, USDT_ABI, wallet);
    const balance = await usdt.balanceOf(wallet.address);

    if (balance.gt(0)) {
      const tx = await usdt.transfer(this.centralAddress, balance);
      const receipt = await tx.wait();
      return {
        txHash: tx.hash,
        amount: ethers.utils.formatUnits(balance, 18),
        status: receipt.status === 1 ? 'completed' : 'failed',
        from:this.centralAddress,
        to: wallet.address
      };
    }
    return null;
  }

  /**
   * Withdraw USDT from central wallet
   */
  async withdrawUsdt(to, amount) {
    const parsedAmount = ethers.utils.parseUnits(amount, 18);
    const balance = await this.usdtContract.balanceOf(this.centralAddress);

    if (balance.lt(parsedAmount)) {
      throw new Error(`Insufficient balance. Available: ${ethers.utils.formatUnits(balance, 18)} USDT`);
    }

    const tx = await this.usdtContract.connect(this.centralWallet).transfer(to, parsedAmount);
    const receipt = await tx.wait();
    return {
      txHash: tx.hash,
      status: receipt.status === 1 ? 'completed' : 'failed'
    };
  }
}

module.exports = new WalletService(); 