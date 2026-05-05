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
    return players.length >= 1 && players.every((p) => p.country);
}

function everyoneHasColor(roomCode) {
    const players = playerlist.getByRoom(roomCode);
    return players.length >= 1 && players.every((p) => p.color);
}

function everyoneReadyForMap(roomCode) {
    const players = playerlist.getByRoom(roomCode);
    return players.length >= 1 && players.every((p) => p.country && p.color);
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

    const oldPlayer = playerlist.getByUserIdAndRoom(socket.userId, roomCode);
    const currentPlayers = playerlist.getByRoom(roomCode).length;

    if (!oldPlayer && currentPlayers >= 8) {
        send(socket, {
            cmd: "error",
            content: { msg: "A sala já está cheia. Máximo de 8 jogadores." }
        });
        return;
    }

    let newPlayer = null;

    if (oldPlayer) {
        console.log(`Reconectando ${playerName} na sala ${roomCode}`);

        const oldUuid = oldPlayer.uuid;

        delete roomToJoin.players[oldUuid];

        oldPlayer.uuid = socket.uuid;
        oldPlayer.offline = false;

        socket.roomId = roomCode;
        roomToJoin.players[socket.uuid] = socket;

        newPlayer = oldPlayer;

        if (roomToJoin.status === "country_selection") {
            send(socket, {
                cmd: "start_game",
                content: {
                    countries_taken: roomToJoin.countries_taken || [],
                    players: getSerializablePlayers(roomCode)
                }
            });
        }

        if (oldPlayer.country) {
            delete roomToJoin.selectedCountries[oldPlayer.country];
            roomToJoin.selectedCountries[oldPlayer.country] = socket.uuid;
        }

        if (oldPlayer.color) {
            delete roomToJoin.selectedColors[oldPlayer.color];
            roomToJoin.selectedColors[oldPlayer.color] = socket.uuid;
        }

        if (roomToJoin.gameState?.players) {
            const gsPlayer = roomToJoin.gameState.players.find((p) => p.uuid === oldUuid);
            if (gsPlayer) {
                gsPlayer.uuid = socket.uuid;
            }
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
        content: { players: getSerializablePlayers(roomCode) }
    });

    for (const clientUuid in roomToJoin.players) {
        const client = roomToJoin.players[clientUuid];

        if (client !== socket) {
            send(client, {
                cmd: oldPlayer ? "player_reconnected" : "spawn_new_player",
                content: { player: newPlayer }
            });
        }
    }

    sendRoomState(socket, roomCode);

    if (roomToJoin.status === "country_selection") {
        send(socket, {
            cmd: "start_game",
            content: buildRoomState(roomCode)
        });

        saveRoomState(roomCode);
        saveRoomStateToDb(roomCode);
        return;
    }

    if (roomToJoin.status === "color_selection") {
        if (!newPlayer.country) {
            send(socket, {
                cmd: "start_game",
                content: buildRoomState(roomCode)
            });
        } else {
            send(socket, {
                cmd: "country_selection_finished",
                content: buildRoomState(roomCode)
            });
        }

        saveRoomState(roomCode);
        saveRoomStateToDb(roomCode);
        return;
    }

    if (roomToJoin.status === "playing") {
        if (!newPlayer.country) {
            send(socket, {
                cmd: "late_select_country",
                content: buildRoomState(roomCode)
            });

            saveRoomState(roomCode);
            saveRoomStateToDb(roomCode);
            return;
        }

        if (!newPlayer.color) {
            send(socket, {
                cmd: "late_select_color",
                content: buildRoomState(roomCode)
            });

            saveRoomState(roomCode);
            saveRoomStateToDb(roomCode);
            return;
        }

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
        //return;
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
        //return;
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

    if (room.status === "playing") {
        if (!room.gameState.territories) {
            room.gameState.territories = {};
        }

        if (player.country && !room.gameState.territories[player.country]) {
            room.gameState.territories[player.country] = {
                name: player.country,
                ownerUuid: player.uuid,
                ownerUserId: player.userId,
                ownerName: player.name,
                color: player.color,
                troops: 100,
                defense: 1,
                income: 10,
                population: 1000
            };
        }
    }

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
                userId: p.userId,
                name: p.name,
                country: p.country,
                color: p.color
            })),
            playerStats: {},
            actions: {},
            territories: createInitialTerritories(playersInRoom)
        };

        for (const p of playersInRoom) {
            room.gameState.playerStats[id] = createDefaultStats();
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

function upgradeMilitary(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room || !room.gameState) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogo não iniciado." }
        });
        return;
    }

    const category = String(content?.category || "");
    const type = String(content?.type || "");

    const stats = getPlayerStats(room, socket.userId);

    // cria estrutura se não existir
    if (!stats.military) {
        stats.military = {};
    }

    if (!stats.military[category]) {
        stats.military[category] = {};
    }

    const cat = stats.military[category];

    if (!cat[type] && cat[type] !== 0) {
        cat[type] = 0;
    }

    // =============================
    // REGRAS (INFANTARIA)
    // =============================
    if (category === "infantry") {
        if (type === "guarnicoes") {
            if ((cat.estrutura || 0) <= cat.guarnicoes) {
                send(socket, {
                    cmd: "error",
                    content: { msg: "Estrutura deve ser maior que guarnições." }
                });
                return;
            }
        }

        if (type === "armamentos") {
            if ((cat.guarnicoes || 0) <= cat.armamentos) {
                send(socket, {
                    cmd: "error",
                    content: { msg: "Guarnições deve ser maior que armamentos." }
                });
                return;
            }
        }
    }
    if (category === "naval") {
        if (type === "submarinos") {
            if ((cat.estrutura || 0) <= cat.submarinos) {
                send(socket, {
                    cmd: "error",
                    content: { msg: "Estrutura deve ser maior que submarinos." }
                });
                return;
            }
        }

        if (type === "frotas") {
            if ((cat.estrutura || 0) <= cat.frotas) {
                send(socket, {
                    cmd: "error",
                    content: { msg: "Estrutura deve ser maior que frotas." }
                });
                return;
            }
        }
    }

    const currentLevel = Number(cat[type] || 0);
    const cost = (currentLevel + 1) * 100;

    if (stats.money < cost) {
        send(socket, {
            cmd: "error",
            content: { msg: "Dinheiro insuficiente." }
        });
        return;
    }

    stats.money -= cost;
    cat[type] = currentLevel + 1;

    broadcastToRoom(room, {
        cmd: "game_state_updated",
        content: {
            gameState: room.gameState
        }
    });
}

