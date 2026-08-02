// Load environment variables from .env.local
require('dotenv').config({ path: '.env.local' });

const express = require('express');
const handler = require('./api/index.js');
const status = require('./api/status.js');
const tracker = require('./lib/simTracker.js');

const app = express();
const PORT = 3000;

// Route requests to your Vercel serverless function
app.get('/api/get-simc', handler);
app.get('/api/status', status.jsonHandler);
app.get('/status', status.htmlHandler);

tracker.load();
tracker.startWorker();

app.listen(PORT, () => {
    console.log(`\n🚀 Local server running at: http://localhost:${PORT}`);
    console.log(`Test link:\nhttp://localhost:${PORT}/api/get-simc?sim=true\n`);
    console.log(`Status page:\nhttp://localhost:${PORT}/status\n`);
});
