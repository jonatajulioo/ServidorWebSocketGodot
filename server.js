// ========================
// Servidor Multiplayer Simples para Godot
// Criado pelo Zee GameDev lindo de mãe
// ========================

const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;
const server = app.listen(PORT, () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function generateRoomCode(length = 5) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

const playerlist = {
    players: [],
    
    getAll: function() {
        return this.players;
    },
    
    get: function(uuid) {
        return this.players.find(player => player.uuid === uuid);
    },
    
    // Adiciona um novo jogador – agora com nome e posição inicial
    add: function(uuid, roomCode, playerName) {
        const playersInRoom = this.getByRoom(roomCode);
        const isFirstPlayer = playersInRoom.length === 0;

        let player = {
            uuid: uuid,
            room: roomCode,
            name: playerName,
            x: isFirstPlayer ? 550 : 700,   // posição inicial padrão
            y: 300,
        };

        this.players.push(player);
        return player;
    },
    
    update: function(uuid, newX, newY) {
        const player = this.get(uuid);
        if (player) {
            player.x = newX;
            player.y = newY;
        }
    },
    
    remove: function(uuid) {
        this.players = this.players.filter(player => player.uuid !== uuid);
    },
    
    getByRoom: function(roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

wss.on("connection", (socket) => {
    const uuid = uuidv4();
    socket.uuid = uuid;
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
                const playerName = data.content.playerName || "Anônimo";
                const newRoomId = generateRoomCode();
                socket.roomId = newRoomId;
                rooms.set(newRoomId, { 
                    players: {},
                    hostId: uuid
                });
    
                // 🔥 ADICIONE ESTA LINHA:
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
                break;
            }
            
            case "join_room": {
                const playerName = data.content.playerName || "Anônimo";
                const roomCode = data.content.code.toUpperCase();
                const roomToJoin = rooms.get(roomCode);
                
                if (!roomToJoin) {
                    socket.send(JSON.stringify({ 
                        cmd: "error", 
                        content: { msg: "Sala não encontrada." } 
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
                
                const roomPlayers = playerlist.getByRoom(roomCode)
                    .filter(p => p.uuid !== uuid);
                
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
                break;
            }

            case "get_room_state": {
                const room = rooms.get(socket.roomId);
                if (room) {
                    const playersInRoom = playerlist.getByRoom(socket.roomId);
                    socket.send(JSON.stringify({
                        cmd: "spawn_network_players",
                        content: { players: playersInRoom }
                    }));
                }
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
                    console.log(`Room ${socket.roomId} not found`);
                    return;
                }
                console.log(`Host id: ${room.hostId}, requesting id: ${uuid}`);
                if (room && room.hostId === uuid) {
                    const playerCount = Object.keys(room.players).length;
                    console.log(`Player count: ${playerCount}`);
                    if (playerCount >= 2) {
                        for (const clientUuid in room.players) {
                            const client = room.players[clientUuid];
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ cmd: "start_game", content: {} }));
                                console.log(`start_game sent to ${clientUuid}`);
                            }        
                        }
                    } else {
                        socket.send(JSON.stringify({ cmd: "error", content: { msg: "Para iniciar precisa de dois ou mais jogadores" } }));
                    }
                } else {
                    console.log(`Unauthorized: user ${uuid} is not host`);
                }
                break;
            }
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
                rooms.delete(socket.roomId);
                console.log(`Sala ${socket.roomId} vazia e removida.`);
            }
        }
    });
});
