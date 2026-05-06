const bcrypt = require("bcrypt");
const WebSocket = require("ws");
const { db } = require("./database");
const { send } = require("./utils");

const activeUsers = new Map();

async function register(socket, content) {
    const username = (content?.username || "").trim();
    const email = (content?.email || "").trim();
    const password = content?.password || "";

    const check = await db.query(
        "SELECT id FROM users WHERE username = $1 OR email = $2",
        [username, email]
    );

    if (check.rows.length > 0) {
        send(socket, {
            cmd: "error",
            content: { msg: "Usuário já existe." }
        });
        return;
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
}

async function login(socket, content) {
    const username = (content?.username || "").trim();
    const password = content?.password || "";

    const res = await db.query(
        "SELECT * FROM users WHERE username = $1",
        [username]
    );

    const clientVersion = String(content?.version || "");

    if (clientVersion !== GAME_VERSION) {
        send(socket, {
            cmd: "client_outdated",
            content: {
                serverVersion: GAME_VERSION,
                clientVersion: clientVersion
            }
        });
        return;
    }

    if (res.rows.length === 0) {
        send(socket, {
            cmd: "error",
            content: { msg: "Conta não encontrada." }
        });
        return;
    }

    const user = res.rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
        send(socket, {
            cmd: "error",
            content: { msg: "Senha incorreta." }
        });
        return;
    }

    const alreadyConnected = activeUsers.get(user.id);

    if (alreadyConnected && alreadyConnected.readyState === WebSocket.OPEN) {
        send(socket, {
            cmd: "error",
            content: { msg: "Essa conta já está conectada em outro dispositivo." }
        });
        return;
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
}

module.exports = {
    register,
    login,
    activeUsers
};