function handleDisconnect(socket) {
    const roomCode = socket.roomId;
    const room = rooms.get(roomCode);

    if (!room) {
        playerlist.remove(socket.userId);
        return;
    }

    const isHost = room.hostId === socket.userId;

    if (isHost) {
        console.log(`Host saiu da sala ${roomCode}, mas a sala continuará existindo.`);
    }

    delete room.players[socket.userId];

    const player = playerlist.get(socket.userId);

    if (room.status !== "playing") {
        if (player && player.country && room.selectedCountries[player.country] === socket.userId) {
            delete room.selectedCountries[player.country];
        }

        if (player && player.color && room.selectedColors[player.color] === socket.userId) {
            delete room.selectedColors[player.color];
        }
    }

    if (room.status !== "playing") {
        playerlist.remove(socket.userId);
    } else {
        const player = playerlist.get(socket.userId);
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
            content: { uuid: socket.userId }
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
}

function createDefaultStats() {
    return {
        military: {
            infantry: {
                guarnicoes: 0,
                armamentos: 0,
                estrutura: 0
            },
            terrestre: {
                veiculos: 0,
                locomocao: 0,
                carrosDeGuerra: 0
            },
            naval: {
                submarinos: 0,
                frotas: 0,
                estrutura: 0
            },
            aereo: {
                aeronaves: 0,
                antiAereo: 0,
                galpao: 0
            }
        },
        inventory: {
            ferroBruto: 10,
            ferroRefinado: 5,
            fruto: 2,
            petroleo: 5
        },
        money: 1000,
        population: 1000,
        troops: 20,
        defense: 0,
        attacksWon: 0,
        attacksLost: 0
    };
}

function startGameLoop() {
    setInterval(() => {
        for (const [roomCode, room] of rooms.entries()) {
            if (room.status !== "playing") continue;
            if (!room.online) continue;
            if (!room.gameState) continue;

            if (!room.gameState.playerStats) {
                room.gameState.playerStats = {};
            }

            const players = playerlist.getByRoom(roomCode);

            for (const player of players) {
                const id = player.userId;

                if (!room.gameState.playerStats[id]) {
                    room.gameState.playerStats[id] = createDefaultStats();
                }

                const stats = room.gameState.playerStats[id];

                let incomePerSecond = 1;
                let populationPerSecond = 1;

                if (room.gameState.territories) {
                    for (const territory of Object.values(room.gameState.territories)) {
                        if (territory.ownerUserId === player.userId) {
                            incomePerSecond += Number(territory.income || 0);
                            populationPerSecond += 1;
                        }
                    }
                }

                stats.money += incomePerSecond;
                stats.population += populationPerSecond;
            }

            broadcastToRoom(room, {
                cmd: "game_state_updated",
                content: {
                    gameState: room.gameState
                }
            });
        }
    }, 1000);

    console.log("Game loop iniciado.");
}

function doAction(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room || room.status !== "playing" || !room.gameState) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogo não iniciado." }
        });
        return;
    }

    const actionType = String(content?.type || "");
    const now = Date.now();

    if (!room.gameState.actions) {
        room.gameState.actions = {};
    }

    if (!room.gameState.actions[socket.uuid]) {
        room.gameState.actions[socket.uuid] = {
            lastActionAt: 0
        };
    }

    const playerActions = room.gameState.actions[socket.uuid];

    const cooldown = 3000;

    if (now - playerActions.lastActionAt < cooldown) {
        send(socket, {
            cmd: "error",
            content: { msg: "Aguarde para fazer outra ação." }
        });
        return;
    }

    switch (actionType) {
        case "recruit":
            actionRecruit(socket, room, content);
            break;

        case "build":
            actionBuild(socket, room, content);
            break;

        case "attack":
            actionAttack(socket, room, content);
            break;

        case "reinforce":
            actionReinforce(socket, room, content);
            break;
        
        case "attack_territory":
            actionAttackTerritory(socket, room, content);
            break;

        default:
            send(socket, {
                cmd: "error",
                content: { msg: "Ação inválida." }
            });
            return;
    }

    playerActions.lastActionAt = now;

    broadcastToRoom(room, {
        cmd: "game_state_updated",
        content: {
            gameState: room.gameState
        }
    });

    saveRoomState(socket.roomId);
    saveRoomStateToDb(socket.roomId);
}

