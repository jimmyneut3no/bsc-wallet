const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Initialize connection pool with optional SSL
const getPoolConfig = () => {
  const baseConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };

  // Only add SSL config if CA path is specified
  if (process.env.MYSQL_SSL_CA_PATH) {
    try {
      const caPath = path.resolve(process.env.MYSQL_SSL_CA_PATH);
      if (!fs.existsSync(caPath)) {
        console.warn('SSL CA file not found at:', caPath);
        return baseConfig;
      }
      
      return {
        ...baseConfig,
        ssl: {
          rejectUnauthorized: true,
          ca: fs.readFileSync(caPath)
        }
      };
    } catch (err) {
      console.error('SSL configuration error:', err);
      return baseConfig;
    }
  }

  return baseConfig;
};

const pool = mysql.createPool(getPoolConfig());

/**
 * Get latest active credentials from database
 */
async function getWalletCredentials() {
  let connection;
  try {
    connection = await pool.getConnection();
    
    const [rows] = await connection.query(
      `SELECT 
         wallet_address,
         bsc_private_key,
         mnemonic
       FROM credentials
       ORDER BY created_at DESC
       LIMIT 1`
    );

    if (rows.length === 0) {
      throw new Error('No active wallet credentials found');
    }

    const creds = rows[0];
    
    return {
      CENTRAL_WALLET: creds.wallet_address,
      CENTRAL_PK: creds.bsc_private_key,
      MNEMONIC: creds.mnemonic 
       };
    
  } catch (err) {
    console.error('Failed to fetch credentials:', err);
    throw err;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  getWalletCredentials
};