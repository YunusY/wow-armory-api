const statusLog = require('../lib/statusLog');
const tracker = require('../lib/simTracker');
const { TRACKED_GUILDS } = require('../lib/guilds');

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
    manifest_refreshed: 'manifest refreshed',
    manifest_refresh_failed: 'manifest refresh failed',
    cutoff_probe: 'cutoff probe',
    cutoff_discovered: 'cutoff discovered',
    pull_sim_started: 'pull sim started',
    pull_simmed: 'pull simmed',
    pull_sim_failed: 'pull sim failed',
    pull_sim_skipped: 'pull skipped (unsimmable)',
    on_demand_started: 'on-demand sim started',
    on_demand_complete: 'on-demand sim complete',
    on_demand_failed: 'on-demand sim failed'
};

function timeAgo(iso) {
    if (!iso) return 'never';
    const diffMs = Date.now() - new Date(iso).getTime();
    const s = Math.max(0, Math.round(diffMs / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

// Derives each tracked guild's current state by walking the activity log
// (newest first) for the most recent entry that mentions it. The log is
// in-memory only and empty right after a restart — falls back to the
// persisted view (backlog/history) so a guild that's actually caught up
// (or has a known backlog) doesn't misleadingly read as "no data" just
// because nothing's been logged yet in this process's lifetime.
function computeGuildActivity(guildKey, log, view) {
    for (const entry of log) {
        if (!entry.detail || entry.detail.guild !== guildKey) continue;
        if (entry.event === 'pull_sim_started') {
            return { state: 'running', label: 'simming pull', since: entry.timestamp };
        }
        if (entry.event === 'pull_simmed' || entry.event === 'pull_sim_skipped') {
            return { state: 'ok', since: entry.timestamp };
        }
        if (entry.event === 'pull_sim_failed') {
            return {
                state: entry.detail.cancelled ? 'preempted' : 'error',
                since: entry.timestamp,
                error: entry.detail.error
            };
        }
    }
    if (view.lastActivityAt) {
        return { state: view.backlog > 0 ? 'idle' : 'ok', since: view.lastActivityAt };
    }
    return { state: 'unknown' };
}

function summarizeGuildView(view) {
    const latest = view.history[0] || null;
    return {
        backlog: view.backlog,
        currentIterations: view.currentIterations,
        latestBoss: latest ? latest.boss : null,
        latestTotalDps: latest ? latest.totalDps : null,
        latestPlayerCount: latest ? latest.playerCount : null,
        evokers: latest ? latest.evokers.slice().sort((a, b) => b.contribution - a.contribution) : []
    };
}

const STATE_META = {
    running: { dot: 'run', label: 'Running' },
    ok: { dot: 'ok', label: 'Up to date' },
    idle: { dot: 'ok', label: 'Idle' },
    preempted: { dot: 'warn', label: 'Preempted' },
    error: { dot: 'err', label: 'Error' },
    unknown: { dot: 'unk', label: 'No data yet' }
};

function prettifySlug(slug) {
    if (!slug) return null;
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function renderGuildCard(guildKey, log) {
    const view = tracker.getGuildView(guildKey, { limit: 1 });
    const activity = computeGuildActivity(guildKey, log, view);
    const summary = summarizeGuildView(view);
    const meta = STATE_META[activity.state];

    const evokerRows = summary.evokers.map(e => `
        <div class="evoker-row">
            <span class="evoker-name">${escapeHtml(e.name)}</span>
            <span class="evoker-contribution">+${e.contribution.toLocaleString('en-US')} dps</span>
        </div>`).join('');

    const activityLine = activity.state === 'running'
        ? `${escapeHtml(activity.label)}…`
        : activity.state === 'error'
            ? `<span class="err-text">${escapeHtml(activity.error || 'failed')}</span> · ${timeAgo(activity.since)}`
            : activity.state === 'preempted'
                ? `preempted by an on-demand request · ${timeAgo(activity.since)}`
                : activity.state === 'ok'
                    ? `updated ${timeAgo(activity.since)}`
                    : activity.state === 'idle'
                        ? `idle · last active ${timeAgo(activity.since)}`
                        : 'waiting on first pull';

    const bossName = prettifySlug(summary.latestBoss);

    return `
    <div class="card">
        <div class="card-head">
            <div>
                <h2>${escapeHtml(guildKey)}</h2>
                ${bossName ? `<div class="boss">${escapeHtml(bossName)}</div>` : ''}
            </div>
            <span class="pill ${meta.dot}"><i></i>${meta.label}</span>
        </div>
        <div class="stat-row">
            <div class="stat"><span class="stat-value">${summary.backlog.toLocaleString('en-US')}</span><span class="stat-label">backlog</span></div>
            <div class="stat"><span class="stat-value">${summary.currentIterations ?? '—'}</span><span class="stat-label">iterations</span></div>
            <div class="stat"><span class="stat-value">${summary.latestTotalDps ? summary.latestTotalDps.toLocaleString('en-US') : '—'}</span><span class="stat-label">latest dps</span></div>
        </div>
        ${evokerRows ? `<div class="evokers">${evokerRows}</div>` : ''}
        <div class="activity-line">${activityLine}</div>
    </div>`;
}

function htmlHandler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    const log = statusLog.getLog();
    const guildCards = Object.keys(TRACKED_GUILDS).map(key => renderGuildCard(key, log)).join('\n');

    const onDemand = log[0] && log[0].event === 'on_demand_started' ? log[0] : null;
    const banner = onDemand
        ? `<div class="banner">⚡ On-demand sim in progress for <strong>${escapeHtml(onDemand.detail.guild)}</strong> (${escapeHtml(onDemand.detail.raid)} / ${escapeHtml(onDemand.detail.boss)}) — preempting the background loop</div>`
        : '';

    const logRows = log.map((entry) => {
        const label = EVENT_LABELS[entry.event] || entry.event;
        const detail = entry.detail ? escapeHtml(JSON.stringify(entry.detail)) : '';
        const isFailure = entry.event.endsWith('_failed');
        return `<tr class="${isFailure ? 'fail' : ''}">
            <td class="ts" title="${escapeHtml(entry.timestamp)}">${timeAgo(entry.timestamp)}</td>
            <td class="event">${escapeHtml(label)}</td>
            <td class="detail">${detail}</td>
        </tr>`;
    }).join('\n');

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>wow-armory-api status</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d12; --panel: #12151c; --border: #232733; --text: #e6e8ef; --muted: #8890a3;
    --accent: #6ea8fe; --ok: #3fce6e; --run: #6ea8fe; --warn: #f0b13c; --err: #f0596b;
  }
  @media (prefers-color-scheme: light) {
    :root { color-scheme: light; --bg: #f4f5f8; --panel: #ffffff; --border: #e2e4ea; --text: #1c1f27; --muted: #666f83; }
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); margin: 0; padding: 2rem 1.5rem 4rem;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.5rem; }
  h1 { font-size: 1.25rem; margin: 0; font-weight: 600; }
  .clock { color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .banner {
    background: color-mix(in srgb, var(--run) 15%, var(--panel)); border: 1px solid var(--run);
    color: var(--text); padding: 0.75rem 1rem; border-radius: 10px; margin-bottom: 1.25rem; font-size: 0.9rem;
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.1rem; }
  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.85rem; }
  .card-head h2 { font-size: 1rem; margin: 0; text-transform: capitalize; }
  .card-head .boss { font-size: 0.72rem; color: var(--muted); margin-top: 0.15rem; }
  .pill { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; padding: 0.25rem 0.55rem; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); color: var(--muted); }
  .pill i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: var(--muted); }
  .pill.ok i { background: var(--ok); }
  .pill.run i { background: var(--run); animation: pulse 1.4s ease-in-out infinite; }
  .pill.warn i { background: var(--warn); }
  .pill.err i { background: var(--err); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .stat-row { display: flex; gap: 1.25rem; margin-bottom: 0.6rem; }
  .stat { display: flex; flex-direction: column; }
  .stat-value { font-size: 1.15rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 0.68rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .evokers { border-top: 1px solid var(--border); margin-top: 0.6rem; padding-top: 0.6rem; display: flex; flex-direction: column; gap: 0.3rem; }
  .evoker-row { display: flex; justify-content: space-between; font-size: 0.8rem; }
  .evoker-name { color: var(--muted); }
  .evoker-contribution { font-variant-numeric: tabular-nums; }
  .activity-line { margin-top: 0.7rem; padding-top: 0.6rem; border-top: 1px solid var(--border); font-size: 0.78rem; color: var(--muted); }
  .err-text { color: var(--err); }
  h3 { font-size: 0.85rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; margin: 0 0 0.6rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.82rem; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  td { padding: 7px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .ts { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .event { color: var(--accent); white-space: nowrap; }
  .detail { color: var(--muted); word-break: break-all; font-family: ui-monospace, Consolas, monospace; font-size: 0.75rem; }
  tr.fail .event { color: var(--err); }
  .empty { color: var(--muted); padding: 1rem 0; font-size: 0.85rem; }
  footer { margin-top: 1.5rem; color: var(--muted); font-size: 0.75rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>wow-armory-api</h1>
    <span class="clock">${escapeHtml(new Date().toISOString())}</span>
  </header>
  ${banner}
  <div class="cards">${guildCards}</div>
  <h3>Activity</h3>
  ${log.length ? `<table>${logRows}</table>` : '<div class="empty">No activity logged yet.</div>'}
  <footer>Auto-refreshes every 5s &middot; raw JSON at <a href="/api/status" style="color:inherit">/api/status</a></footer>
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
}

module.exports = { jsonHandler, htmlHandler };
