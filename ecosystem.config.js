module.exports = {
  apps: [
    {
      name: 'beauty-crm-api',
      script: 'dist/src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
