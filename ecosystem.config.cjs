/** PM2 — local always-on (backup if cloud is not used) */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'arctrade-bot',
      cwd: __dirname,
      script: 'npx',
      args: 'tsx src/index.ts',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        // Pin data dir so restarts never open a different empty DB
        DATA_DIR: path.join(__dirname, 'data'),
      },
      max_restarts: 100,
      min_uptime: '5s',
      exp_backoff_restart_delay: 1000,
      autorestart: true,
      watch: false,
    },
  ],
};
