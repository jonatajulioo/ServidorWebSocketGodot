const express = require("express");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const { initDatabase } = require("./database");
const { send } = require("./utils");
const { register, login, activeUsers } = require("./auth");
const roomsModule = require("./rooms");
const playerlist = require("./players");

const app = express();
const PORT = process.env.PORT || 9090;

initDatabase();

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado na porta ${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (socket) => {
    socket.uuid = randomUUID();
    socket.roomId = null;
    socket.userId = null;
    socket.username = null;
    socket.email = null;
    socket.isAuthenticated = false;

    send(socket, {
        cmd: "joined_server",
        content: { uuid: socket.uuid }
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

        try {
            switch (data.cmd) {
                case "register":
                    await register(socket, data.content);
                    break;

                case "login":
                    await login(socket, data.content);
                    break;

                case "create_room":
                    roomsModule.createRoom(socket);
                    break;

                case "join_room":
                    roomsModule.joinRoom(socket, data.content);
                    break;

                case "get_room_state":
                    roomsModule.sendRoomState(socket, socket.roomId);
                    break;

                case "request_start":
                    roomsModule.requestStart(socket);
                    break;

                case "select_country":
                    roomsModule.selectCountry(socket, data.content);
                    break;

                case "select_color":
                    roomsModule.selectColor(socket, data.content);
                    break;

                case "chat":
                    roomsModule.chat(socket, data.content);
                    break;

                case "upgrade_infantry":
                    roomsModule.upgradeInfantry(socket, data.content);
                    break;

                case "save_game":
                    roomsModule.saveGame(socket, data.content);
                    break;

                case "load_game":
                    await roomsModule.loadGame(socket, data.content);
                    break;

                default:
                    send(socket, {
                        cmd: "error",
                        content: { msg: `Comando desconhecido: ${data.cmd}` }
                    });
            }
        } catch (err) {
            console.error("Erro no comando:", err);
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

        roomsModule.handleDisconnect(socket);
    });

    socket.on("error", () => {
        if (socket.userId && activeUsers.get(socket.userId) === socket) {
            activeUsers.delete(socket.userId);
        }
    });
});