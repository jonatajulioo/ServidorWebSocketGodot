const express = require("express");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");


const { initDatabase } = require("./database");
const { send } = require("./utils");
const { register, login, activeUsers } = require("./auth");
const rooms = require("./rooms");

const app = express();
const PORT = process.env.PORT || 9090;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || randomUUID();

app.use(express.json());

if (!process.env.ADMIN_TOKEN) {
    console.warn(`ADMIN_TOKEN nao definido. Token temporario do painel admin: ${ADMIN_TOKEN}`);
}

function getAdminToken(req) {
    return String(req.headers["x-admin-token"] || req.query.token || "");
}

function requireAdmin(req, res, next) {
    if (getAdminToken(req) !== ADMIN_TOKEN) {
        res.status(401).json({ error: "Token admin invalido." });
        return;
    }

    next();
}

function renderAdminPage() {
    return `<!doctype html>
<html lang="pt-BR">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SWW Admin</title>
    <style>
        :root { color-scheme: dark; font-family: Arial, sans-serif; background: #111318; color: #f2f4f8; }
        body { margin: 0; padding: 24px; }
        header { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 20px; }
        h1 { margin: 0; font-size: 24px; }
        input, button { border: 1px solid #343945; border-radius: 6px; background: #1b1f29; color: #f2f4f8; padding: 10px 12px; }
        button { cursor: pointer; background: #2d6cdf; border-color: #2d6cdf; }
        button.danger { background: #bb2d3b; border-color: #bb2d3b; }
        button.secondary { background: #252b36; border-color: #343945; }
        .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
        .card, .details { border: 1px solid #2b303b; border-radius: 8px; background: #181c24; padding: 14px; }
        .row { display: flex; justify-content: space-between; gap: 12px; margin: 6px 0; }
        .muted { color: #aab1c0; }
        .pill { display: inline-block; border-radius: 999px; padding: 3px 8px; background: #263142; font-size: 12px; }
        .players { margin-top: 10px; display: grid; gap: 6px; }
        .player { border-top: 1px solid #2b303b; padding-top: 8px; }
        pre { white-space: pre-wrap; word-break: break-word; max-height: 380px; overflow: auto; }
    </style>
</head>
<body>
    <header>
        <h1>SQUAD WORLD WAR Admin</h1>
        <div class="toolbar">
            <input id="token" type="password" placeholder="Token admin">
            <button id="saveToken">Salvar token</button>
            <button id="refresh">Atualizar</button>
        </div>
    </header>
    <main>
        <section id="status" class="muted">Carregando...</section>
        <section id="rooms" class="grid"></section>
        <section id="details" class="details" style="display:none; margin-top:12px;"></section>
    </main>
    <script>
        const tokenInput = document.getElementById("token");
        const statusEl = document.getElementById("status");
        const roomsEl = document.getElementById("rooms");
        const detailsEl = document.getElementById("details");

        tokenInput.value = localStorage.getItem("sww_admin_token") || "";

        document.getElementById("saveToken").onclick = function () {
            localStorage.setItem("sww_admin_token", tokenInput.value.trim());
            loadRooms();
        };

        document.getElementById("refresh").onclick = loadRooms;

        function token() {
            return tokenInput.value.trim();
        }

        async function api(path, options) {
            const res = await fetch(path, {
                ...(options || {}),
                headers: {
                    "x-admin-token": token(),
                    ...((options && options.headers) || {})
                }
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || "Erro " + res.status);
            }

            return res.json();
        }

        function playerLine(player) {
            const online = player.offline ? "offline" : "online";
            return '<div class="player"><b>' + escapeHtml(player.name || "Sem nome") + '</b>' +
                '<div class="muted">ID ' + escapeHtml(String(player.userId)) + ' - ' + online + '</div>' +
                '<div>País: ' + escapeHtml(player.country || "-") + ' | Cor: ' + escapeHtml(player.color || "-") + '</div></div>';
        }

        function roomCard(room) {
            const owners = Object.keys(room.territorySummary.byOwner || {}).length;
            return '<article class="card">' +
                '<div class="row"><strong>Sala ' + escapeHtml(room.roomCode) + '</strong><span class="pill">' + escapeHtml(room.status || "-") + '</span></div>' +
                '<div class="row"><span class="muted">Jogadores</span><span>' + room.playerCount + ' (' + room.connectedCount + ' conectados)</span></div>' +
                '<div class="row"><span class="muted">Territórios</span><span>' + room.territorySummary.total + ' / donos: ' + owners + '</span></div>' +
                '<div class="row"><span class="muted">Trocas ativas</span><span>' + room.tradeCount + '</span></div>' +
                '<div class="players">' + (room.players || []).map(playerLine).join("") + '</div>' +
                '<div class="toolbar" style="margin-top:12px">' +
                    '<button class="secondary" onclick="showRoom(\\'' + escapeHtml(room.roomCode) + '\\')">Detalhes</button>' +
                    '<button class="danger" onclick="closeRoom(\\'' + escapeHtml(room.roomCode) + '\\')">Encerrar</button>' +
                '</div>' +
            '</article>';
        }

        async function loadRooms() {
            try {
                statusEl.textContent = "Atualizando salas...";
                const data = await api("/admin/api/rooms");
                roomsEl.innerHTML = data.rooms.map(roomCard).join("");
                statusEl.textContent = data.rooms.length + " sala(s) encontrada(s).";
            } catch (err) {
                roomsEl.innerHTML = "";
                statusEl.textContent = "Erro: " + err.message;
            }
        }

        async function showRoom(roomCode) {
            try {
                const room = await api("/admin/api/rooms/" + encodeURIComponent(roomCode));
                detailsEl.style.display = "block";
                detailsEl.innerHTML = '<div class="row"><strong>Detalhes da sala ' + escapeHtml(roomCode) + '</strong>' +
                    '<button class="secondary" onclick="detailsEl.style.display=\\'none\\'">Fechar</button></div>' +
                    '<pre>' + escapeHtml(JSON.stringify(room, null, 2)) + '</pre>';
            } catch (err) {
                statusEl.textContent = "Erro: " + err.message;
            }
        }

        async function closeRoom(roomCode) {
            if (!confirm("Encerrar e apagar a sala " + roomCode + "?")) return;

            try {
                await api("/admin/api/rooms/" + encodeURIComponent(roomCode), { method: "DELETE" });
                detailsEl.style.display = "none";
                await loadRooms();
            } catch (err) {
                statusEl.textContent = "Erro: " + err.message;
            }
        }

        function escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, function (ch) {
                return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[ch];
            });
        }

        loadRooms();
        setInterval(loadRooms, 5000);
    </script>
</body>
</html>`;
}

