const express = require("express");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");


const { initDatabase } = require("./database");
const { send } = require("./utils");
const { register, login, activeUsers } = require("./auth");
const rooms = require("./rooms");

const app = express();
const PORT = process.env.PORT || 9090;

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