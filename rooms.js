const fs = require("fs");
const path = require("path");

const { db } = require("./database");
const playerlist = require("./players");
const { send, generateRoomCode, requireAuth } = require("./utils");

const rooms = new Map();

const SAVE_DIR = path.join(__dirname, "saves");
if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
}

function broadcastToRoom(room, payload) {
    for (const clientUuid in room.players) {
        send(room.players[clientUuid], payload);
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
        roomCode,
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

function saveRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const saveData = {
        roomCode,
        hostId: room.hostId,
        hostUserId: room.hostUserId,
        status: room.status,
        statusBeforeOffline: room.statusBeforeOffline || null,
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

async function saveRoomStateToDb(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const saveData = {
        roomCode,
        hostId: room.hostId,
        hostUserId: room.hostUserId,
        status: room.status,
        statusBeforeOffline: room.statusBeforeOffline || null,
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

function me(socket) {
    if (!requireAuth(socket)) {
        send(socket, {
            cmd: "not_logged_in",
            content: {}
        });
        return;
    }

    send(socket, {
        cmd: "me",
        content: {
            userId: socket.userId,
            username: socket.username,
            email: socket.email
        }
    });
}

function createRoom(socket) {
    if (!requireAuth(socket)) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você precisa estar logado para criar uma sala." }
        });
        return;
    }

    const salasDoUsuario = Array.from(rooms.values()).filter(
        (room) => room.hostUserId === socket.userId
    ).length;

    if (salasDoUsuario >= 3) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você só pode criar no máximo 3 salas." }
        });
        return;
    }

    const playerName = socket.username;
    let newRoomId = generateRoomCode();

    while (rooms.has(newRoomId)) {
        newRoomId = generateRoomCode();
    }

    socket.roomId = newRoomId;

    rooms.set(newRoomId, {
        players: {},
        hostId: socket.uuid,
        hostUserId: socket.userId,
        status: "waiting",
        online: true,
        selectedCountries: {},
        selectedColors: {},
        gameState: null,
        createdAt: Date.now(),
        chat: []
    });

    const room = rooms.get(newRoomId);
    room.players[socket.uuid] = socket;

    const newPlayer = playerlist.add(socket.uuid, socket.userId, newRoomId, playerName);

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
}

function joinRoom(socket, content) {
    if (!requireAuth(socket)) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você precisa estar logado para entrar em uma sala." }
        });
        return;
    }

    const playerName = socket.username;
    const roomCode = (content?.code || "").trim().toUpperCase();
    const roomToJoin = getRoomByCode(roomCode);

    if (!roomToJoin) {
        send(socket, {
            cmd: "error",
            content: { msg: "Sala não encontrada." }
        });
        return;
    }

    if (roomToJoin.status === "offline") {
        roomToJoin.online = true;
        roomToJoin.status = roomToJoin.statusBeforeOffline || "waiting";
    }

    const currentPlayers = playerlist.getByRoom(roomCode).length;

    if (currentPlayers >= 8) {
        send(socket, {
            cmd: "error",
            content: { msg: "A sala já está cheia. Máximo de 8 jogadores." }
        });
        return;
    }

    let newPlayer = null;

    const oldPlayer = playerlist.getByUserIdAndRoom(socket.userId, roomCode);

    if (oldPlayer) {
        console.log(`Reconectando ${playerName} na sala ${roomCode}`);

        delete roomToJoin.players[oldPlayer.uuid];

        oldPlayer.uuid = socket.uuid;
        oldPlayer.offline = false;

        socket.roomId = roomCode;
        roomToJoin.players[socket.uuid] = socket;

        newPlayer = oldPlayer;

        if (roomToJoin.gameState?.playerStats?.[oldPlayer.uuid]) {  
            roomToJoin.gameState.playerStats[socket.uuid] = roomToJoin.gameState.playerStats[oldPlayer.uuid];
            delete roomToJoin.gameState.playerStats[oldPlayer.uuid];
        }

        if (oldPlayer.country) {
            roomToJoin.selectedCountries[oldPlayer.country] = socket.uuid;
        }

        if (oldPlayer.color) {
        roomToJoin.selectedColors[oldPlayer.color] = socket.uuid;
        }
    } else {
    socket.roomId = roomCode;
    roomToJoin.players[socket.uuid] = socket;
    newPlayer = playerlist.add(socket.uuid, socket.userId, roomCode, playerName);
    }

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

    const roomPlayers = playerlist.getByRoom(roomCode).filter((p) => p.uuid !== socket.uuid);

    send(socket, {
        cmd: "spawn_network_players",
        content: { players: roomPlayers }
    });

    for (const clientUuid in roomToJoin.players) {
        const client = roomToJoin.players[clientUuid];

        if (client !== socket) {
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
}

function chat(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você não está em uma sala." }
        });
        return;
    }

    const text = String(content?.msg || "").trim();

    if (!text) return;

    const chatData = {
        uuid: socket.uuid,
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
}