app.get("/admin", (_req, res) => {
    res.type("html").send(renderAdminPage());
});

app.get("/admin/api/rooms", requireAdmin, (_req, res) => {
    res.json({ rooms: rooms.getAdminRooms() });
});

app.get("/admin/api/rooms/:roomCode", requireAdmin, (req, res) => {
    const room = rooms.getAdminRoom(String(req.params.roomCode || "").toUpperCase());

    if (!room) {
        res.status(404).json({ error: "Sala nao encontrada." });
        return;
    }

    res.json(room);
});

app.delete("/admin/api/rooms/:roomCode", requireAdmin, (req, res) => {
    const ok = rooms.closeRoomByAdmin(String(req.params.roomCode || "").toUpperCase());

    if (!ok) {
        res.status(404).json({ error: "Sala nao encontrada." });
        return;
    }

    res.json({ ok: true });
});

initDatabase()
    .then(() => rooms.loadRoomsFromDb())
    .then(() => rooms.startGameLoop())
    .catch((err) => {
        console.error("Erro ao iniciar banco/salas:", err);
    });

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });

const HEARTBEAT_INTERVAL = 30000;

function heartbeat() {
    this.isAlive = true;
}

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((socket) => {
        if (socket.isAlive === false) {
            console.log(`Socket morto encerrado: ${socket.username || socket.uuid}`);
            return socket.terminate();
        }

        socket.isAlive = false;
        socket.ping();
    });
}, HEARTBEAT_INTERVAL);

