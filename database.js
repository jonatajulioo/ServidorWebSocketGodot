const { Pool } = require("pg");
require("dotenv").config();

const db = new Pool({
    user: process.env.DB_USER || "jota",
    host: process.env.DB_HOST || "localhost",
    database: process.env.DB_NAME || "squad_world_war",
    password: process.env.DB_PASS || "123456",
    port: process.env.DB_PORT || 5432,
    max: 20
});

async function initDatabase() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(30) UNIQUE NOT NULL,
            email VARCHAR(120) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS saves (
            id SERIAL PRIMARY KEY,
            room_code VARCHAR(5) UNIQUE NOT NULL,
            host_user_id INTEGER,
            save_data TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'waiting'
        )
    `);

    console.log("Banco pronto");
}

module.exports = { db, initDatabase };