const crypto = require('crypto');
const axios = require('axios');
const { WEBHOOK_URL, WEBHOOK_SECRET } = require('../config/constants');

class WebhookService {
  constructor() {
    // Validate required configuration
    if (!WEBHOOK_URL) {
      console.error('WEBHOOK_URL is not configured. Please set WEBHOOK_URL environment variable.');
    }
    if (!WEBHOOK_SECRET) {
      console.error('WEBHOOK_SECRET is not configured. Please set HMAC_SECRET environment variable.');
    }
  }

  /**
   * Generate HMAC signature matching Laravel's format
   */
  generateSignature(payload, timestamp) {
    // Convert payload to string (raw request body)
    const payloadString = JSON.stringify(payload);
    
    // Concatenate payload and timestamp exactly as Laravel does
    const dataToSign = payloadString + timestamp;
    
    // Generate HMAC signature using sha256
    return crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(dataToSign)
      .digest('hex');
  }

  /**
   * Send webhook notification with retry logic
   */
  async sendWebhook(payload, type) {
    try {
      if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
        console.error('Webhook configuration missing:', {
          hasUrl: !!WEBHOOK_URL,
          hasSecret: !!WEBHOOK_SECRET,
          timestamp: new Date().toISOString()
        });
        return;
      }

      // Log the payload
      console.log(`Sending ${type} webhook payload:`, {
        payload,
        url: WEBHOOK_URL,
        timestamp: new Date().toISOString()
      });

      // Get current timestamp
      const timestamp = new Date().toISOString();

      // Generate signature matching Laravel's format
      const signature = this.generateSignature(payload, timestamp);
      console.log('Generated signature:', signature);

      // Send webhook with retry logic
      let retries = 3;
      while (retries > 0) {
        try {
          const response = await axios.post(WEBHOOK_URL, payload, {
            headers: {
              'Content-Type': 'application/json',
              'X-Hmac-Signature': signature,
              'X-Timestamp': timestamp
            },
            timeout: 10000 // 10 second timeout
          });

          if (response.status === 200) {
            console.log(`${type} webhook notification sent successfully:`, {
              userId: payload.userId,
              txHash: payload.txHash,
              status: response.status,
              timestamp: new Date().toISOString()
            });
            return;
          }
        } catch (error) {
          console.error(`${type} webhook request failed:`, {
            error: error.message,
            status: error.response?.status,
            data: error.response?.data,
            requestData: payload,
            signature,
            timestamp,
            retriesLeft: retries - 1,
            timestamp: new Date().toISOString()
          });

          if (retries === 1) {
            throw error;
          }
          
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, (3 - retries) * 1000));
        }
        retries--;
      }
    } catch (error) {
      console.error(`${type} webhook error:`, {
        error: error.message,
        payload,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Send withdrawal notification to webhook URL
   */
  async sendWithdrawalNotification(userId, data) {
    const payload = {
      type: 'withdrawal',
      userId: userId,
      status: data.status,
      amount: data.amount,
      txHash: data.txHash,
      from: data.from,
      to: data.to,
      timestamp: data.timestamp
    };

    if (data.error) {
      payload.error = data.error;
    }

    return this.sendWebhook(payload, 'withdrawal');
  }

  /**
   * Send deposit notification to webhook URL
   */
  async sendDepositNotification(userId, data) {
    const payload = {
      type: 'deposit',
      userId: userId,
      status: data.status,
      amount: data.amount,
      txHash: data.txHash,
      from: data.from,
      to: data.to,
      timestamp: data.timestamp
    };

    if (data.error) {
      payload.error = data.error;
    }

    return this.sendWebhook(payload, 'deposit');
  }
}

module.exports = new WebhookService(); 