function getPlayerStats(room, userId) {
    const id = String(userId);

    if (!room.gameState.playerStats) {
        room.gameState.playerStats = {};
    }

    if (!room.gameState.playerStats[id]) {
        room.gameState.playerStats[id] = createDefaultStats();
    }

    return room.gameState.playerStats[id];
}

function actionRecruit(socket, room, content) {
    const amount = Number(content?.amount || 10);
    const stats = getPlayerStats(room, socket.userId);

    const cost = amount * 5;

    if (amount <= 0 || amount > 100) {
        send(socket, {
            cmd: "error",
            content: { msg: "Quantidade inválida." }
        });
        return;
    }

    if (stats.money < cost) {
        send(socket, {
            cmd: "error",
            content: { msg: "Dinheiro insuficiente para recrutar." }
        });
        return;
    }

    if (stats.population < amount) {
        send(socket, {
            cmd: "error",
            content: { msg: "População insuficiente." }
        });
        return;
    }

    stats.money -= cost;
    stats.population -= amount;
    stats.troops = Number(stats.troops || 0) + amount;
}

function actionBuild(socket, room, content) {
    const stats = getPlayerStats(room, socket.userId);
    const cost = 200;

    if (stats.money < cost) {
        send(socket, {
            cmd: "error",
            content: { msg: "Dinheiro insuficiente para construir." }
        });
        return;
    }

    stats.money -= cost;
    stats.defense = Number(stats.defense || 0) + 1;
}

