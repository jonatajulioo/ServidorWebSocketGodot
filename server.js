const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();
const bcrypt = require("bcrypt");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 9090;

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
const activeUsers = new Map();

const SAVE_DIR = path.join(__dirname, "saves");
if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
}

const db = new Pool({
    user: process.env.DB_USER || "jota",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "squad_world_war",
    password: process.env.DB_PASS || "123456",
    port: process.env.DB_PORT || 5432,
    max: 20
});
async function initDatabase() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(30) UNIQUE NOT NULL,
            email VARCHAR(120) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS saves (
            id SERIAL PRIMARY KEY,
            room_code VARCHAR(5) UNIQUE NOT NULL,
            host_user_id INTEGER,
            save_data TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'waiting',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log("PostgreSQL pronto");
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

function send(socket, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function broadcastToRoom(room, payload) {
    for (const clientUuid in room.players) {
        const client = room.players[clientUuid];
        send(client, payload);
    }
}

function getRoomByCode(roomCode) {
    return rooms.get(roomCode);
}

function getCountriesArray(selectedCountries) {
    return Object.keys(selectedCountries || {});
}

function getColorsArray(selectedColors) {
    return Object.keys(selectedColors || {});
}

function getSerializablePlayers(roomCode) {
    return playerlist.getByRoom(roomCode).map((player) => ({
        uuid: player.uuid,
        userId: player.userId,
        room: player.room,
        name: player.name,
        country: player.country || null,
        color: player.color || null
    }));
}

function buildRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return null;

    return {
        roomCode: roomCode,
        hostId: room.hostId,
        hostUserId: room.hostUserId,
        status: room.status,
        players: getSerializablePlayers(roomCode),
        countries_taken: getCountriesArray(room.selectedCountries),
        colors_taken: getColorsArray(room.selectedColors),
        gameState: room.gameState
    };
}

function sendRoomState(socket, roomCode) {
    const state = buildRoomState(roomCode);
    if (!state) return;

    send(socket, {
        cmd: "room_state",
        content: state
    });
}

function broadcastRoomState(roomCode) {
    const room = rooms.get(roomCode);
    const state = buildRoomState(roomCode);

    if (!room || !state) return;

    broadcastToRoom(room, {
        cmd: "room_state",
        content: state
    });
}

function everyoneHasCountry(roomCode) {
    const players = playerlist.getByRoom(roomCode);
    return players.length >= 2 && players.every((p) => p.country);
}

function everyoneHasColor(roomCode) {
    const players = playerlist.getByRoom(roomCode);
    return players.length >= 2 && players.every((p) => p.color);
}

function everyoneReadyForMap(roomCode) {
    const players = playerlist.getByRoom(roomCode);
    return players.length >= 2 && players.every((p) => p.country && p.color);
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
        selectedColors: room.selectedColors,
        gameState: room.gameState,
        chat: room.chat || [],
        createdAt: room.createdAt,
        savedAt: Date.now(),
        players: getSerializablePlayers(roomCode)
    };

    const filePath = path.join(SAVE_DIR, `${roomCode}.json`);
    fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2), "utf-8");
    console.log(`Sala ${roomCode} salva em JSON.`);
}

// ========================
// Save no Banco de Dados
// ========================
async function saveRoomStateToDb(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const saveData = {
        roomCode: roomCode,
        hostId: room.hostId,
        hostUserId: room.hostUserId,
        status: room.status,
        selectedCountries: room.selectedCountries,
        selectedColors: room.selectedColors,
        gameState: room.gameState,
        chat: room.chat || [],
        createdAt: room.createdAt,
        savedAt: Date.now(),
        players: getSerializablePlayers(roomCode)
    };

    const json = JSON.stringify(saveData);

    try {
        await db.query(`
            INSERT INTO saves (room_code, host_user_id, save_data, status, updated_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (room_code) DO UPDATE SET
                host_user_id = EXCLUDED.host_user_id,
                save_data = EXCLUDED.save_data,
                status = EXCLUDED.status,
                updated_at = CURRENT_TIMESTAMP
        `, [roomCode, room.hostUserId || null, json, room.status]);

        console.log(`Sala ${roomCode} salva no PostgreSQL.`);
    } catch (err) {
        console.error(`Erro ao salvar sala ${roomCode} no PostgreSQL:`, err.message);
    }
}

