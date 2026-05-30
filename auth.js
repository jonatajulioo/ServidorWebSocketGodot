const bcrypt = require("bcrypt");
const WebSocket = require("ws");
const crypto = require("crypto");
const { db } = require("./database");
const { sendVerificationEmail } = require("./mailer");
const { send } = require("./utils");

const activeUsers = new Map();
const GAME_VERSION = "0.0.1ALPHA";
const VERIFICATION_TOKEN_HOURS = 24;

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function createVerificationToken() {
    return crypto.randomBytes(32).toString("hex");
}

async function setAndSendVerificationEmail(userId, username, email) {
    const token = createVerificationToken();
    const tokenHash = hashToken(token);
    const expires = new Date(Date.now() + VERIFICATION_TOKEN_HOURS * 60 * 60 * 1000);

    await db.query(
        `UPDATE users
         SET email_verification_token_hash = $1,
             email_verification_expires = $2
         WHERE id = $3`,
        [tokenHash, expires, userId]
    );

    return sendVerificationEmail({
        email,
        username,
        token
    });
}

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
        `INSERT INTO users (username, email, password_hash, email_verified)
         VALUES ($1, $2, $3, FALSE)
         RETURNING id`,
        [username, email, hash]
    );

    const emailResult = await setAndSendVerificationEmail(res.rows[0].id, username, email);

    send(socket, {
        cmd: "register_success",
        content: {
            userId: res.rows[0].id,
            username,
            email,
            emailVerificationRequired: true,
            emailSent: emailResult.sent === true
        }
    });
}

async function verifyEmailToken(token) {
    const tokenHash = hashToken(String(token || ""));

    const res = await db.query(
        `UPDATE users
         SET email_verified = TRUE,
             email_verified_at = CURRENT_TIMESTAMP,
             email_verification_token_hash = NULL,
             email_verification_expires = NULL
         WHERE email_verification_token_hash = $1
           AND email_verification_expires > CURRENT_TIMESTAMP
         RETURNING id, username, email`,
        [tokenHash]
    );

    if (res.rows.length === 0) {
        return null;
    }

    return res.rows[0];
}

async function resendVerificationEmail(socket, content) {
    const username = String(content?.username || "").trim();
    const password = String(content?.password || "");

    const res = await db.query(
        "SELECT * FROM users WHERE username = $1",
        [username]
    );

    if (res.rows.length === 0) {
        send(socket, {
            cmd: "error",
            content: { msg: "Conta nao encontrada." }
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

    if (user.email_verified === true) {
        send(socket, {
            cmd: "error",
            content: { msg: "Esse e-mail ja foi verificado." }
        });
        return;
    }

    const emailResult = await setAndSendVerificationEmail(user.id, user.username, user.email);

    send(socket, {
        cmd: "verification_email_sent",
        content: {
            email: user.email,
            emailSent: emailResult.sent === true
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

    if (user.email_verified !== true) {
        send(socket, {
            cmd: "error",
            content: {
                msg: "Verifique seu e-mail antes de entrar.",
                emailNotVerified: true
            }
        });
        return;
    }

    const alreadyConnected = activeUsers.get(user.id);

    if (alreadyConnected && alreadyConnected.readyState === WebSocket.OPEN && content?.reconnect !== true) {
        send(socket, {
            cmd: "error",
            content: { msg: "Essa conta já está conectada em outro dispositivo." }
        });
        return;
    }

    if (alreadyConnected && alreadyConnected.readyState === WebSocket.OPEN) {
        alreadyConnected.terminate();
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
    verifyEmailToken,
    resendVerificationEmail,
    setAndSendVerificationEmail,
    activeUsers
};