function actionAttack(socket, room, content) {
    const targetUuid = String(content?.targetUuid || "");

    if (!targetUuid || targetUuid === socket.uuid) {
        send(socket, {
            cmd: "error",
            content: { msg: "Alvo inválido." }
        });
        return;
    }

    const attackerStats = getPlayerStats(room, socket.userId);
    const defenderStats = getPlayerStats(room, targetUuid);

    const attackTroops = Number(content?.troops || 0);

    if (attackTroops <= 0 || attackTroops > attackerStats.troops) {
        send(socket, {
            cmd: "error",
            content: { msg: "Tropas inválidas para ataque." }
        });
        return;
    }

    const defenderPower = Number(defenderStats.troops || 0) + Number(defenderStats.defense || 0) * 20;

    attackerStats.troops -= attackTroops;

    if (attackTroops > defenderPower) {
        defenderStats.troops = 0;
        defenderStats.defense = Math.max(0, Number(defenderStats.defense || 0) - 1);

        send(socket, {
            cmd: "action_result",
            content: { msg: "Ataque venceu." }
        });
    } else {
        defenderStats.troops = Math.max(0, Number(defenderStats.troops || 0) - Math.floor(attackTroops / 2));

        send(socket, {
            cmd: "action_result",
            content: { msg: "Ataque falhou." }
        });
    }
}

function createInitialTerritories(playersInRoom) {
    const territories = {};

    for (const player of playersInRoom) {
        if (!player.country) continue;

        territories[player.country] = {
            name: player.country,
            ownerUuid: player.uuid,
            ownerUserId: player.userId,
            ownerName: player.name,
            color: player.color,
            troops: 100,
            defense: 1,
            income: 10,
            population: 1000
        };
    }

    return territories;
}

function actionReinforce(socket, room, content) {
    const territoryName = String(content?.territory || "");
    const amount = Number(content?.amount || 0);

    if (!room.gameState.territories || !room.gameState.territories[territoryName]) {
        send(socket, {
            cmd: "error",
            content: { msg: "Território inválido." }
        });
        console.log(`O player ${socket.username} tentou reforçar um território inválido: ${territoryName}`);
        return;
    }

    const territory = room.gameState.territories[territoryName];

    if (territory.ownerUuid !== socket.uuid) {
        send(socket, {
            cmd: "error",
            content: { msg: "Esse território não é seu." }
        });
        console.log(`O player ${socket.username} tentou reforçar o território ${territoryName} que não é seu.`);
        return;
    }

    const stats = getPlayerStats(room, socket.userId);

    if (amount <= 0 || amount > stats.troops) {
        send(socket, {
            cmd: "error",
            content: { msg: "Quantidade de tropas inválida." }
        });
        console.log(`O player ${socket.username} tentou reforçar o território ${territoryName} com uma quantidade inválida de tropas: ${amount}`);
        return;
    }

    stats.troops -= amount;
    territory.troops += amount;
}