function requestStart(socket) {
    const room = rooms.get(socket.roomId);

    if (!room) {
        send(socket, {
            cmd: "error",
            content: { msg: "Sala não encontrada." }
        });
        return;
    }

    if (room.hostId !== socket.uuid) {
        send(socket, {
            cmd: "error",
            content: { msg: "Apenas o host pode iniciar." }
        });
        return;
    }

    if (room.status !== "waiting") {
        send(socket, {
            cmd: "error",
            content: { msg: "A seleção já foi iniciada." }
        });
        return;
    }

    const playersInRoom = playerlist.getByRoom(socket.roomId);

    if (playersInRoom.length < 2) {
        send(socket, {
            cmd: "error",
            content: { msg: "Para iniciar precisa de 2 ou mais jogadores." }
        });
        return;
    }

    room.status = "country_selection";

    broadcastToRoom(room, {
        cmd: "start_game",
        content: buildRoomState(socket.roomId)
    });

    broadcastRoomState(socket.roomId);

    saveRoomState(socket.roomId);
    saveRoomStateToDb(socket.roomId);
}

function selectCountry(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room) {
        send(socket, {
            cmd: "error",
            content: { msg: "Sala não encontrada." }
        });
        return;
    }

    if (room.status !== "country_selection" && room.status !== "color_selection") {
        send(socket, {
            cmd: "error",
            content: { msg: "A seleção de países não está ativa." }
        });
        return;
    }

    const countryName = String(content?.country || "").trim();

    if (!countryName) {
        send(socket, {
            cmd: "error",
            content: { msg: "País inválido." }
        });
        return;
    }

    const player = playerlist.get(socket.uuid);

    if (!player) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogador não encontrado." }
        });
        return;
    }

    if (player.country) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você já escolheu um país." }
        });
        return;
    }

    if (room.selectedCountries[countryName]) {
        send(socket, {
            cmd: "error",
            content: { msg: "Esse país já foi escolhido." }
        });
        return;
    }

    player.country = countryName;
    room.selectedCountries[countryName] = socket.uuid;

    broadcastToRoom(room, {
        cmd: "country_selected",
        content: {
            uuid: socket.uuid,
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
    }

    broadcastRoomState(socket.roomId);

    saveRoomState(socket.roomId);
    saveRoomStateToDb(socket.roomId);
}

function selectColor(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room) {
        send(socket, {
            cmd: "error",
            content: { msg: "Sala não encontrada." }
        });
        return;
    }

    if (room.status !== "country_selection" && room.status !== "color_selection") {
        send(socket, {
            cmd: "error",
            content: { msg: "A seleção de cores não está ativa." }
        });
        return;
    }

    const colorName = String(content?.color || "").trim();

    if (!colorName) {
        send(socket, {
            cmd: "error",
            content: { msg: "Cor inválida." }
        });
        return;
    }

    const player = playerlist.get(socket.uuid);

    if (!player) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogador não encontrado." }
        });
        return;
    }

    if (!player.country) {
        send(socket, {
            cmd: "error",
            content: { msg: "Escolha um país antes da cor." }
        });
        return;
    }

    if (player.color) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você já escolheu uma cor." }
        });
        return;
    }

    if (room.selectedColors[colorName]) {
        send(socket, {
            cmd: "error",
            content: { msg: "Essa cor já foi escolhida." }
        });
        return;
    }

    player.color = colorName;
    room.selectedColors[colorName] = socket.uuid;

    broadcastToRoom(room, {
        cmd: "color_selected",
        content: {
            uuid: socket.uuid,
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
    }

    broadcastRoomState(socket.roomId);

    saveRoomState(socket.roomId);
    saveRoomStateToDb(socket.roomId);
}

function saveGame(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room) {
        send(socket, {
            cmd: "error",
            content: { msg: "Sala não encontrada." }
        });
        return;
    }

    if (content?.gameState) {
        room.gameState = content.gameState;
    }

    saveRoomState(socket.roomId);
    saveRoomStateToDb(socket.roomId);

    send(socket, {
        cmd: "game_saved",
        content: { roomCode: socket.roomId }
    });
}

async function loadGame(socket, content) {
    const roomCode = (content?.code || "").trim().toUpperCase();

    try {
        const savedRoom = await loadRoomStateFromDb(roomCode);

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
    } catch (err) {
        console.error(err);
        send(socket, {
            cmd: "error",
            content: { msg: "Erro ao carregar save." }
        });
    }
}

