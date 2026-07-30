const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handler = require('./api/index.js');
const tracker = require('./lib/simTracker.js');

const app = express();
const PORT = process.env.PORT || 3000;
const reportsDir = process.env.REPORTS_DIR || path.join(os.tmpdir(), 'wow-armory-api-reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
}

console.log(`Reports directory: ${reportsDir}`);

const CYCLE_INTERVAL_MS = 5 * 60 * 1000;
let cycleRunning = false;

async function runCycleSafely() {
    if (cycleRunning) {
        console.warn('simTracker: previous cycle still running, skipping this tick');
        return;
    }
    cycleRunning = true;
    try {
        await tracker.runAllGuildCycles();
    } catch (error) {
        console.error('simTracker: unexpected cycle error', error);
    } finally {
        cycleRunning = false;
    }
}

tracker.load();
runCycleSafely();
const cycleTimer = setInterval(runCycleSafely, CYCLE_INTERVAL_MS);

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${signal} received, shutting down gracefully`);
    clearInterval(cycleTimer);
    try {
        await tracker.persist();
    } catch (error) {
        console.error('flush on shutdown failed:', error);
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
    console.error('uncaughtException:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason);
});

// Serve static HTML reports directly if requested
app.use('/reports', express.static(reportsDir));

// Route for simulation API
app.get('/api/get-simc', handler);

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Node 18+ defaults http.Server.requestTimeout to 300000ms (5 min), which
// used to collide with the old synchronous multi-minute sim runs. sim=true
// is now an instant cache read, but keep a generous explicit timeout anyway
// to protect the still-live plain-text export path.
server.requestTimeout = 10 * 60 * 1000;