function actionAttackTerritory(socket, room, content) {
    const targetName = String(content?.territory || "").trim();
    const attackTroops = Number(content?.troops || 0);

    if (!room.gameState.territories || !room.gameState.territories[targetName]) {
        send(socket, {
            cmd: "error",
            content: { msg: "Território inválido." }
        });
        console.log(`O player ${socket.username} tentou atacar um território inválido: ${targetName}`);
        return;
    }

    const territory = room.gameState.territories[targetName];

    if (String(territory.ownerUserId) === String(socket.userId)) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você não pode atacar seu próprio território." }
        });
        console.log(`O player ${socket.username} tentou atacar seu próprio território: ${targetName}`);
        return;
    }

    const attackerStats = getPlayerStats(room, socket.userId);

    if (attackTroops <= 0 || attackTroops > attackerStats.troops) {
        send(socket, {
            cmd: "error",
            content: { msg: "Tropas inválidas para ataque." }
        });
        console.log(`O player ${socket.username} tentou atacar o território ${targetName} com uma quantidade inválida de tropas: ${attackTroops}`);
        return;
    }

    const defenseTroops = Number(territory.troops || 0);
    const defenseBonus = Number(territory.defense || 0) * 25;
    const defenderPower = defenseTroops + defenseBonus;

    attackerStats.troops -= attackTroops;

    if (attackTroops > defenderPower) {
        const oldOwnerUserId = territory.ownerUserId;

        territory.ownerUserId = socket.userId;
        territory.ownerUuid = socket.uuid;
        territory.ownerName = socket.username;
        territory.color = getPlayerColorByUserId(room, socket.userId);

        territory.troops = Math.max(1, Math.floor(attackTroops - defenderPower));
        territory.defense = Math.max(0, Number(territory.defense || 0) - 1);

        attackerStats.attacksWon = Number(attackerStats.attacksWon || 0) + 1;

        const defenderStats = getPlayerStats(room, oldOwnerUserId);
        defenderStats.attacksLost = Number(defenderStats.attacksLost || 0) + 1;

        broadcastToRoom(room, {
            cmd: "territory_conquered",
            content: {
                territory: targetName,
                newOwnerUserId: socket.userId,
                newOwnerName: socket.username,
                color: territory.color
            }
        });
        console.log(`Ataque ao território ${targetName} foi um sucesso parcial. Tropas restantes na defesa: ${territory.troops}`);
    } else {
        territory.troops = Math.max(0, defenseTroops - Math.floor(attackTroops / 2));

        attackerStats.attacksLost = Number(attackerStats.attacksLost || 0) + 1;

        const defenderStats = getPlayerStats(room, territory.ownerUserId);
        defenderStats.attacksWon = Number(defenderStats.attacksWon || 0) + 1;
        send(socket, {
            cmd: "action_result",
            content: { msg: "Ataque falhou." }
        });
        console.log(`Ataque ao território ${targetName} falhou. Tropas restantes na defesa: ${territory.troops}`);
    }
}

function getPlayerColorByUserId(room, userId) {
    if (room.gameState?.players) {
        const player = room.gameState.players.find(
            (p) => String(p.userId) === String(userId)
        );

        if (player) {
            return player.color;
        }
    }

    return "Cinza";
}

function ensureMilitaryStats(stats) {
    if (!stats.military) {
        stats.military = {};
    }

    if (!stats.military.infantry) {
        stats.military.infantry = stats.infantry || {
            guarnicoes: 0,
            armamentos: 0,
            estrutura: 0
        };
    }

    if (!stats.military.terrestre) {
        stats.military.terrestre = {
            veiculos: 0,
            locomocao: 0,
            carrosDeGuerra: 0
        };
    }

    if (!stats.military.naval) {
        stats.military.naval = {
            submarinos: 0,
            frotas: 0,
            estrutura: 0
        };
    }

    if (!stats.military.aereo) {
        stats.military.aereo = {
            aeronaves: 0,
            antiAereo: 0,
            galpao: 0
        };
    }

    stats.infantry = stats.military.infantry;
}

function addItem(stats, item, amount) {
    if (!stats.inventory) stats.inventory = {};
    if (!stats.inventory[item]) stats.inventory[item] = 0;

    stats.inventory[item] += amount;
}

function removeItem(stats, item, amount) {
    if (!stats.inventory || !stats.inventory[item]) return false;
    if (stats.inventory[item] < amount) return false;

    stats.inventory[item] -= amount;
    return true;
}

