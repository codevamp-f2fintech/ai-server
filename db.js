const { Pool } = require('pg');
require('dotenv').config();

let pool = null;

if (process.env.RESONANX_DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.RESONANX_DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });
}

module.exports = {
    query: (text, params) => {
        if (!pool) {
            throw new Error("RESONANX_DATABASE_URL is not set");
        }
        return pool.query(text, params);
    },
    getPool: () => pool
};
