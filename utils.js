const WebSocket = require("ws");

function send(socket, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

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

module.exports = {
    send,
    generateRoomCode,
    requireAuth
};