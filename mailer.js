function getPublicBaseUrl() {
    return String(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 9090}`).replace(/\/$/, "");
}

function hasSmtpConfig() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function sendVerificationEmail({ email, username, token }) {
    const verifyUrl = `${getPublicBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;

    if (!hasSmtpConfig()) {
        console.warn(`SMTP nao configurado. Link de verificacao para ${email}: ${verifyUrl}`);
        return {
            sent: false,
            verifyUrl
        };
    }

    let nodemailer;

    try {
        nodemailer = require("nodemailer");
    } catch {
        console.warn(`Dependencia nodemailer nao instalada. Link de verificacao para ${email}: ${verifyUrl}`);
        return {
            sent: false,
            verifyUrl
        };
    }

    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    const from = process.env.MAIL_FROM || process.env.SMTP_USER;
    const gameName = process.env.MAIL_GAME_NAME || "SQUAD WORLD WAR";

    await transporter.sendMail({
        from,
        to: email,
        subject: `Verifique seu e-mail - ${gameName}`,
        text: `Ola ${username}, confirme seu e-mail para jogar ${gameName}: ${verifyUrl}`,
        html: `
            <div style="font-family:Arial,sans-serif;line-height:1.5">
                <h2>Verifique seu e-mail</h2>
                <p>Ola ${escapeHtml(username)}, confirme seu e-mail para jogar ${escapeHtml(gameName)}.</p>
                <p><a href="${verifyUrl}" style="display:inline-block;background:#2d6cdf;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Verificar e-mail</a></p>
                <p>Se o botao nao abrir, copie este link:</p>
                <p>${verifyUrl}</p>
            </div>
        `
    });

    return {
        sent: true,
        verifyUrl
    };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[ch]);
}

module.exports = {
    sendVerificationEmail
};
