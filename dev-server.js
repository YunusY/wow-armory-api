// Load environment variables from .env.local
require('dotenv').config({ path: '.env.local' });

const express = require('express');
const handler = require('./api/index.js');

const app = express();
const PORT = 3000;

// Route requests to your Vercel serverless function
app.get('/api/get-simc', handler);

app.listen(PORT, () => {
    console.log(`\n🚀 Local server running at: http://localhost:${PORT}`);
    console.log(`Test link:\nhttp://localhost:${PORT}/api/get-simc?raid=tier-mn-1&boss=midnight-falls&difficulty=mythic&region=eu&realm=tarren-mill&guild=echo\n`);
});