function requestTrade(socket, content) {
    const room = rooms.get(socket.roomId);
    if (!room || !room.gameState) return;

    const fromUserId = socket.userId;
    const targetUserId = Number(content.targetUserId);

    const myItem = content.myItem;
    const myAmount = Number(content.myAmount);

    const targetItem = content.targetItem;
    const targetAmount = Number(content.targetAmount);

    const fromStats = getPlayerStats(room, fromUserId);
    const toStats = getPlayerStats(room, targetUserId);
}

function getSocketByUserId(room, userId) {
    for (const uuid in room.players) {
        const player = playerlist.get(uuid);

        if (player && String(player.userId) === String(userId)) {
            return room.players[uuid];
        }
    }

    return null;
}

function addItem(stats, item, amount) {
    if (!stats.inventory) stats.inventory = {};
    if (!stats.inventory[item]) stats.inventory[item] = 0;

    stats.inventory[item] += amount;
}

function hasItem(stats, item, amount) {
    if (!stats.inventory) return false;
    return Number(stats.inventory[item] || 0) >= amount;
}

function removeItem(stats, item, amount) {
    if (!hasItem(stats, item, amount)) return false;

    stats.inventory[item] -= amount;
    return true;
}

function requestTrade(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room || !room.gameState) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogo não iniciado." }
        });
        return;
    }

    const targetUserId = Number(content?.targetUserId);

    if (!targetUserId || targetUserId === socket.userId) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogador inválido para troca." }
        });
        return;
    }

    const targetSocket = getSocketByUserId(room, targetUserId);

    if (!targetSocket) {
        send(socket, {
            cmd: "error",
            content: { msg: "Jogador não está online." }
        });
        return;
    }

    if (!room.trades) {
        room.trades = {};
    }

    const tradeId = `${socket.userId}_${targetUserId}_${Date.now()}`;

    const trade = {
        tradeId,
        status: "pending",
        requesterUserId: socket.userId,
        targetUserId,
        offers: {
            [socket.userId]: {},
            [targetUserId]: {}
        },
        confirmed: {
            [socket.userId]: false,
            [targetUserId]: false
        }
    };

    room.trades[tradeId] = trade;

    send(targetSocket, {
        cmd: "trade_request",
        content: trade
    });

    send(socket, {
        cmd: "trade_request_sent",
        content: trade
    });
}

function acceptTrade(socket, content) {
    const room = rooms.get(socket.roomId);
    if (!room || !room.trades) return;

    const tradeId = String(content?.tradeId || "");
    const trade = room.trades[tradeId];

    if (!trade) return;

    if (Number(trade.targetUserId) !== Number(socket.userId)) {
        return;
    }

    trade.status = "active";

    const requesterSocket = getSocketByUserId(room, trade.requesterUserId);
    const targetSocket = getSocketByUserId(room, trade.targetUserId);

    const payload = {
        cmd: "trade_started",
        content: trade
    };

    if (requesterSocket) send(requesterSocket, payload);
    if (targetSocket) send(targetSocket, payload);
}

function rejectTrade(socket, content) {
    const room = rooms.get(socket.roomId);
    if (!room || !room.trades) return;

    const tradeId = String(content?.tradeId || "");
    const trade = room.trades[tradeId];

    if (!trade) return;

    if (Number(trade.targetUserId) !== Number(socket.userId)) {
        return;
    }

    trade.status = "rejected";

    const requesterSocket = getSocketByUserId(room, trade.requesterUserId);

    if (requesterSocket) {
        send(requesterSocket, {
            cmd: "trade_rejected",
            content: trade
        });
    }

    delete room.trades[tradeId];
}

