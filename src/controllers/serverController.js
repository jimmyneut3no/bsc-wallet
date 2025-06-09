const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class ServerController {
  /**
   * Restart the server using PM2
   */
  async restartServer(req, res) {
    try {
      // Send immediate response
      res.json({ 
        status: 'processing', 
        message: 'Server restart initiated',
        timestamp: new Date().toISOString()
      });

      // Execute restart command with proper error handling
      const { stdout, stderr } = await execPromise('pm2 restart usdt-api');
      
      if (stderr) {
        console.error('Restart stderr:', stderr);
      }
      
      console.log('Restart stdout:', stdout);
      
      // Log successful restart
      console.log('Server restarted successfully');
    } catch (error) {
      console.error('Server restart failed:', error);
      // Note: We can't send response here as we already sent one
      // But we can log the error for monitoring
    }
  }

  /**
   * Get server status
   */
  async getServerStatus(req, res) {
    try {
      const { stdout } = await execPromise('pm2 jlist');
      const processes = JSON.parse(stdout);
      const apiProcess = processes.find(p => p.name === 'usdt-api');

      if (!apiProcess) {
        return res.status(404).json({
          status: 'error',
          message: 'USDT API process not found in PM2'
        });
      }

      res.json({
        status: 'ok',
        process: {
          name: apiProcess.name,
          status: apiProcess.pm2_env.status,
          uptime: apiProcess.pm2_env.pm_uptime,
          memory: apiProcess.monit.memory,
          cpu: apiProcess.monit.cpu,
          restarts: apiProcess.pm2_env.restart_time
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Failed to get server status:', error);
      res.status(500).json({
        status: 'error',
        message: 'Failed to get server status',
        error: error.message
      });
    }
  }
}

module.exports = new ServerController(); 