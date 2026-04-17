// ========================
// Servidor Multiplayer Simples para Godot
// Reescrito com:
// - salas
// - seleção de países
// - save JSON
// - mínimo 2 e máximo 8 jogadores
// ========================

const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 9090;
const server = app.listen(PORT, () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

const SAVE_DIR = path.join(__dirname, "saves");
if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
}

function generateRoomCode(length = 5) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function broadcastToRoom(room, payload) {
    for (const clientUuid in room.players) {
        const client = room.players[clientUuid];
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    }
}

const playerlist = {
    players: [],

    getAll: function () {
        return this.players;
    },

    get: function (uuid) {
        return this.players.find(player => player.uuid === uuid);
    },

    add: function (uuid, roomCode, playerName) {
        const playersInRoom = this.getByRoom(roomCode);
        const isFirstPlayer = playersInRoom.length === 0;

        const player = {
            uuid: uuid,
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

    getByRoom: function (roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

function getSerializablePlayers(roomCode) {
    return playerlist.getByRoom(roomCode).map(player => ({
        uuid: player.uuid,
        room: player.room,
        name: player.name,
        x: player.x,
        y: player.y,
        country: player.country || null
    }));
}

function saveRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const saveData = {
        roomCode: roomCode,
        hostId: room.hostId,
        status: room.status,
        selectedCountries: room.selectedCountries,
        gameState: room.gameState,
        createdAt: room.createdAt,
        savedAt: Date.now(),
        players: getSerializablePlayers(roomCode)
    };

    const filePath = path.join(SAVE_DIR, `${roomCode}.json`);
    fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2), "utf-8");
    console.log(`Sala ${roomCode} salva com sucesso.`);
}

function loadRoomState(roomCode) {
    const filePath = path.join(SAVE_DIR, `${roomCode}.json`);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw);
    } catch (err) {
        console.error(`Erro ao carregar save da sala ${roomCode}:`, err);
        return null;
    }
}

