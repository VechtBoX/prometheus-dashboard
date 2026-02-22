// ============================================================
// PROMETHEUS DASHBOARD SERVER — poort 4001
// Redis: 192.168.1.195:6379 (wachtwoord: supersterk)
// Alle agents: MacBook Pro + iMac
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

const PORT = 4001;
const REDIS_HOST = '192.168.1.195';
const REDIS_PORT = 6379;
const REDIS_PASSWORD = 'supersterk';

// SSE clients voor live updates
const sseClients = new Set();

// Redis clients
let redisClient = null;
let redisSub = null;
let redisConnected = false;

// In-memory activiteiten log (max 200)
const activiteitenLog = [];

// Agent definities — alle bekende agents
const AGENTS = {
  // MacBook Pro agents
  'GUARDIAN': { machine: 'MacBook Pro', kleur: '#ef4444', emoji: '🛡️', beschrijving: 'Health Monitor' },
  'prometheus-server': { machine: 'MacBook Pro', kleur: '#f97316', emoji: '🔥', beschrijving: 'Dashboard Server' },
  'prometheus-agent': { machine: 'MacBook Pro', kleur: '#f59e0b', emoji: '⚡', beschrijving: 'Prometheus Agent' },
  'mikkie-brainstorm': { machine: 'MacBook Pro', kleur: '#8b5cf6', emoji: '🧠', beschrijving: 'Brainstorm Agent' },
  'mikkie-race': { machine: 'MacBook Pro', kleur: '#06b6d4', emoji: '🏎️', beschrijving: 'Race Agent' },
  'live-data-agent': { machine: 'MacBook Pro', kleur: '#10b981', emoji: '📊', beschrijving: 'Live Data Agent' },
  'race-api': { machine: 'MacBook Pro', kleur: '#3b82f6', emoji: '🚀', beschrijving: 'Race API' },
  'xrp-monitor': { machine: 'MacBook Pro', kleur: '#6366f1', emoji: '💎', beschrijving: 'XRP Monitor' },
  'agent-check-redis': { machine: 'MacBook Pro', kleur: '#ec4899', emoji: '🔍', beschrijving: 'Redis Checker' },
  'agent-luister-stripe': { machine: 'MacBook Pro', kleur: '#14b8a6', emoji: '💳', beschrijving: 'Stripe Listener' },
  'agent-telegram': { machine: 'MacBook Pro', kleur: '#a855f7', emoji: '📱', beschrijving: 'Telegram Agent' },
  'agent-ochtend': { machine: 'MacBook Pro', kleur: '#f43f5e', emoji: '🌅', beschrijving: 'Ochtend Agent' },
  // iMac agents
  'CREATOR': { machine: 'iMac', kleur: '#22c55e', emoji: '✨', beschrijving: 'Mission Generator (Claude)' },
  'VIRAL': { machine: 'iMac', kleur: '#f97316', emoji: '🔥', beschrijving: 'Social Media (Grok)' },
  'SPARK': { machine: 'iMac', kleur: '#eab308', emoji: '💡', beschrijving: 'Brainstorm (Grok)' },
  'TOKENMASTER': { machine: 'iMac', kleur: '#06b6d4', emoji: '🪙', beschrijving: 'Token Manager' },
  'FIREBASE': { machine: 'iMac', kleur: '#f59e0b', emoji: '🔥', beschrijving: 'Firebase Agent' },
  'imac-brainstorm': { machine: 'iMac', kleur: '#8b5cf6', emoji: '🧠', beschrijving: 'iMac Brainstorm' },
  'imac-worker': { machine: 'iMac', kleur: '#10b981', emoji: '⚙️', beschrijving: 'iMac Worker' },
  'imac-node': { machine: 'iMac', kleur: '#3b82f6', emoji: '🖥️', beschrijving: 'iMac Node' },
};

// Hartslag keys → agent naam mapping
const HARTSLAG_KEYS = {
  'node:creator:hartslag': 'CREATOR',
  'node:gelato:hartslag': 'GELATO',
  'node:guardian:hartslag': 'GUARDIAN',
  'node:imac:hartslag': 'iMac',
  'node:imac:worker:hartslag': 'imac-worker',
  'node:spark:hartslag': 'SPARK',
  'node:tokenmaster:hartslag': 'TOKENMASTER',
  'node:viral:hartslag': 'VIRAL',
};

