const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const os        = require('os');
const QRCode    = require('qrcode');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100mb' }));

let tacticalForce = {};   // { agentId: agentObject }
let commsLog      = [];   // 200 derniers messages
let videoStreams   = {};   // { agentId: { frame, sender, ts } } — 5 max actifs

// ─── URL DE BASE ──────────────────────────────────────────────────────────────
function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces))
        for (const iface of ifaces[name])
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    return '127.0.0.1';
}
function getBaseUrl() {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
    return `http://${getLocalIp()}:${PORT}`;
}

// ─── API REST ─────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({ baseUrl: getBaseUrl() });
});

app.get('/api/status', (req, res) => {
    const agents = Object.values(tacticalForce);
    res.json({
        total   : agents.length,
        online  : agents.filter(a => a.status === 'En Ligne').length,
        messages: commsLog.length,
        streams : Object.keys(videoStreams).length,
        uptime  : Math.floor(process.uptime())
    });
});

// QR code dynamique par rôle
app.get('/qrcode/:role', async (req, res) => {
    const role = decodeURIComponent(req.params.role).toUpperCase();
    const url  = `${getBaseUrl()}/unite.html?role=${encodeURIComponent(role)}`;
    try {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        await QRCode.toFileStream(res, url, {
            type: 'png', width: 220, margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
        });
    } catch (e) { res.status(500).send('QR Error'); }
});

async function sendIcon(res, size) {
    try {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'max-age=3600');
        await QRCode.toFileStream(res, `${getBaseUrl()}/unite.html`, {
            type: 'png', width: size, margin: 1,
            color: { dark: '#1a6fff', light: '#020406' }
        });
    } catch (e) { res.status(500).send('Icon error'); }
}
app.get('/icon-192.png', (req, res) => sendIcon(res, 192));
app.get('/icon-512.png', (req, res) => sendIcon(res, 512));

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
function broadcast(obj, filter = null) {
    const packet = JSON.stringify(obj);
    wss.clients.forEach(client => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (filter && !filter(client)) return;
        client.send(packet);
    });
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let data; try { data = JSON.parse(raw); } catch { return; }

        switch (data.type) {

            // ── HQ Monitor ───────────────────────────────────────────────────
            case 'REGISTER_HQ':
                ws.role = 'HQ';
                ws.send(JSON.stringify({
                    type        : 'INIT_THEATRE',
                    agents      : Object.values(tacticalForce),
                    messages    : commsLog,
                    videoStreams : Object.values(videoStreams)  // flux actifs en cours
                }));
                console.log('[CATS 3] ✦ HQ Monitor connecté');
                break;

            // ── Unité terrain ─────────────────────────────────────────────────
            case 'REGISTER_DEVICE': {
                const existing  = tacticalForce[data.agentId];
                ws.deviceId     = data.agentId;
                ws.role         = data.role || 'FIELD';
                const agentName = existing?.name || data.callsign;

                tacticalForce[data.agentId] = {
                    id      : data.agentId,
                    name    : agentName,
                    role    : data.role,
                    lat     : existing?.lat || 0,
                    lng     : existing?.lng || 0,
                    accuracy: existing?.accuracy || 0,
                    status  : 'En Ligne',
                    lastSeen: Date.now()
                };

                const history = commsLog.filter(m =>
                    m.targetType === 'ALL' ||
                    (m.targetType === 'GROUP'   && m.targetId === data.role) ||
                    (m.targetType === 'PRIVATE' && m.targetId === data.agentId)
                );
                ws.send(JSON.stringify({ type: 'INIT_THEATRE', agents: [], messages: history, videoStreams: [] }));
                broadcast({ type: 'FORCE_UPDATE', agent: tacticalForce[data.agentId] });
                console.log(`[CATS 3] ✦ ${agentName} (${data.role}) en ligne`);
                break;
            }

            // ── Télémétrie GPS ────────────────────────────────────────────────
            case 'TELEMETRY':
                if (tacticalForce[data.id]) {
                    Object.assign(tacticalForce[data.id], {
                        lat     : data.lat,
                        lng     : data.lng,
                        accuracy: data.accuracy || 0,
                        status  : 'En Ligne',
                        lastSeen: Date.now()
                    });
                    broadcast({ type: 'FORCE_UPDATE', agent: tacticalForce[data.id] });
                }
                break;

            // ── Flux vidéo → HQ uniquement ────────────────────────────────────
            case 'VIDEO_STREAM':
                videoStreams[data.agentId] = {
                    agentId  : data.agentId,
                    frame    : data.frame,
                    sender   : data.sender,
                    ts       : Date.now()
                };
                broadcast(
                    { type: 'LIVE_FEED', agentId: data.agentId, frame: data.frame, sender: data.sender },
                    c => c.role === 'HQ'
                );
                break;

            // ── Message tactique ──────────────────────────────────────────────
            case 'TACTICAL_MSG': {
                const msg = {
                    id        : Date.now(),
                    time      : data.time || new Date().toLocaleTimeString('fr-FR'),
                    role      : data.role,
                    sender    : data.sender,
                    msgType   : data.msgType,
                    content   : data.content,
                    targetType: data.targetType || 'ALL',
                    targetId  : data.targetId  || 'ALL'
                };
                commsLog.push(msg);
                if (commsLog.length > 200) commsLog.shift();
                broadcast({ type: 'NEW_MSG', message: msg });
                break;
            }

            // ── Actions HQ ────────────────────────────────────────────────────
            case 'HQ_ACTION':
                if (ws.role !== 'HQ') {
                    console.warn('[CATS 3] ⚠ HQ_ACTION refusée — non autorisé');
                    break;
                }
                if (data.action === 'KICK') {
                    if (tacticalForce[data.targetId]) {
                        const name = tacticalForce[data.targetId].name;
                        delete tacticalForce[data.targetId];
                        delete videoStreams[data.targetId];
                        broadcast({ type: 'BAN_COMMAND', targetId: data.targetId });
                        broadcast({ type: 'STREAM_ENDED', agentId: data.targetId }, c => c.role === 'HQ');
                        console.log(`[CATS 3] ✦ ${name} éjecté`);
                    }
                } else if (data.action === 'PURGE') {
                    commsLog = [];
                    broadcast({ type: 'CLEARED' });
                } else if (data.action === 'RENAME') {
                    if (tacticalForce[data.targetId]) {
                        tacticalForce[data.targetId].name = data.newName;
                        broadcast({ type: 'FORCE_UPDATE', agent: tacticalForce[data.targetId] });
                    }
                }
                break;
        }
    });

    ws.on('close', () => {
        if (ws.deviceId && tacticalForce[ws.deviceId]) {
            tacticalForce[ws.deviceId].status   = 'Hors-ligne';
            tacticalForce[ws.deviceId].lastSeen = Date.now();
            broadcast({ type: 'FORCE_UPDATE', agent: tacticalForce[ws.deviceId] });
            // Signale la fin du flux vidéo si actif
            if (videoStreams[ws.deviceId]) {
                delete videoStreams[ws.deviceId];
                broadcast({ type: 'STREAM_ENDED', agentId: ws.deviceId }, c => c.role === 'HQ');
            }
        }
    });
});

