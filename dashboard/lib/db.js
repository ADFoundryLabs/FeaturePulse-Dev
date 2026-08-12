"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Railway
    }
});
exports.db = {
    query: (text, params) => pool.query(text, params),
};
//# sourceMappingURL=db.js.map