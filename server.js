// ========================
// Servidor Multiplayer para Godot
// Com:
// - Registro/Login com SQLite
// - Salas
// - Seleção de países
// - Save JSON
// - Sala fecha se o host sair
// ========================

const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 9090;

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

const SAVE_DIR = path.join(__dirname, "saves");
if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
}

// ========================
// SQLite
// ========================
const dbPath = path.join(__dirname, "game.db");
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Erro ao abrir SQLite:", err.message);
    } else {
        console.log("SQLite conectado em:", dbPath);
    }
});

function initDatabase() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`
            CREATE TABLE IF NOT EXISTS saves (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_code TEXT NOT NULL UNIQUE,
                host_user_id INTEGER,
                save_data TEXT NOT NULL,
                status TEXT DEFAULT 'waiting',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        db.run(`PRAGMA journal_mode = WAL;`);
    });
}

initDatabase();

// ========================
// Utilidades
// ========================
function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function requireAuth(socket) {
    return socket.isAuthenticated && socket.userId !== null;
}

function broadcastToRoom(room, payload) {
    for (const clientUuid in room.players) {
        const client = room.players[clientUuid];
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    }
}

function getRoomByCode(roomCode) {
    return rooms.get(roomCode);
}

function getSerializablePlayers(roomCode) {
    return playerlist.getByRoom(roomCode).map(player => ({
        uuid: player.uuid,
        userId: player.userId,
        room: player.room,
        name: player.name,
        x: player.x,
        y: player.y,
        country: player.country || null
    }));
}

// ========================
// Save em JSON
// ========================
function saveRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const saveData = {
        roomCode: roomCode,
        hostId: room.hostId,
        hostUserId: room.hostUserId,
        status: room.status,
        selectedCountries: room.selectedCountries,
        gameState: room.gameState,
        createdAt: room.createdAt,
        savedAt: Date.now(),
        players: getSerializablePlayers(roomCode)
    };

    const filePath = path.join(SAVE_DIR, `${roomCode}.json`);
    fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2), "utf-8");
    console.log(`Sala ${roomCode} salva em JSON.`);
}

// ========================
// Save no SQLite
// ========================
function saveRoomStateToDb(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const saveData = {
        roomCode: roomCode,
        hostId: room.hostId,
        hostUserId: room.hostUserId,
        status: room.status,
        selectedCountries: room.selectedCountries,
        gameState: room.gameState,
        createdAt: room.createdAt,
        savedAt: Date.now(),
        players: getSerializablePlayers(roomCode)
    };

    const json = JSON.stringify(saveData);

    db.run(`
        INSERT INTO saves (room_code, host_user_id, save_data, status, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(room_code) DO UPDATE SET
            host_user_id = excluded.host_user_id,
            save_data = excluded.save_data,
            status = excluded.status,
            updated_at = CURRENT_TIMESTAMP
    `, [roomCode, room.hostUserId || null, json, room.status], (err) => {
        if (err) {
            console.error(`Erro ao salvar sala ${roomCode} no SQLite:`, err.message);
        } else {
            console.log(`Sala ${roomCode} salva no SQLite.`);
        }
    });
}

function loadRoomStateFromDb(roomCode, callback) {
    db.get(
        "SELECT save_data FROM saves WHERE room_code = ?",
        [roomCode],
        (err, row) => {
            if (err) {
                callback(err, null);
                return;
            }

            if (!row) {
                callback(null, null);
                return;
            }

            try {
                callback(null, JSON.parse(row.save_data));
            } catch (e) {
                callback(e, null);
            }
        }
    );
}

// ========================
// Lista de jogadores online
// ========================
const playerlist = {
    players: [],

    getAll: function () {
        return this.players;
    },

    get: function (uuid) {
        return this.players.find(player => player.uuid === uuid);
    },

    getByUserId: function (userId) {
        return this.players.find(player => player.userId === userId);
    },

    add: function (uuid, userId, roomCode, playerName) {
        const playersInRoom = this.getByRoom(roomCode);
        const isFirstPlayer = playersInRoom.length === 0;

        const player = {
            uuid: uuid,
            userId: userId,
            room: roomCode,
            name: playerName,
            x: isFirstPlayer ? 550 : 700,
            y: 300,
            country: null
        };

        this.players.push(player);
        return player;
    },

    update: function (uuid, newX, newY) {
        const player = this.get(uuid);
        if (player) {
            player.x = newX;
            player.y = newY;
        }
    },

    remove: function (uuid) {
        this.players = this.players.filter(player => player.uuid !== uuid);
    },

    removeByRoom: function (roomCode) {
        this.players = this.players.filter(player => player.room !== roomCode);
    },

    getByRoom: function (roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

// ========================
// WebSocket
// ========================
wss.on("connection", (socket) => {
    const uuid = randomUUID();

    socket.uuid = uuid;
    socket.roomId = null;
    socket.userId = null;
    socket.username = null;
    socket.email = null;
    socket.isAuthenticated = false;

    console.log(`Cliente conectado: ${uuid}`);

    socket.send(JSON.stringify({
        cmd: "joined_server",
        content: { uuid: uuid }
    }));

    socket.on("message", async (message) => {
        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao parsear mensagem:", err);
            socket.send(JSON.stringify({
                cmd: "error",
                content: { msg: "Mensagem inválida." }
            }));
            return;
        }

        switch (data.cmd) {
            case "register": {
                const username = (data.content?.username || "").trim();
                const email = (data.content?.email || "").trim().toLowerCase();
                const password = data.content?.password || "";

                if (!username || !email || !password) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Preencha usuário, email e senha." }
                    }));
                    break;
                }

                if (password.length < 6) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "A senha deve ter pelo menos 6 caracteres." }
                    }));
                    break;
                }

                db.get(
                    "SELECT id FROM users WHERE username = ? OR email = ?",
                    [username, email],
                    async (err, row) => {
                        if (err) {
                            console.error(err);
                            socket.send(JSON.stringify({
                                cmd: "error",
                                content: { msg: "Erro no banco de dados." }
                            }));
                            return;
                        }

                        if (row) {
                            socket.send(JSON.stringify({
                                cmd: "error",
                                content: { msg: "Usuário ou email já cadastrado." }
                            }));
                            return;
                        }

                        try {
                            const hash = await bcrypt.hash(password, 10);

                            db.run(
                                "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
                                [username, email, hash],
                                function (err) {
                                    if (err) {
                                        console.error(err);
                                        socket.send(JSON.stringify({
                                            cmd: "error",
                                            content: { msg: "Erro ao criar conta." }
                                        }));
                                        return;
                                    }

                                    socket.send(JSON.stringify({
                                        cmd: "register_success",
                                        content: {
                                            userId: this.lastID,
                                            username: username,
                                            email: email
                                        }
                                    }));
                                }
                            );
                        } catch (e) {
                            console.error(e);
                            socket.send(JSON.stringify({
                                cmd: "error",
                                content: { msg: "Erro ao processar senha." }
                            }));
                        }
                    }
                );

                break;
            }

            case "login": {
                const email = (data.content?.email || "").trim().toLowerCase();
                const password = data.content?.password || "";

                if (!email || !password) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Informe email e senha." }
                    }));
                    break;
                }

                db.get(
                    "SELECT * FROM users WHERE email = ?",
                    [email],
                    async (err, user) => {
                        if (err) {
                            console.error(err);
                            socket.send(JSON.stringify({
                                cmd: "error",
                                content: { msg: "Erro no banco de dados." }
                            }));
                            return;
                        }

                        if (!user) {
                            socket.send(JSON.stringify({
                                cmd: "error",
                                content: { msg: "Conta não encontrada." }
                            }));
                            return;
                        }

                        try {
                            const ok = await bcrypt.compare(password, user.password_hash);

                            if (!ok) {
                                socket.send(JSON.stringify({
                                    cmd: "error",
                                    content: { msg: "Senha incorreta." }
                                }));
                                return;
                            }

                            socket.userId = user.id;
                            socket.username = user.username;
                            socket.email = user.email;
                            socket.isAuthenticated = true;

                            socket.send(JSON.stringify({
                                cmd: "login_success",
                                content: {
                                    userId: user.id,
                                    username: user.username,
                                    email: user.email
                                }
                            }));
                        } catch (e) {
                            console.error(e);
                            socket.send(JSON.stringify({
                                cmd: "error",
                                content: { msg: "Erro ao validar login." }
                            }));
                        }
                    }
                );

                break;
            }

            case "me": {
                if (!requireAuth(socket)) {
                    socket.send(JSON.stringify({
                        cmd: "not_logged_in",
                        content: {}
                    }));
                    break;
                }

                socket.send(JSON.stringify({
                    cmd: "me",
                    content: {
                        userId: socket.userId,
                        username: socket.username,
                        email: socket.email
                    }
                }));
                break;
            }

            case "create_room": {
                if (!requireAuth(socket)) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Você precisa estar logado para criar uma sala." }
                    }));
                    break;
                }

                const playerName = socket.username;
                const newRoomId = generateRoomCode();

                socket.roomId = newRoomId;

                rooms.set(newRoomId, {
                    players: {},
                    hostId: uuid,
                    hostUserId: socket.userId,
                    status: "waiting",
                    selectedCountries: {},
                    gameState: null,
                    createdAt: Date.now()
                });

                rooms.get(newRoomId).players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, socket.userId, newRoomId, playerName);

                console.log(`Sala ${newRoomId} criada por ${playerName} (userId ${socket.userId})`);

                socket.send(JSON.stringify({
                    cmd: "room_created",
                    content: { code: newRoomId }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: newPlayer }
                }));

                socket.send(JSON.stringify({
                    cmd: "room_state",
                    content: {
                        roomCode: newRoomId,
                        hostId: uuid,
                        hostUserId: socket.userId,
                        status: "waiting",
                        players: getSerializablePlayers(newRoomId),
                        selectedCountries: {},
                        gameState: null
                    }
                }));

                saveRoomState(newRoomId);
                saveRoomStateToDb(newRoomId);
                break;
            }

            case "join_room": {
                if (!requireAuth(socket)) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Você precisa estar logado para entrar em uma sala." }
                    }));
                    break;
                }

                const playerName = socket.username;
                const roomCode = (data.content?.code || "").toUpperCase();
                const roomToJoin = getRoomByCode(roomCode);

                if (!roomToJoin) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    break;
                }

                const currentPlayers = playerlist.getByRoom(roomCode).length;
                if (currentPlayers >= 8) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "A sala já está cheia. Máximo de 8 jogadores." }
                    }));
                    break;
                }

                socket.roomId = roomCode;
                roomToJoin.players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, socket.userId, roomCode, playerName);

                console.log(`Jogador ${playerName} entrou na sala ${roomCode}`);

                socket.send(JSON.stringify({
                    cmd: "room_joined",
                    content: { code: roomCode }
                }));

                socket.send(JSON.stringify({
                    cmd: "spawn_local_player",
                    content: { player: newPlayer }
                }));

                const roomPlayers = playerlist.getByRoom(roomCode).filter(p => p.uuid !== uuid);

                socket.send(JSON.stringify({
                    cmd: "spawn_network_players",
                    content: { players: roomPlayers }
                }));

                for (const clientUuid in roomToJoin.players) {
                    const client = roomToJoin.players[clientUuid];
                    if (client !== socket && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            cmd: "spawn_new_player",
                            content: { player: newPlayer }
                        }));
                    }
                }

                socket.send(JSON.stringify({
                    cmd: "room_state",
                    content: {
                        roomCode: roomCode,
                        hostId: roomToJoin.hostId,
                        hostUserId: roomToJoin.hostUserId,
                        status: roomToJoin.status,
                        players: getSerializablePlayers(roomCode),
                        selectedCountries: roomToJoin.selectedCountries,
                        gameState: roomToJoin.gameState
                    }
                }));

                saveRoomState(roomCode);
                saveRoomStateToDb(roomCode);
                break;
            }

            case "get_room_state": {
                const room = rooms.get(socket.roomId);
                if (!room) break;

                socket.send(JSON.stringify({
                    cmd: "room_state",
                    content: {
                        roomCode: socket.roomId,
                        hostId: room.hostId,
                        hostUserId: room.hostUserId,
                        status: room.status,
                        players: getSerializablePlayers(socket.roomId),
                        selectedCountries: room.selectedCountries,
                        gameState: room.gameState
                    }
                }));
                break;
            }

            case "position": {
                playerlist.update(uuid, data.content.x, data.content.y);

                const room = rooms.get(socket.roomId);
                if (room) {
                    for (const clientUuid in room.players) {
                        const client = room.players[clientUuid];
                        if (client !== socket && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                cmd: "update_position",
                                content: {
                                    uuid: uuid,
                                    x: data.content.x,
                                    y: data.content.y
                                }
                            }));
                        }
                    }
                }
                break;
            }

            case "chat": {
                const room = rooms.get(socket.roomId);
                if (room) {
                    for (const clientUuid in room.players) {
                        const client = room.players[clientUuid];
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                cmd: "new_chat_message",
                                content: {
                                    uuid: uuid,
                                    userId: socket.userId,
                                    username: socket.username,
                                    msg: data.content.msg
                                }
                            }));
                        }
                    }
                }
                break;
            }

            case "request_start": {
                const room = rooms.get(socket.roomId);

                if (!room) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    break;
                }

                if (room.hostId !== uuid) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Apenas o host pode iniciar." }
                    }));
                    break;
                }

                const playersInRoom = playerlist.getByRoom(socket.roomId);
                const playerCount = playersInRoom.length;

                if (playerCount < 2) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Para iniciar precisa de 2 ou mais jogadores." }
                    }));
                    break;
                }

                if (playerCount > 8) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Máximo de 8 jogadores por sala." }
                    }));
                    break;
                }

                room.status = "country_selection";
                room.selectedCountries = {};
                room.gameState = null;

                for (const player of playersInRoom) {
                    player.country = null;
                }

                broadcastToRoom(room, {
                    cmd: "country_selection_started",
                    content: {
                        roomCode: socket.roomId,
                        players: getSerializablePlayers(socket.roomId),
                        selectedCountries: room.selectedCountries
                    }
                });

                saveRoomState(socket.roomId);
                saveRoomStateToDb(socket.roomId);
                break;
            }

            case "select_country": {
                const room = rooms.get(socket.roomId);

                if (!room) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    break;
                }

                if (room.status !== "country_selection") {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "A seleção de países não está ativa." }
                    }));
                    break;
                }

                const countryName = (data.content?.country || "").trim();

                if (!countryName) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "País inválido." }
                    }));
                    break;
                }

                const player = playerlist.get(uuid);
                if (!player) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Jogador não encontrado." }
                    }));
                    break;
                }

                if (player.country) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Você já escolheu um país." }
                    }));
                    break;
                }

                if (room.selectedCountries[countryName]) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Esse país já foi escolhido." }
                    }));
                    break;
                }

                player.country = countryName;
                room.selectedCountries[countryName] = uuid;

                broadcastToRoom(room, {
                    cmd: "country_selected",
                    content: {
                        playerUuid: uuid,
                        playerUserId: player.userId,
                        playerName: player.name,
                        country: countryName,
                        selectedCountries: room.selectedCountries,
                        players: getSerializablePlayers(socket.roomId)
                    }
                });

                saveRoomState(socket.roomId);
                saveRoomStateToDb(socket.roomId);

                const playersInRoom = playerlist.getByRoom(socket.roomId);
                const everyoneSelected = playersInRoom.length >= 2 && playersInRoom.every(p => p.country);

                if (everyoneSelected) {
                    room.status = "playing";
                    room.gameState = {
                        turn: 1,
                        currentPlayerIndex: 0,
                        players: playersInRoom.map(p => ({
                            uuid: p.uuid,
                            userId: p.userId,
                            name: p.name,
                            country: p.country
                        }))
                    };

                    broadcastToRoom(room, {
                        cmd: "start_game",
                        content: {
                            players: getSerializablePlayers(socket.roomId),
                            selectedCountries: room.selectedCountries,
                            gameState: room.gameState
                        }
                    });

                    saveRoomState(socket.roomId);
                    saveRoomStateToDb(socket.roomId);
                }

                break;
            }

            case "save_game": {
                const room = rooms.get(socket.roomId);

                if (!room) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    break;
                }

                if (data.content?.gameState) {
                    room.gameState = data.content.gameState;
                }

                saveRoomState(socket.roomId);
                saveRoomStateToDb(socket.roomId);

                socket.send(JSON.stringify({
                    cmd: "game_saved",
                    content: { roomCode: socket.roomId }
                }));
                break;
            }

            case "load_game": {
                const roomCode = (data.content?.code || "").toUpperCase();

                loadRoomStateFromDb(roomCode, (err, savedRoom) => {
                    if (err) {
                        console.error(err);
                        socket.send(JSON.stringify({
                            cmd: "error",
                            content: { msg: "Erro ao carregar save." }
                        }));
                        return;
                    }

                    if (!savedRoom) {
                        socket.send(JSON.stringify({
                            cmd: "error",
                            content: { msg: "Save não encontrado." }
                        }));
                        return;
                    }

                    socket.send(JSON.stringify({
                        cmd: "loaded_game_data",
                        content: savedRoom
                    }));
                });

                break;
            }

            default: {
                socket.send(JSON.stringify({
                    cmd: "error",
                    content: { msg: `Comando desconhecido: ${data.cmd}` }
                }));
                break;
            }
        }
    });

    socket.on("close", () => {
        console.log(`Cliente desconectado: ${uuid}`);

        const roomCode = socket.roomId;
        const room = rooms.get(roomCode);

        if (room) {
            const isHost = room.hostId === uuid;

            if (isHost) {
                saveRoomState(roomCode);
                saveRoomStateToDb(roomCode);

                for (const clientUuid in room.players) {
                    const client = room.players[clientUuid];
                    if (client && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            cmd: "room_closed",
                            content: {
                                msg: "A sala foi encerrada porque o host saiu."
                            }
                        }));
                    }
                }

                playerlist.removeByRoom(roomCode);
                rooms.delete(roomCode);

                console.log(`Sala ${roomCode} encerrada porque o host saiu.`);
                return;
            }

            delete room.players[uuid];
            playerlist.remove(uuid);

            for (const clientUuid in room.players) {
                const client = room.players[clientUuid];
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        cmd: "player_disconnected",
                        content: { uuid: uuid }
                    }));
                }
            }

            saveRoomState(roomCode);
            saveRoomStateToDb(roomCode);
        } else {
            playerlist.remove(uuid);
        }
    });
});
