const config = require('../config');
const logger = require('../logger');

const isPostgres = !!process.env.DATABASE_URL;

let db; // SQLite instance
let pool; // PG pool

function getDb() {
  if (isPostgres) {
    if (!pool) {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: parseInt(process.env.PG_POOL_MAX, 10) || 15,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
        // Without a statement timeout a slow query runs until it finishes. On 2026-08-05 a
        // handful of cold-cache searches ran 100-240s each, and because Heroku's router
        // abandons the request at 30s they kept holding their pool connection long after the
        // user had already been sent an error. All 15 connections ended up occupied and every
        // request then failed with "timeout exceeded when trying to connect" — a few slow
        // queries took the whole site down rather than just themselves.
        //
        // 15s is deliberately below the router's 30s: fail the doomed query, free the
        // connection, keep the rest of the site serving. Maintenance work overrides this per
        // session with `SET statement_timeout = 0`, or per process via PG_STATEMENT_TIMEOUT.
        statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT, 10) || 15000,
        query_timeout: (parseInt(process.env.PG_STATEMENT_TIMEOUT, 10) || 15000) + 5000,
      });
      logger.info('PostgreSQL pool connected');
    }
    return pool;
  }

  if (!db) {
    const Database = require('better-sqlite3');
    db = new Database(config.DATABASE_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info({ path: config.DATABASE_PATH }, 'SQLite database connected');
  }
  return db;
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL pool closed');
  }
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite database closed');
  }
}

// A client checked out of the pool has no 'error' listener of its own (the pool only watches IDLE
// clients), so a socket dropped mid-query — a tunnel blip, a server restart — was emitted as an
// unhandled 'error' event and killed the whole process instead of failing the one query. Seen
// 2026-09-26: a long maintenance script over the SSH tunnel died that way. The pending query
// still rejects on its own; this only keeps the event from being fatal.
function guardClient(client) {
  const onError = (err) => logger.warn({ err: err.message }, 'PG checked-out client error');
  client.on('error', onError);
  return () => client.removeListener('error', onError);
}

/**
 * Run one query with a longer statement_timeout than the pool default.
 *
 * The global timeout is deliberately tight (15s) so a slow request cannot hold a pool
 * connection past Heroku's 30s router timeout. A couple of endpoints legitimately need
 * longer: /api/roles and /api/trending aggregate the entire live job set behind a
 * one-hour cache, and measured 20.9s. With the tight timeout their first call after a
 * dyno restart always failed, so the cache never populated and every later call failed
 * too — a slow endpoint became a permanently broken one.
 *
 * Checks out a dedicated client so the SET cannot leak to other queries sharing the pool,
 * and always restores the default before releasing it.
 */
async function queryWithTimeout(sql, params = [], timeoutMs = 60000) {
  if (!isPostgres) return query(sql, params);
  const client = await getDb().connect();
  const unguard = guardClient(client);
  try {
    await client.query(`SET statement_timeout = ${parseInt(timeoutMs, 10)}`);
    let idx = 0;
    const finalSql = sql.replace(/\?/g, () => `$${++idx}`)
      .replace(/datetime\('now'\)/gi, 'NOW()');
    // query_timeout is a POOL-level option, so the client inherits the tight default and
    // aborts long before the raised statement_timeout above ever applies — /api/roles died
    // at 20s with "Query read timeout" despite being allowed 60s server-side. pg accepts a
    // per-query override in the config object, so raise both together.
    const result = await client.query({ text: finalSql, values: params, query_timeout: timeoutMs + 5000 });
    return { rows: result.rows, rowCount: result.rowCount, lastId: result.rows?.[0]?.id || null };
  } finally {
    try { await client.query('SET statement_timeout = DEFAULT'); } catch { /* connection is going away anyway */ }
    unguard();
    client.release();
  }
}

/**
 * Unified query helper. Works with both SQLite and PostgreSQL.
 * - sql: SQL string with ? placeholders (auto-converted to $1,$2... for PG)
 * - params: array of parameters
 * Returns: { rows, rowCount, lastId }
 */
async function query(sql, params = []) {
  if (isPostgres) {
    // Convert ? placeholders to $1, $2, etc.
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    // Convert datetime('now') to NOW()
    const finalSql = pgSql
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/INSERT OR IGNORE/gi, 'INSERT')
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');

    const result = await getDb().query(finalSql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount,
      lastId: result.rows?.[0]?.id || null,
    };
  }

  // SQLite — convert ILIKE to LIKE (SQLite LIKE is case-insensitive for ASCII)
  const sqliteSql = sql.replace(/ILIKE/gi, 'LIKE');
  const database = getDb();
  const isSelect = sqliteSql.trimStart().toUpperCase().startsWith('SELECT');
  const isInsert = sqliteSql.trimStart().toUpperCase().startsWith('INSERT');

  if (isSelect) {
    const rows = database.prepare(sqliteSql).all(...params);
    return { rows, rowCount: rows.length, lastId: null };
  }

  const result = database.prepare(sqliteSql).run(...params);
  return {
    rows: [],
    rowCount: result.changes,
    lastId: isInsert ? result.lastInsertRowid : null,
  };
}

/**
 * Run multiple statements (for schema creation). Only for DDL.
 */
async function exec(sql) {
  if (isPostgres) {
    const pgSql = sql
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
      .replace(/datetime\('now'\)/gi, 'NOW()')
      .replace(/INSERT OR IGNORE/gi, 'INSERT');
    await getDb().query(pgSql);
  } else {
    getDb().exec(sql);
  }
}

/**
 * Run a function inside a transaction.
 */
async function transaction(fn) {
  if (isPostgres) {
    const client = await getDb().connect();
    const unguard = guardClient(client);
    try {
      await client.query('BEGIN');
      const result = await fn({
        async query(sql, params = []) {
          let idx = 0;
          const pgSql = sql
            .replace(/\?/g, () => `$${++idx}`)
            .replace(/datetime\('now'\)/gi, 'NOW()')
            .replace(/INSERT OR IGNORE/gi, 'INSERT');
          return client.query(pgSql, params);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      unguard();
      client.release();
    }
  }

  // SQLite transactions are synchronous
  const database = getDb();
  return database.transaction(() => fn({
    query(sql, params = []) {
      const isSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
      if (isSelect) {
        return { rows: database.prepare(sql).all(...params) };
      }
      const result = database.prepare(sql).run(...params);
      return { rows: [], rowCount: result.changes };
    },
  }))();
}

module.exports = { getDb, closeDb, query, queryWithTimeout, exec, transaction, isPostgres };