function upgradeInfantry(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room || !room.gameState) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogo não iniciado." }
        });
        return;
    }

    const upgradeType = String(content?.type || "");
    const allowed = ["guarnicoes", "armamentos", "estrutura"];

    if (!allowed.includes(upgradeType)) {
        send(socket, {
            cmd: "error",
            content: { msg: "Tipo de upgrade inválido." }
        });
        return;
    }

    if (!room.gameState.playerStats) {
        room.gameState.playerStats = {};
    }

    if (!room.gameState.playerStats[socket.uuid]) {
        room.gameState.playerStats[socket.uuid] = {
            infantry: {
                guarnicoes: 0,
                armamentos: 0,
                estrutura: 0
            },
            money: 1000,
            population: 1000
        };
    }

    const stats = room.gameState.playerStats[socket.uuid];

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
        return;
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
}

function handleDisconnect(socket) {
    const roomCode = socket.roomId;
    const room = rooms.get(roomCode);

    if (!room) {
        playerlist.remove(socket.uuid);
        return;
    }

    const isHost = room.hostId === socket.uuid;

    if (isHost) {
        console.log(`Host saiu da sala ${roomCode}, mas a sala continuará existindo.`);
    }

    delete room.players[socket.uuid];

    const player = playerlist.get(socket.uuid);

    if (room.status !== "playing") {
        if (player && player.country && room.selectedCountries[player.country] === socket.uuid) {
            delete room.selectedCountries[player.country];
        }

        if (player && player.color && room.selectedColors[player.color] === socket.uuid) {
            delete room.selectedColors[player.color];
        }
    }

    if (room.status !== "playing") {
        playerlist.remove(socket.uuid);
    } else {
        const player = playerlist.get(socket.uuid);
        if (player) {
            player.offline = true;
        }
    }

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
        send(room.players[clientUuid], {
            cmd: "player_disconnected",
            content: { uuid: socket.uuid }
        });
    }

    room.online = true;

    broadcastRoomState(roomCode);

    saveRoomState(roomCode);
    saveRoomStateToDb(roomCode);
}

async function loadRoomsFromDb() {
    try {
        const res = await db.query("SELECT save_data FROM saves");

        for (const row of res.rows) {
            const savedRoom = JSON.parse(row.save_data);
            const roomCode = savedRoom.roomCode;

            if (!roomCode || rooms.has(roomCode)) {
                continue;
            }

            rooms.set(roomCode, {
                players: {},
                hostId: savedRoom.hostId,
                hostUserId: savedRoom.hostUserId,
                status: savedRoom.status || "offline",
                statusBeforeOffline: savedRoom.statusBeforeOffline || savedRoom.status || "waiting",
                online: false,
                selectedCountries: savedRoom.selectedCountries || {},
                selectedColors: savedRoom.selectedColors || {},
                gameState: savedRoom.gameState || null,
                createdAt: savedRoom.createdAt || Date.now(),
                chat: savedRoom.chat || []
            });

            if (Array.isArray(savedRoom.players)) {
                for (const p of savedRoom.players) {
                    playerlist.addExisting({
                        ...p,
                        room: roomCode,
                        offline: true
                    });
                }
            }

            console.log(`Sala ${roomCode} carregada do PostgreSQL.`);
        }

        console.log(`${res.rows.length} saves verificados no PostgreSQL.`);
    } catch (err) {
        console.error("Erro ao carregar salas do PostgreSQL:", err);
    }
}async function loadRoomsFromDb() {
    try {
        const res = await db.query("SELECT save_data FROM saves");

        for (const row of res.rows) {
            const savedRoom = JSON.parse(row.save_data);
            const roomCode = savedRoom.roomCode;

            if (!roomCode || rooms.has(roomCode)) {
                continue;
            }

            rooms.set(roomCode, {
                players: {},
                hostId: savedRoom.hostId,
                hostUserId: savedRoom.hostUserId,
                status: savedRoom.status || "offline",
                statusBeforeOffline: savedRoom.statusBeforeOffline || savedRoom.status || "waiting",
                online: false,
                selectedCountries: savedRoom.selectedCountries || {},
                selectedColors: savedRoom.selectedColors || {},
                gameState: savedRoom.gameState || null,
                createdAt: savedRoom.createdAt || Date.now(),
                chat: savedRoom.chat || []
            });

            if (Array.isArray(savedRoom.players)) {
                for (const p of savedRoom.players) {
                    playerlist.addExisting({
                        ...p,
                        room: roomCode,
                        offline: true
                    });
                }
            }

            console.log(`Sala ${roomCode} carregada do PostgreSQL.`);
        }

        console.log(`${res.rows.length} saves verificados no PostgreSQL.`);
    } catch (err) {
        console.error("Erro ao carregar salas do PostgreSQL:", err);
    }
}

module.exports = {
    rooms,
    loadRoomsFromDb,
    me,
    createRoom,
    joinRoom,
    sendRoomState,
    chat,
    requestStart,
    selectCountry,
    selectColor,
    saveGame,
    loadGame,
    upgradeInfantry,
    handleDisconnect
};