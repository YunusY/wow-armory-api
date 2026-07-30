// A small in-memory rolling log of what the server has been doing —
// background cycles and on-demand requests. Not persisted to disk on
// purpose: it's a live "what's happening" view, not data that needs to
// survive a restart the way the accumulated sim cache does.
const MAX_ENTRIES = 200;

let entries = [];

function log(event, detail) {
    const entry = { timestamp: new Date().toISOString(), event, detail: detail || null };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    console.log(`[status] ${event}${detail ? ' ' + JSON.stringify(detail) : ''}`);
    return entry;
}

function getLog() {
    return entries.slice().reverse(); // most recent first
}

module.exports = { log, getLog };