// ─── BOUCLES PÉRIODIQUES ──────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();

    // Élagage agents fantômes
    Object.keys(tacticalForce).forEach(id => {
        const a = tacticalForce[id];
        if (now - a.lastSeen > 300000) {
            delete tacticalForce[id];
            delete videoStreams[id];
        } else if (now - a.lastSeen > 15000 && a.status !== 'Hors-ligne') {
            a.status = 'Hors-ligne';
        }
    });

    // Nettoyage flux vidéo fantômes (aucune frame depuis 6s)
    Object.keys(videoStreams).forEach(id => {
        if (now - videoStreams[id].ts > 6000) {
            delete videoStreams[id];
            broadcast({ type: 'STREAM_ENDED', agentId: id }, c => c.role === 'HQ');
        }
    });

    broadcast({ type: 'SYNC', agents: Object.values(tacticalForce) });
}, 5000);

// Heartbeat (25s — sous le timeout WebSocket de Render)
const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false; ws.ping();
    });
}, 25000);
wss.on('close', () => clearInterval(heartbeat));

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    const base = getBaseUrl();
    console.log(`\n${'═'.repeat(54)}`);
    console.log(`  CATS 3 — SYSTÈME TACTIQUE  ·  v4.0.0`);
    console.log(`${'═'.repeat(54)}`);
    console.log(`  HQ MONITOR  →  ${base}/hq.html`);
    console.log(`  FIELD UNIT  →  ${base}/unite.html`);
    console.log(`${'═'.repeat(54)}\n`);
});
