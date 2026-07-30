// Load environment variables from .env.local
require('dotenv').config({ path: '.env.local' });

const express = require('express');
const handler = require('./api/index.js');
const tracker = require('./lib/simTracker.js');

const app = express();
const PORT = 3000;

// Route requests to your Vercel serverless function
app.get('/api/get-simc', handler);

tracker.load();
tracker.runAllGuildCycles().catch(e => console.error('initial cycle failed:', e));
setInterval(() => tracker.runAllGuildCycles().catch(e => console.error('cycle failed:', e)), 5 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`\n🚀 Local server running at: http://localhost:${PORT}`);
    console.log(`Test link:\nhttp://localhost:${PORT}/api/get-simc?sim=true\n`);
});
