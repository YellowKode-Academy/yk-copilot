const http = require('http');
const req = http.request(
  { hostname: 'localhost', port: process.env.MCP_PORT || 8931, path: '/health', method: 'GET', timeout: 5000 },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1)
);
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.end();
