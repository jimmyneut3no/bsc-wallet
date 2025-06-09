const Queue = require('bull');
const walletService = require('./walletService');
const webhookService = require('./webhookService');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { ethers } = require('ethers');

class QueueService {
  constructor() {
    this.isRedisAvailable = false;
    this.queue = null;
    this.inMemoryJobs = new Map();
    this.initializeQueue();
  }

  /**
   * Check if Redis is available
   */
  async checkRedisConnection() {
    try {
      const testQueue = new Queue('test-connection', {
        redis: {
          port: 6379,
          host: '127.0.0.1',
          connectTimeout: 5000,
          maxRetriesPerRequest: 1
        }
      });
      await testQueue.isReady();
      await testQueue.close();
      return true;
    } catch (error) {
      console.error('Redis connection check failed:', error.message);
      return false;
    }
  }

  /**
   * Initialize queue with retry logic
   */
  async initializeQueue(retryCount = 0) {
    try {
      // Try to connect to Redis
      this.queue = new Queue('usdt-withdrawals', {
        redis: {
          host: '127.0.0.1',
          port: 6379,
          connectTimeout: 30000,
          commandTimeout: 10000,
          retryStrategy: (times) => {
            if (times > 3) {
              this.isRedisAvailable = false;
              return null; // Stop retrying
            }
            return Math.min(times * 1000, 3000);
          }
        },
        settings: {
          lockDuration: 30000,
          stalledInterval: 30000,
          maxStalledCount: 2,
          guardInterval: 5000,
          retryProcessDelay: 5000
        }
      });

      // Test Redis connection
      await this.queue.isReady();
      this.isRedisAvailable = true;
      console.log('Redis connection established');

      // Setup queue processor if Redis is available
      this.setupQueueProcessor();
      this.setupQueueEvents();

    } catch (error) {
      console.warn('Redis connection failed, using direct processing:', error.message);
      this.isRedisAvailable = false;
      
      if (retryCount < 3) {
        console.log(`Retrying queue initialization (${retryCount + 1}/3)...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return this.initializeQueue(retryCount + 1);
      } else {
        console.warn('Failed to initialize queue after multiple retries. Using in-memory fallback.');
      }
    }
  }

  /**
   * Process withdrawal directly when Redis is unavailable
   */
  async processWithdrawal(data) {
    const { userId, to, amount, fromAddress, requestId } = data;

    try {
      // Process withdrawal directly
      const result = await walletService.withdrawUsdt(to, amount);
      
      if (!result || !result.txHash) {
        throw new Error('Transaction hash not received from withdrawal');
      }

      // Update job status
      const jobStatus = {
        id: requestId,
        status: 'completed',
        result: {
          txHash: result.txHash,
          from: fromAddress,
          to,
          amount,
          timestamp: new Date().toISOString()
        }
      };

      // Store status in memory
      this.inMemoryJobs.set(requestId, jobStatus);

      // Send webhook notification with proper data format
      await webhookService.sendWithdrawalNotification(userId, {
        status: 'completed',
        txHash: result.txHash,
        from: fromAddress,
        to,
        amount,
        timestamp: new Date().toISOString(),
        type: 'withdrawal',
        userId: userId
      });

      return jobStatus;
    } catch (error) {
      console.error('Direct withdrawal processing failed:', {
        requestId,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      // Update job status
      const jobStatus = {
        id: requestId,
        status: 'failed',
        error: error.message,
        timestamp: new Date().toISOString()
      };

      // Store status in memory
      this.inMemoryJobs.set(requestId, jobStatus);

      // Send webhook notification with proper data format
      await webhookService.sendWithdrawalNotification(userId, {
        status: 'failed',
        error: error.message,
        from: fromAddress,
        to,
        amount,
        timestamp: new Date().toISOString(),
        type: 'withdrawal',
        userId: userId
      });

      throw error;
    }
  }

  /**
   * Get job status with fallback
   */
  async getJobStatus(jobId) {
    try {
      if (this.isRedisAvailable && this.queue) {
        const job = await this.queue.getJob(jobId);
        if (job) {
          return {
            id: job.id,
            status: await job.getState(),
            progress: job.progress(),
            result: job.returnvalue,
            error: job.failedReason,
            timestamp: new Date().toISOString()
          };
        }
      }

      // Check in-memory jobs
      const inMemoryJob = this.inMemoryJobs.get(jobId);
      if (inMemoryJob) {
        return {
          ...inMemoryJob,
          timestamp: new Date().toISOString()
        };
      }

      return null;
    } catch (error) {
      console.error('Error getting job status:', error);
      return null;
    }
  }

  /**
   * Setup queue processor for withdrawal transactions
   */
  setupQueueProcessor() {
    this.queue.process(async (job) => {
      const { userId, to, amount, fromAddress } = job.data;
      
      try {
        // Add job progress
        await job.progress(10);

        // Verify balance again before processing
        const balance = await walletService.getUsdtBalance(walletService.centralAddress);
        if (parseFloat(balance) < parseFloat(amount)) {
          throw new Error(`Insufficient balance. Available: ${balance} USDT, Required: ${amount} USDT`);
        }

        await job.progress(30);

        // Process withdrawal with timeout
        const result = await Promise.race([
          walletService.withdrawUsdt(to, amount),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Withdrawal operation timed out')), 30000)
          )
        ]);
        
        await job.progress(70);

        // Send webhook notification
        await webhookService.sendWithdrawalNotification(
          userId,
          amount,
          result.txHash,
          fromAddress,
          to
        );

        await job.progress(100);

        return {
          status: 'completed',
          txHash: result.txHash,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        console.error(`Withdrawal failed for job ${job.id}:`, {
          error: error.message,
          jobData: job.data,
          timestamp: new Date().toISOString()
        });

        // Rethrow error to trigger retry
        throw error;
      }
    });
  }

  /**
   * Setup queue event handlers
   */
  setupQueueEvents() {
    this.queue.on('error', (error) => {
      console.error('Queue error:', {
        error: error.message,
        timestamp: new Date().toISOString()
      });
    });

    this.queue.on('failed', (job, error) => {
      console.error(`Job ${job.id} failed:`, {
        error: error.message,
        jobData: job.data,
        timestamp: new Date().toISOString()
      });
    });

    this.queue.on('stalled', (job) => {
      console.warn(`Job ${job.id} stalled:`, {
        jobData: job.data,
        timestamp: new Date().toISOString()
      });
    });

    this.queue.on('completed', (job, result) => {
      console.log(`Job ${job.id} completed:`, {
        result,
        timestamp: new Date().toISOString()
      });
    });
  }
}

module.exports = new QueueService(); 