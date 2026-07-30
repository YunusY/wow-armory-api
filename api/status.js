const statusLog = require('../lib/statusLog');

function jsonHandler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
    return res.status(200).json({ now: new Date().toISOString(), log: statusLog.getLog() });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

const EVENT_LABELS = {
    cycle_started: 'cycle started',
    roster_fetched: 'roster fetched',
    baseline_batch_complete: 'baseline batch complete',
    evoker_batch_complete: 'evoker batch complete',
    cycle_complete: 'cycle complete',
    cycle_failed: 'cycle failed',
    on_demand_started: 'on-demand sim started',
    on_demand_complete: 'on-demand sim complete',
    on_demand_failed: 'on-demand sim failed'
};

function htmlHandler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    const log = statusLog.getLog();
    const rows = log.map((entry) => {
        const label = EVENT_LABELS[entry.event] || entry.event;
        const detail = entry.detail ? escapeHtml(JSON.stringify(entry.detail)) : '';
        const isFailure = entry.event.endsWith('_failed');
        return `<tr class="${isFailure ? 'fail' : ''}">
            <td class="ts">${escapeHtml(entry.timestamp)}</td>
            <td class="event">${escapeHtml(label)}</td>
            <td class="detail">${detail}</td>
        </tr>`;
    }).join('\n');

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>wow-armory-api status</title>
<style>
  body { font-family: ui-monospace, Consolas, monospace; background: #111; color: #ddd; margin: 0; padding: 1.5rem; }
  h1 { font-size: 1rem; font-weight: normal; color: #888; margin: 0 0 1rem; }
  h1 span { color: #ddd; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  td { padding: 4px 10px; border-bottom: 1px solid #222; vertical-align: top; }
  .ts { color: #666; white-space: nowrap; }
  .event { color: #7fc; white-space: nowrap; }
  .detail { color: #ccc; word-break: break-all; }
  tr.fail .event { color: #f77; }
  .empty { color: #666; padding: 1rem 0; }
</style>
</head>
<body>
<h1>wow-armory-api — <span>${escapeHtml(new Date().toISOString())}</span> (auto-refreshes every 5s)</h1>
${log.length ? `<table>${rows}</table>` : '<div class="empty">No activity logged yet.</div>'}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
}

module.exports = { jsonHandler, htmlHandler };