// Voeg activiteit toe aan log
function voegActiviteitToe(agent, bericht, type = 'info') {
  const activiteit = {
    id: Date.now() + Math.random(),
    tijd: new Date().toISOString(),
    agent,
    bericht,
    type, // info, success, warning, error, brainstorm, social, crypto
    machine: AGENTS[agent]?.machine || 'Onbekend',
    kleur: AGENTS[agent]?.kleur || '#6b7280',
    emoji: AGENTS[agent]?.emoji || '🤖',
  };
  activiteitenLog.unshift(activiteit);
  if (activiteitenLog.length > 200) activiteitenLog.pop();

  // Stuur naar alle SSE clients
  broadcastSSE({ type: 'activiteit', data: activiteit });
  return activiteit;
}

// Broadcast naar SSE clients
function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (e) { sseClients.delete(client); }
  }
}

// Redis verbinding
async function verbindRedis() {
  try {
    redisClient = createClient({
      socket: { host: REDIS_HOST, port: REDIS_PORT, reconnectStrategy: (n) => Math.min(n * 500, 5000) },
      password: REDIS_PASSWORD,
    });
    redisSub = createClient({
      socket: { host: REDIS_HOST, port: REDIS_PORT, reconnectStrategy: (n) => Math.min(n * 500, 5000) },
      password: REDIS_PASSWORD,
    });

    redisClient.on('error', (e) => { console.error('[Redis] Fout:', e.message); redisConnected = false; });
    redisClient.on('connect', () => { console.log('[Redis] Verbonden'); redisConnected = true; });
    redisSub.on('error', (e) => console.error('[Redis Sub] Fout:', e.message));

    await redisClient.connect();
    await redisSub.connect();

    // Luister op alle relevante kanalen
    const kanalen = [
      'mikkieworld:events',
      'prometheus:events',
      'agent:events',
      'mikkieworld:brainstorm:ideeen',
      'mikkieworld:viral:content',
      'mikkieworld:missies:nieuw',
    ];

    for (const kanaal of kanalen) {
      await redisSub.subscribe(kanaal, (bericht, kanaalNaam) => {
        try {
          const data = JSON.parse(bericht);
          const agent = data.agent || data.naam || 'Systeem';
          const tekst = data.bericht || data.tekst || data.content || JSON.stringify(data).substring(0, 100);
          const type = data.type || 'info';
          voegActiviteitToe(agent, tekst, type);
        } catch (e) {
          voegActiviteitToe('Systeem', `[${kanaalNaam}] ${bericht.substring(0, 100)}`, 'info');
        }
      });
    }

    // Patterned subscribe voor alle agent kanalen
    await redisSub.pSubscribe('node:*:hartslag', (bericht, kanaal) => {
      const agentNaam = HARTSLAG_KEYS[kanaal] || kanaal.replace('node:', '').replace(':hartslag', '');
      try {
        const data = JSON.parse(bericht);
        const status = data.status || 'actief';
        voegActiviteitToe(agentNaam, `Hartslag: ${status}`, 'success');
      } catch (e) {
        voegActiviteitToe(agentNaam, 'Hartslag ontvangen', 'success');
      }
    });

    console.log('[Redis] Luistert op alle kanalen');
    voegActiviteitToe('Systeem', 'Dashboard verbonden met Redis', 'success');

    // Start periodieke data polling
    startPolling();

  } catch (e) {
    console.error('[Redis] Verbinding mislukt:', e.message);
    voegActiviteitToe('Systeem', `Redis verbinding mislukt: ${e.message}`, 'error');
    setTimeout(verbindRedis, 5000);
  }
}

// Haal data op uit Redis
async function haalRedisData(key) {
  if (!redisClient || !redisConnected) return null;
  try {
    const val = await redisClient.get(key);
    if (!val) return null;
    try { return JSON.parse(val); } catch { return val; }
  } catch (e) {
    return null;
  }
}

// Polling voor periodieke updates
let pollingInterval = null;
function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(async () => {
    try {
      const [xrpPrijs, cryptoData, pm2Status, brainstorm, viral, missie] = await Promise.all([
        haalRedisData('xrp:price'),
        haalRedisData('data:crypto'),
        haalRedisData('data:pm2:status'),
        haalRedisData('mikkieworld:brainstorm:ideeen'),
        haalRedisData('mikkieworld:viral:content'),
        haalRedisData('mikkieworld:missies:laatste'),
      ]);

      const update = {
        type: 'data_update',
        tijdstip: new Date().toISOString(),
        xrp: xrpPrijs,
        crypto: cryptoData,
        pm2: pm2Status,
        brainstorm: brainstorm,
        viral: viral,
        missie: missie,
        redisVerbonden: redisConnected,
      };

      broadcastSSE(update);

      // Voeg interessante updates toe aan activiteitenlog
      if (xrpPrijs) {
        const prijs = typeof xrpPrijs === 'object' ? xrpPrijs.prijs || xrpPrijs.price || xrpPrijs : xrpPrijs;
        voegActiviteitToe('xrp-monitor', `XRP prijs bijgewerkt: €${prijs}`, 'crypto');
      }

    } catch (e) {
      console.error('[Polling] Fout:', e.message);
    }
  }, 10000); // elke 10 seconden
}