async function loadRoomStateFromDb(roomCode) {
    const res = await db.query(
        "SELECT save_data FROM saves WHERE room_code = $1",
        [roomCode]
    );

    if (res.rows.length === 0) {
        return null;
    }

    return JSON.parse(res.rows[0].save_data);
}

// ========================
// Lista de jogadores online
// ========================
const playerlist = {
    players: [],

    getAll() {
        return this.players;
    },

    get(uuid) {
        return this.players.find((player) => player.uuid === uuid);
    },

    getByUserId(userId) {
        return this.players.find((player) => player.userId === userId);
    },

    add(uuid, userId, roomCode, playerName) {
        const player = {
            uuid: uuid,
            userId: userId,
            room: roomCode,
            name: playerName,
            country: null,
            color: null
        };

        this.players.push(player);
        return player;
    },

    remove(uuid) {
        this.players = this.players.filter((player) => player.uuid !== uuid);
    },

    removeByRoom(roomCode) {
        this.players = this.players.filter((player) => player.room !== roomCode);
    },

    getByRoom(roomCode) {
        return this.players.filter((player) => player.room === roomCode);
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

    send(socket, {
        cmd: "joined_server",
        content: { uuid: uuid }
    });

    socket.on("message", async (message) => {
        try {
            console.log("Mensagem bruta recebida:", message.toString());

            let data;

            try {
                data = JSON.parse(message.toString());
            } catch (err) {
                console.error("Erro ao parsear mensagem:", err);
                send(socket, {
                    cmd: "error",
                    content: { msg: "Mensagem inválida." }
                });
                return;
            }

            console.log("CMD recebida:", data.cmd);
            console.log("CONTENT recebido:", data.content);

            switch (data.cmd) {
                // ========================
                // Registro
                // ========================
                case "register": {
                    const username = (data.content?.username || "").trim();
                    const email = (data.content?.email || "").trim();
                    const password = data.content?.password || "";

                    const check = await db.query(
                        "SELECT id FROM users WHERE username = $1 OR email = $2",
                        [username, email]
                    );

                    if (check.rows.length > 0) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Usuário já existe." }
                        });
                        break;
                    }

                    const hash = await bcrypt.hash(password, 10);

                    const res = await db.query(
                        "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
                        [username, email, hash]
                    );

                    send(socket, {
                        cmd: "register_success",
                        content: {
                            userId: res.rows[0].id,
                            username,
                            email
                        }
                    });

                    break;
                }
                // ========================
                // Login
                // ========================
                case "login": {
                    const username = (data.content?.username || "").trim();
                    const password = data.content?.password || "";

                    const res = await db.query(
                        "SELECT * FROM users WHERE username = $1",
                        [username]
                    );

                    if (res.rows.length === 0) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Conta não encontrada." }
                        });
                        break;
                    }

                    const user = res.rows[0];

                    const ok = await bcrypt.compare(password, user.password_hash);

                    if (!ok) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Senha incorreta." }
                        });
                        break;
                    }

                    const alreadyConnected = activeUsers.get(user.id);

                    if (alreadyConnected && alreadyConnected.readyState === WebSocket.OPEN) {
                        send(socket, {
                            cmd: "error",
                            content: {
                                msg: "Essa conta já está conectada em outro dispositivo."
                            }
                        });
                        break;
                    }

                    activeUsers.delete(user.id);
                

                    socket.userId = user.id;
                    socket.username = user.username;
                    socket.email = user.email;
                    socket.isAuthenticated = true;

                    activeUsers.set(user.id, socket);

                    send(socket, {
                        cmd: "login_success",
                        content: {
                            userId: user.id,
                            username: user.username,
                            email: user.email
                        }
                    });
                    break;
                }

                case "me": {
                    if (!requireAuth(socket)) {
                        send(socket, {
                            cmd: "not_logged_in",
                            content: {}
                        });
                        break;
                    }

                    send(socket, {
                        cmd: "me",
                        content: {
                            userId: socket.userId,
                            username: socket.username,
                            email: socket.email
                        }
                    });

                    break;
                }

                // ========================
                // Criar sala
                // ========================
                case "create_room": {
                    if (!requireAuth(socket)) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Você precisa estar logado para criar uma sala." }
                        });
                        break;
                    }

                    const salasDoUsuario = Array.from(rooms.values()).filter(
                        (room) => room.hostUserId === socket.userId
                    ).length;

                    if (salasDoUsuario >= 3) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Você só pode criar no máximo 3 salas." }
                        });
                        break;
                    }

                    const playerName = socket.username;
                    let newRoomId = generateRoomCode();

                    while (rooms.has(newRoomId)) {
                        newRoomId = generateRoomCode();
                    }

                    socket.roomId = newRoomId;

                    rooms.set(newRoomId, {
                        players: {},
                        hostId: uuid,
                        hostUserId: socket.userId,
                        status: "waiting",
                        selectedCountries: {},
                        selectedColors: {},
                        gameState: null,
                        createdAt: Date.now(),
                        chat: []
                    });

                    const room = rooms.get(newRoomId);
                    room.players[uuid] = socket;

                    const newPlayer = playerlist.add(uuid, socket.userId, newRoomId, playerName);

                    console.log(`Sala ${newRoomId} criada por ${playerName} (userId ${socket.userId})`);

                    send(socket, {
                        cmd: "room_created",
                        content: {
                            code: newRoomId,
                            countries_taken: [],
                            colors_taken: []
                        }
                    });

                    send(socket, {
                        cmd: "spawn_local_player",
                        content: { player: newPlayer }
                    });

                    sendRoomState(socket, newRoomId);

                    saveRoomState(newRoomId);
                    saveRoomStateToDb(newRoomId);

                    break;
                }

                // ========================
                // Entrar na sala
                // ========================
                case "join_room": {
                    if (!requireAuth(socket)) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Você precisa estar logado para entrar em uma sala." }
                        });
                        break;
                    }

                    const playerName = socket.username;
                    const roomCode = (data.content?.code || "").trim().toUpperCase();
                    const roomToJoin = getRoomByCode(roomCode);

                    if (!roomToJoin) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Sala não encontrada." }
                        });
                        break;
                    }

                    if (roomToJoin.status === "offline") {
                        roomToJoin.online = true;

                        if (!roomToJoin.statusBeforeOffline) {
                            roomToJoin.status = "waiting";
                        } else {
                            roomToJoin.status = roomToJoin.statusBeforeOffline;
                        }
                    }

                    const currentPlayers = playerlist.getByRoom(roomCode).length;

                    if (roomToJoin.status === "offline") {
                        roomToJoin.online = true;
                        roomToJoin.status = roomToJoin.statusBeforeOffline || "waiting";
                    }

                    if (currentPlayers >= 8) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "A sala já está cheia. Máximo de 8 jogadores." }
                        });
                        break;
                    }

                    socket.roomId = roomCode;
                    roomToJoin.players[uuid] = socket;

                    const newPlayer = playerlist.add(uuid, socket.userId, roomCode, playerName);

                    console.log(`Jogador ${playerName} entrou na sala ${roomCode}`);

                    send(socket, {
                        cmd: "room_joined",
                        content: {
                            code: roomCode,
                            countries_taken: getCountriesArray(roomToJoin.selectedCountries),
                            colors_taken: getColorsArray(roomToJoin.selectedColors)
                        }
                    });

                    send(socket, {
                        cmd: "chat_history",
                        content: {
                            messages: roomToJoin.chat || []
                        }
                    });

                    send(socket, {
                        cmd: "spawn_local_player",
                        content: { player: newPlayer }
                    });

                    const roomPlayers = playerlist.getByRoom(roomCode).filter((p) => p.uuid !== uuid);

                    send(socket, {
                        cmd: "spawn_network_players",
                        content: { players: roomPlayers }
                    });

                    for (const clientUuid in roomToJoin.players) {
                        const client = roomToJoin.players[clientUuid];

                        if (client !== socket && client.readyState === WebSocket.OPEN) {
                            send(client, {
                                cmd: "spawn_new_player",
                                content: { player: newPlayer }
                            });
                        }
                    }

                    sendRoomState(socket, roomCode);

                    if (roomToJoin.status === "playing") {
                        send(socket, {
                            cmd: "go_to_map",
                            content: buildRoomState(roomCode)
                        });
                    }

                    saveRoomState(roomCode);
                    saveRoomStateToDb(roomCode);

                    break;
                }

                // ========================
                // Estado da sala
                // ========================
                case "get_room_state": {
                    if (!socket.roomId) break;
                    sendRoomState(socket, socket.roomId);
                    break;
                }

                // ========================
                // Chat
                // ========================
                case "chat": {
                    const room = rooms.get(socket.roomId);

                    if (!room) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Você não está em uma sala." }
                        });
                        break;
                    }

                    const text = String(data.content?.msg || "").trim();

                    if (!text) {
                        break;
                    }

                    const chatData = {
                        uuid: uuid,
                        userId: socket.userId,
                        username: socket.username,
                        msg: text,
                        timestamp: Date.now()
                    };

                    if (!room.chat) {
                        room.chat = [];
                    }

                    room.chat.push(chatData);

                    broadcastToRoom(room, {
                        cmd: "chat_message",
                        content: chatData
                    });

                    saveRoomState(socket.roomId);
                    saveRoomStateToDb(socket.roomId);

                    console.log(`[CHAT ${socket.roomId}] ${socket.username}: ${text}`);

                    break;
                }

                // ========================
                // Host inicia seleção
                // WaitingRoom -> SelecPais
                // ========================
                case "request_start": {
                    const room = rooms.get(socket.roomId);

                    if (!room) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Sala não encontrada." }
                        });
                        break;
                    }

                    if (room.hostId !== uuid) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Apenas o host pode iniciar." }
                        });
                        break;
                    }

                    if (room.status !== "waiting") {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "A seleção já foi iniciada." }
                        });
                        break;
                    }

                    const playersInRoom = playerlist.getByRoom(socket.roomId);

                    if (playersInRoom.length < 2) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Para iniciar precisa de 2 ou mais jogadores." }
                        });
                        break;
                    }

                    room.status = "country_selection";

                    broadcastToRoom(room, {
                        cmd: "start_game",
                        content: buildRoomState(socket.roomId)
                    });

                    broadcastRoomState(socket.roomId);

                    saveRoomState(socket.roomId);
                    saveRoomStateToDb(socket.roomId);

                    console.log(`Host iniciou seleção de país na sala ${socket.roomId}`);

                    break;
                }

                // ========================
                // Seleção de país
                // SelecPais -> SelecCor
                // ========================
                case "select_country": {
                    const room = rooms.get(socket.roomId);

                    if (!room) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Sala não encontrada." }
                        });
                        break;
                    }

                    if (room.status !== "country_selection" && room.status !== "color_selection") {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "A seleção de países não está ativa." }
                        });
                        break;
                    }

                    const countryName = String(data.content?.country || "").trim();

                    if (!countryName) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "País inválido." }
                        });
                        break;
                    }

                    const player = playerlist.get(uuid);

                    if (!player) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Jogador não encontrado." }
                        });
                        break;
                    }

                    if (player.country) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Você já escolheu um país." }
                        });
                        break;
                    }

                    if (room.selectedCountries[countryName]) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Esse país já foi escolhido." }
                        });
                        break;
                    }

                    player.country = countryName;
                    room.selectedCountries[countryName] = uuid;

                    broadcastToRoom(room, {
                        cmd: "country_selected",
                        content: {
                            uuid: uuid,
                            playerName: player.name,
                            country: countryName,
                            countries_taken: getCountriesArray(room.selectedCountries),
                            colors_taken: getColorsArray(room.selectedColors),
                            players: getSerializablePlayers(socket.roomId)
                        }
                    });

                    if (everyoneHasCountry(socket.roomId)) {
                        room.status = "color_selection";

                        broadcastToRoom(room, {
                            cmd: "country_selection_finished",
                            content: buildRoomState(socket.roomId)
                        });

                        console.log(`Todos escolheram país na sala ${socket.roomId}. Indo para seleção de cor.`);
                    }

                    broadcastRoomState(socket.roomId);

                    saveRoomState(socket.roomId);
                    saveRoomStateToDb(socket.roomId);

                    break;
                }

                // ========================
                // Seleção de cor
                // SelecCor -> MapaMundi
                // ========================
                case "select_color": {
                    const room = rooms.get(socket.roomId);

                    if (!room) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Sala não encontrada." }
                        });
                        break;
                    }

                    if (room.status !== "country_selection" && room.status !== "color_selection") {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "A seleção de cores não está ativa." }
                        });
                        break;
                    }

                    const colorName = String(data.content?.color || "").trim();

                    if (!colorName) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Cor inválida." }
                        });
                        break;
                    }

                    const player = playerlist.get(uuid);

                    if (!player) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Jogador não encontrado." }
                        });
                        break;
                    }

                    if (!player.country) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Escolha um país antes da cor." }
                        });
                        break;
                    }

                    if (player.color) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Você já escolheu uma cor." }
                        });
                        break;
                    }

                    if (room.selectedColors[colorName]) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Essa cor já foi escolhida." }
                        });
                        break;
                    }

                    player.color = colorName;
                    room.selectedColors[colorName] = uuid;

                    broadcastToRoom(room, {
                        cmd: "color_selected",
                        content: {
                            uuid: uuid,
                            playerName: player.name,
                            color: colorName,
                            countries_taken: getCountriesArray(room.selectedCountries),
                            colors_taken: getColorsArray(room.selectedColors),
                            players: getSerializablePlayers(socket.roomId)
                        }
                    });

                    if (everyoneHasColor(socket.roomId) && everyoneReadyForMap(socket.roomId)) {
                        room.status = "playing";

                        const playersInRoom = playerlist.getByRoom(socket.roomId);

                        room.gameState = {
                            phase: "playing",
                            players: playersInRoom.map((p) => ({
                            uuid: p.uuid,
                            name: p.name,
                            country: p.country,
                            color: p.color
                            })),
                            playerStats: {}
                        };

                        for (const p of playersInRoom) {
                            room.gameState.playerStats[p.uuid] = {
                                infantry: {
                                    guarnicoes: 0,
                                    armamentos: 0,
                                    estrutura: 0
                                },
                                money: 1000,
                                population: 1000
                            };
                        }

                        broadcastToRoom(room, {
                            cmd: "go_to_map",
                            content: buildRoomState(socket.roomId)
                        });

                        console.log(`Todos escolheram país e cor. Indo para MapaMundi na sala ${socket.roomId}.`);
                    }

                    broadcastRoomState(socket.roomId);

                    saveRoomState(socket.roomId);
                    saveRoomStateToDb(socket.roomId);

                    break;
                }

                // ========================
                // Salvar jogo
                // ========================
                case "save_game": {
                    const room = rooms.get(socket.roomId);

                    if (!room) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Sala não encontrada." }
                        });
                        break;
                    }

                    if (data.content?.gameState) {
                        room.gameState = data.content.gameState;
                    }

                    saveRoomState(socket.roomId);
                    saveRoomStateToDb(socket.roomId);

                    send(socket, {
                        cmd: "game_saved",
                        content: { roomCode: socket.roomId }
                    });

                    break;
                }

                // ========================
                // Carregar save
                // ========================
                case "load_game": {
                    const roomCode = (data.content?.code || "").trim().toUpperCase();

                    loadRoomStateFromDb(roomCode, (err, savedRoom) => {
                        if (err) {
                            console.error(err);
                            send(socket, {
                                cmd: "error",
                                content: { msg: "Erro ao carregar save." }
                            });
                            return;
                        }

                        if (!savedRoom) {
                            send(socket, {
                                cmd: "error",
                                content: { msg: "Save não encontrado." }
                            });
                            return;
                        }

                        send(socket, {
                            cmd: "loaded_game_data",
                            content: savedRoom
                        });
                    });

                    break;
                }

                case "upgrade_infantry": {
                    const room = rooms.get(socket.roomId);

                    if (!room || !room.gameState) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Jogo não iniciado." }
                        });
                        break;
                    }

                    const upgradeType = String(data.content?.type || "");
                    const allowed = ["guarnicoes", "armamentos", "estrutura"];

                    if (!allowed.includes(upgradeType)) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Tipo de upgrade inválido." }
                        });
                        break;
                    }

                    if (!room.gameState.playerStats) {
                        room.gameState.playerStats = {};
                    }

                    if (!room.gameState.playerStats[uuid]) {
                        room.gameState.playerStats[uuid] = {
                            infantry: {
                                guarnicoes: 0,
                                armamentos: 0,
                                estrutura: 0
                            },
                            money: 1000,
                            population: 1000
                        };
                    }

                    const stats = room.gameState.playerStats[uuid];

                    if (!stats.infantry) {
                        stats.infantry = {
                            guarnicoes: 0,
                            armamentos: 0,
                            estrutura: 0
                        };
                    }

                    if (typeof stats.money !== "number") {
                        stats.money = 1000;
                    }

                    const currentLevel = Number(stats.infantry[upgradeType] || 0);
                    const cost = (currentLevel + 1) * 100;

                    if (stats.money < cost) {
                        send(socket, {
                            cmd: "error",
                            content: { msg: "Dinheiro insuficiente." }
                        });
                        break;
                    }

                    stats.money -= cost;
                    stats.infantry[upgradeType] = currentLevel + 1;

                    broadcastToRoom(room, {
                        cmd: "game_state_updated",
                        content: {
                            gameState: room.gameState
                        }
                    });

                    saveRoomState(socket.roomId);
                    saveRoomStateToDb(socket.roomId);

                    console.log(`${socket.username} melhorou infantaria: ${upgradeType} | nível ${stats.infantry[upgradeType]} | dinheiro ${stats.money}`);
                
                    break;
                }

                default: {
                    send(socket, {
                        cmd: "error",
                        content: { msg: `Comando desconhecido: ${data.cmd}` }
                    });
                    break;
                }
            }
        } catch (err) {
            console.error("ERRO GERAL no socket.on(message):", err);

            try {
                send(socket, {
                    cmd: "error",
                    content: { msg: "Erro interno no servidor." }
                });
            } catch (_) {}
        }
    });

    socket.on("close", () => {
        if (socket.userId && activeUsers.get(socket.userId) === socket) {
            activeUsers.delete(socket.userId);
        
        }
        console.log(`Cliente desconectado: ${uuid}`);

        const roomCode = socket.roomId;
        const room = rooms.get(roomCode);

        if (room) {
            const isHost = room.hostId === uuid;

            if (isHost) {
                console.log(`Host saiu da sala ${roomCode}, mas a sala continuará existindo.`);
            }

            delete room.players[uuid];

            const player = playerlist.get(uuid);

            if (player && player.country && room.selectedCountries[player.country] === uuid) {
                delete room.selectedCountries[player.country];
            }

            if (player && player.color && room.selectedColors[player.color] === uuid) {
                delete room.selectedColors[player.color];
            }

            playerlist.remove(uuid);

            const remainingPlayers = playerlist.getByRoom(roomCode);

            if (remainingPlayers.length === 0) {
                room.online = false;
                room.statusBeforeOffline = room.status;
                room.status = "offline";

                saveRoomState(roomCode);
                saveRoomStateToDb(roomCode);

                console.log(`Sala ${roomCode} ficou vazia e está offline.`);
                return;
            }

            for (const clientUuid in room.players) {
                const client = room.players[clientUuid];

                if (client.readyState === WebSocket.OPEN) {
                    send(client, {
                        cmd: "player_disconnected",
                        content: { uuid: uuid }
                    });
                }
            }
            room.online = true;

            broadcastRoomState(roomCode);

            saveRoomState(roomCode);
            saveRoomStateToDb(roomCode);
        }
    });
    socket.on("error", () => {
        if (socket.userId && activeUsers.get(socket.userId) === socket) {
            activeUsers.delete(socket.userId);
            console.log(`Conta liberada por erro: ${socket.username}`);
        }
    });
});