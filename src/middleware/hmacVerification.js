const crypto = require('crypto');

/**
 * Middleware to verify HMAC signature for API requests
 * Ensures request authenticity and integrity
 */
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

module.exports = verifyHmac; 