// API handlers
async function handleAPI(req, res, url) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url === '/api/status') {
    const agents = {};
    if (redisClient && redisConnected) {
      try {
        const hartslagKeys = Object.keys(HARTSLAG_KEYS);
        for (const key of hartslagKeys) {
          const val = await haalRedisData(key);
          const agentNaam = HARTSLAG_KEYS[key];
          if (val) {
            const data = typeof val === 'object' ? val : { status: val };
            const tijdstip = data.tijdstip || data.timestamp || null;
            const secGeleden = tijdstip ? Math.floor((Date.now() - new Date(tijdstip).getTime()) / 1000) : null;
            agents[agentNaam] = {
              online: secGeleden !== null ? secGeleden < 120 : true,
              secGeleden,
              data,
            };
          }
        }
      } catch (e) { console.error('[API] Status fout:', e.message); }
    }

    res.end(JSON.stringify({
      ok: true,
      redis: redisConnected,
      agents,
      aantalActiviteiten: activiteitenLog.length,
      tijdstip: new Date().toISOString(),
    }));
    return;
  }

  if (url === '/api/activiteiten') {
    res.end(JSON.stringify({ ok: true, activiteiten: activiteitenLog.slice(0, 100) }));
    return;
  }

  if (url === '/api/redis') {
    if (!redisClient || !redisConnected) {
      res.end(JSON.stringify({ ok: false, fout: 'Redis niet verbonden' }));
      return;
    }
    try {
      const [xrp, crypto, brainstorm, viral, missie, spark, gelato] = await Promise.all([
        haalRedisData('xrp:price'),
        haalRedisData('data:crypto'),
        haalRedisData('mikkieworld:brainstorm:ideeen'),
        haalRedisData('mikkieworld:viral:content'),
        haalRedisData('mikkieworld:missies:laatste'),
        haalRedisData('mikkieworld:spark:laatste'),
        haalRedisData('gelato:omzet:totaal'),
      ]);
      res.end(JSON.stringify({ ok: true, xrp, crypto, brainstorm, viral, missie, spark, gelato }));
    } catch (e) {
      res.end(JSON.stringify({ ok: false, fout: e.message }));
    }
    return;
  }

  if (url === '/api/agents') {
    const agentLijst = Object.entries(AGENTS).map(([naam, info]) => ({ naam, ...info }));
    res.end(JSON.stringify({ ok: true, agents: agentLijst }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, fout: 'Niet gevonden' }));
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

  // SSE endpoint voor real-time updates
  if (url === '/events') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.statusCode = 200;

    // Stuur initiële data
    res.write(`data: ${JSON.stringify({ type: 'verbonden', tijdstip: new Date().toISOString() })}\n\n`);

    // Stuur recente activiteiten
    res.write(`data: ${JSON.stringify({ type: 'geschiedenis', activiteiten: activiteitenLog.slice(0, 50) })}\n\n`);

    sseClients.add(res);

    // Heartbeat elke 30 seconden
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(heartbeat); sseClients.delete(res); }
    }, 30000);

    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
    return;
  }

  // API routes
  if (url.startsWith('/api/')) {
    await handleAPI(req, res, url);
    return;
  }

  // Dashboard HTML
  if (url === '/' || url === '/dashboard' || url === '/dashboard.html') {
    const htmlPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      res.end('<h1>Dashboard HTML niet gevonden</h1><p>Zet dashboard.html in dezelfde map als server.js</p>');
    }
    return;
  }

  // Statische bestanden
  const staticPath = path.join(__dirname, url);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    const ext = path.extname(url);
    const mimeTypes = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.statusCode = 200;
    fs.createReadStream(staticPath).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.end('Niet gevonden');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Prometheus Dashboard draait op http://0.0.0.0:${PORT}`);
  console.log(`📊 Bereikbaar op http://192.168.1.195:${PORT}`);
  console.log(`🔗 Redis: ${REDIS_HOST}:${REDIS_PORT}\n`);
  voegActiviteitToe('Systeem', `Dashboard gestart op poort ${PORT}`, 'success');
  verbindRedis();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[Server] Poort ${PORT} al in gebruik!`);
    process.exit(1);
  }
  console.error('[Server] Fout:', e.message);
});

process.on('SIGTERM', () => { server.close(); if (redisClient) redisClient.quit(); });
process.on('SIGINT', () => { server.close(); if (redisClient) redisClient.quit(); process.exit(0); });