wss.on("connection", (socket) => {
    const uuid = uuidv4();
    socket.uuid = uuid;
    socket.roomId = null;

    console.log(`Cliente conectado: ${uuid}`);

    socket.send(JSON.stringify({
        cmd: "joined_server",
        content: { uuid: uuid }
    }));

    socket.on("message", (message) => {
        let data;

        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao parsear mensagem:", err);
            return;
        }

        switch (data.cmd) {
            case "create_room": {
                const playerName = data.content?.playerName || "Anônimo";
                const newRoomId = generateRoomCode();

                socket.roomId = newRoomId;

                rooms.set(newRoomId, {
                    players: {},
                    hostId: uuid,
                    status: "waiting", // waiting | country_selection | playing
                    selectedCountries: {},
                    gameState: null,
                    createdAt: Date.now()
                });

                rooms.get(newRoomId).players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, newRoomId, playerName);

                console.log(`Sala ${newRoomId} criada pelo jogador ${playerName} id: ${uuid}`);

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
                        status: "waiting",
                        players: getSerializablePlayers(newRoomId),
                        selectedCountries: {},
                        gameState: null
                    }
                }));

                saveRoomState(newRoomId);
                break;
            }

            case "join_room": {
                const playerName = data.content?.playerName || "Anônimo";
                const roomCode = (data.content?.code || "").toUpperCase();
                const roomToJoin = rooms.get(roomCode);

                if (!roomToJoin) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    return;
                }

                const currentPlayers = playerlist.getByRoom(roomCode).length;
                if (currentPlayers >= 8) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "A sala já está cheia. Máximo de 8 jogadores." }
                    }));
                    return;
                }

                socket.roomId = roomCode;
                roomToJoin.players[uuid] = socket;

                const newPlayer = playerlist.add(uuid, roomCode, playerName);

                console.log(`Jogador ${playerName} id ${uuid} entrou na sala ${roomCode}`);

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
                        status: roomToJoin.status,
                        players: getSerializablePlayers(roomCode),
                        selectedCountries: roomToJoin.selectedCountries,
                        gameState: roomToJoin.gameState
                    }
                }));

                saveRoomState(roomCode);
                break;
            }

            case "get_room_state": {
                const room = rooms.get(socket.roomId);
                if (!room) return;

                socket.send(JSON.stringify({
                    cmd: "room_state",
                    content: {
                        roomCode: socket.roomId,
                        hostId: room.hostId,
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
                                    msg: data.content.msg
                                }
                            }));
                        }
                    }
                }
                break;
            }

            case "request_start": {
                console.log(`request_start from ${uuid} in room ${socket.roomId}`);
                const room = rooms.get(socket.roomId);

                if (!room) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    return;
                }

                if (room.hostId !== uuid) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Apenas o host pode iniciar." }
                    }));
                    return;
                }

                const playersInRoom = playerlist.getByRoom(socket.roomId);
                const playerCount = playersInRoom.length;

                if (playerCount < 2) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Para iniciar precisa de 2 ou mais jogadores." }
                    }));
                    return;
                }

                if (playerCount > 8) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Máximo de 8 jogadores por sala." }
                    }));
                    return;
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
                break;
            }

            case "select_country": {
                const room = rooms.get(socket.roomId);

                if (!room) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Sala não encontrada." }
                    }));
                    return;
                }

                if (room.status !== "country_selection") {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "A seleção de países não está ativa." }
                    }));
                    return;
                }

                const countryName = (data.content?.country || "").trim();

                if (!countryName) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "País inválido." }
                    }));
                    return;
                }

                const player = playerlist.get(uuid);
                if (!player) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Jogador não encontrado." }
                    }));
                    return;
                }

                if (player.country) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Você já escolheu um país." }
                    }));
                    return;
                }

                if (room.selectedCountries[countryName]) {
                    socket.send(JSON.stringify({
                        cmd: "error",
                        content: { msg: "Esse país já foi escolhido." }
                    }));
                    return;
                }

                player.country = countryName;
                room.selectedCountries[countryName] = uuid;

                broadcastToRoom(room, {
                    cmd: "country_selected",
                    content: {
                        playerUuid: uuid,
                        playerName: player.name,
                        country: countryName,
                        selectedCountries: room.selectedCountries,
                        players: getSerializablePlayers(socket.roomId)
                    }
                });

                saveRoomState(socket.roomId);

                const playersInRoom = playerlist.getByRoom(socket.roomId);
                const everyoneSelected = playersInRoom.length >= 2 && playersInRoom.every(p => p.country);

                if (everyoneSelected) {
                    room.status = "playing";
                    room.gameState = {
                        turn: 1,
                        currentPlayerIndex: 0,
                        players: playersInRoom.map(p => ({
                            uuid: p.uuid,
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
                    return;
                }

                if (data.content?.gameState) {
                    room.gameState = data.content.gameState;
                }

                saveRoomState(socket.roomId);

                socket.send(JSON.stringify({
                    cmd: "game_saved",
                    content: { roomCode: socket.roomId }
                }));
                break;
            }

            case "load_game": {
                const roomCode = (data.content?.code || "").toUpperCase();
                const savedRoom = loadRoomState(roomCode);

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
                break;
            }

            default:
                socket.send(JSON.stringify({
                    cmd: "error",
                    content: { msg: `Comando desconhecido: ${data.cmd}` }
                }));
                break;
        }
    });

    socket.on("close", () => {
        console.log(`Cliente desconectado: ${uuid}`);
        playerlist.remove(uuid);

        const room = rooms.get(socket.roomId);
        if (room) {
            delete room.players[uuid];

            for (const clientUuid in room.players) {
                const client = room.players[clientUuid];
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        cmd: "player_disconnected",
                        content: { uuid: uuid }
                    }));
                }
            }

            if (Object.keys(room.players).length === 0) {
                saveRoomState(socket.roomId);
                rooms.delete(socket.roomId);
                console.log(`Sala ${socket.roomId} vazia e removida da memória.`);
            } else {
                if (room.hostId === uuid) {
                    const remainingPlayers = Object.keys(room.players);
                    room.hostId = remainingPlayers[0];
                    broadcastToRoom(room, {
                        cmd: "host_changed",
                        content: { hostId: room.hostId }
                    });
                }

                saveRoomState(socket.roomId);
            }
        }
    });
});