function updateTradeOffer(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room || !room.trades || !room.gameState) {
        return;
    }

    const tradeId = String(content?.tradeId || "");
    const trade = room.trades[tradeId];

    if (!trade || trade.status !== "active") {
        send(socket, {
            cmd: "error",
            content: { msg: "Troca não está ativa." }
        });
        return;
    }

    const userId = socket.userId;

    if (
        Number(userId) !== Number(trade.requesterUserId) &&
        Number(userId) !== Number(trade.targetUserId)
    ) {
        return;
    }

    const item = String(content?.item || "");
    const amount = Number(content?.amount || 0);

    if (!item || amount < 0) {
        send(socket, {
            cmd: "error",
            content: { msg: "Item ou quantidade inválida." }
        });
        return;
    }

    const stats = getPlayerStats(room, userId);

    if (amount > 0 && !hasItem(stats, item, amount)) {
        send(socket, {
            cmd: "error",
            content: { msg: "Você não tem quantidade suficiente desse item." }
        });
        return;
    }

    if (amount === 0) {
        delete trade.offers[userId][item];
    } else {
        trade.offers[userId][item] = amount;
    }

    trade.confirmed[trade.requesterUserId] = false;
    trade.confirmed[trade.targetUserId] = false;

    const requesterSocket = getSocketByUserId(room, trade.requesterUserId);
    const targetSocket = getSocketByUserId(room, trade.targetUserId);

    const payload = {
        cmd: "trade_updated",
        content: trade
    };

    if (requesterSocket) send(requesterSocket, payload);
    if (targetSocket) send(targetSocket, payload);
}

function confirmTrade(socket, content) {
    const room = rooms.get(socket.roomId);

    if (!room || !room.trades || !room.gameState) {
        return;
    }

    const tradeId = String(content?.tradeId || "");
    const trade = room.trades[tradeId];

    if (!trade || trade.status !== "active") {
        send(socket, {
            cmd: "error",
            content: { msg: "Troca não está ativa." }
        });
        return;
    }

    const userId = socket.userId;

    if (
        Number(userId) !== Number(trade.requesterUserId) &&
        Number(userId) !== Number(trade.targetUserId)
    ) {
        return;
    }

    trade.confirmed[userId] = true;

    const requesterSocket = getSocketByUserId(room, trade.requesterUserId);
    const targetSocket = getSocketByUserId(room, trade.targetUserId);

    if (!trade.confirmed[trade.requesterUserId] || !trade.confirmed[trade.targetUserId]) {
        const payload = {
            cmd: "trade_confirmed_waiting",
            content: trade
        };

        if (requesterSocket) send(requesterSocket, payload);
        if (targetSocket) send(targetSocket, payload);

        return;
    }

    const statsA = getPlayerStats(room, trade.requesterUserId);
    const statsB = getPlayerStats(room, trade.targetUserId);

    const offerA = trade.offers[trade.requesterUserId];
    const offerB = trade.offers[trade.targetUserId];

    for (const item in offerA) {
        if (!hasItem(statsA, item, offerA[item])) {
            send(socket, {
                cmd: "error",
                content: { msg: "Um dos jogadores não tem mais os itens necessários." }
            });
            return;
        }
    }

    for (const item in offerB) {
        if (!hasItem(statsB, item, offerB[item])) {
            send(socket, {
                cmd: "error",
                content: { msg: "Um dos jogadores não tem mais os itens necessários." }
            });
            return;
        }
    }

    for (const item in offerA) {
        removeItem(statsA, item, offerA[item]);
        addItem(statsB, item, offerA[item]);
    }

    for (const item in offerB) {
        removeItem(statsB, item, offerB[item]);
        addItem(statsA, item, offerB[item]);
    }

    trade.status = "completed";

    const payload = {
        cmd: "trade_completed",
        content: trade
    };

    if (requesterSocket) send(requesterSocket, payload);
    if (targetSocket) send(targetSocket, payload);

    broadcastToRoom(room, {
        cmd: "game_state_updated",
        content: {
            gameState: room.gameState
        }
    });

    delete room.trades[tradeId];

    saveRoomState(socket.roomId);
    saveRoomStateToDb(socket.roomId);
}

module.exports = {
    rooms,
    loadRoomsFromDb,
    startGameLoop,
    requestTrade,
    acceptTrade,
    rejectTrade,
    updateTradeOffer,
    confirmTrade,
    doAction,
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
    upgradeMilitary,
    handleDisconnect
};