wss.on("close", () => {
    clearInterval(heartbeatInterval);
});

wss.on("connection", (socket) => {
    socket.isAlive = true;
    socket.on("pong", heartbeat);

    const uuid = randomUUID();
    socket.uuid = uuid;
    socket.roomId = null;
    socket.userId = null;
    socket.username = null;
    socket.email = null;
    socket.isAuthenticated = false;

    console.log(`Cliente conectado: ${uuid}`);

    send(socket, {
        cmd: "joined_server",
        content: { uuid }
    });

    socket.on("message", async (message) => {
        let data;
        
        try {
            data = JSON.parse(message.toString());
        } catch {
            send(socket, {
                cmd: "error",
                content: { msg: "Mensagem inválida." }
            });
            return;
        }

        const content = data.content || {};

        try {
            switch (data.cmd) {
                case "register":
                    await register(socket, data.content);
                    break;

                case "login":
                    await login(socket, data.content);
                    break;

                case "me":
                    rooms.me(socket);
                    break;

                case "heartbeat_ping":
                    send(socket, {
                        cmd: "heartbeat_pong",
                        content: { time: Date.now() }
                    });
                    break;

                case "create_room":
                    rooms.createRoom(socket);
                    break;

                case "join_room":
                    rooms.joinRoom(socket, data.content);
                    break;

                case "get_room_state":
                    rooms.sendRoomState(socket, socket.roomId);
                    break;

                case "chat":
                    rooms.chat(socket, data.content);
                    break;

                case "request_start":
                    rooms.requestStart(socket);
                    break;

                case "select_country":
                    rooms.selectCountry(socket, data.content);
                    break;

                case "select_color":
                    rooms.selectColor(socket, data.content);
                    break;

                case "save_game":
                    rooms.saveGame(socket, data.content);
                    break;

                case "load_game":
                    await rooms.loadGame(socket, data.content);
                    break;

                case "do_action":
                    rooms.doAction(socket, data.content);
                    break;
                
                case "upgrade_military":
                    rooms.upgradeMilitary(socket, data.content);
                    break;
                
                case "upgrade_comercial":
                    rooms.upgradeComercial(socket, data.content);
                    break;

                case "upgrade_saude":
                    rooms.upgradeSaude(socket, data.content);
                    break;

                case "request_trade":
                    rooms.requestTrade(socket, content);
                    break;

                case "accept_trade":
                    rooms.acceptTrade(socket, content);
                    break;

                case "reject_trade":
                    rooms.rejectTrade(socket, content);
                    break;

                case "update_trade_offer":
                    rooms.updateTradeOffer(socket, content);
                    break;

                case "confirm_trade":
                    rooms.confirmTrade(socket, content);
                    break;

                case "request_online_players":
                    rooms.requestOnlinePlayers(socket);
                    break;

                default:
                    send(socket, {
                        cmd: "error",
                        content: { msg: `Comando desconhecido: ${data.cmd}` }
                    });
                    break;
            }
        } catch (err) {
            console.error("ERRO GERAL no socket.on(message):", err);
            send(socket, {
                cmd: "error",
                content: { msg: "Erro interno no servidor." }
            });
        }
    });

    socket.on("close", () => {
        if (socket.userId && activeUsers.get(socket.userId) === socket) {
            activeUsers.delete(socket.userId);
        }

        rooms.handleDisconnect(socket);
    });

    socket.on("error", () => {
        if (socket.userId && activeUsers.get(socket.userId) === socket) {
            activeUsers.delete(socket.userId);
            console.log(`Conta liberada por erro: ${socket.username}`);
        }
    });
});
