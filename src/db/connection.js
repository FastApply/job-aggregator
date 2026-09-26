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
        // Default 6, not 15. The Heroku role caps at 40 connections (rolconnlimit; note
        // max_connections reads 1706 and is server-wide/misleading), and that 40 is shared by
        // the local crawler fleet, the Render worker's several processes, the web dyno and any
        // ad-hoc script. At a default of 15 a single process that forgot PG_POOL_MAX could take
        // over a third of the budget on its own — measured 2026-08-05 with the pool hitting
        // 40/40 and sync queries failing with "too many connections for role". Processes that
        // genuinely need more set PG_POOL_MAX explicitly (see scripts/launch-local-crawlers.sh).
        max: parseInt(process.env.PG_POOL_MAX, 10) || 6,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
        // Abort any query that runs longer than 60s instead of hanging forever on a
        // half-dead connection (the SA->us-east-1 link drops mid-query and, without
        // these, a query never returns — freezing the whole crawl loop).
        statement_timeout: 60000,
        query_timeout: 60000,
      });
      // Idle clients can be terminated by the server (Heroku) or a flaky link; pg
      // emits 'error' on the pool for those. Without a listener Node treats it as an
      // uncaught exception and crashes the process — so swallow/log it; the next
      // query just acquires a fresh client.
      pool.on('error', (err) => logger.warn({ err: err.message }, 'PG pool idle-client error (ignored)'));
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

// better-sqlite3 binds only numbers, strings, bigints, buffers and null — a JS
// boolean throws, while pg accepts one happily. Normalise here so callers stay
// dialect-agnostic (jobs.js passes is_remote/remote_worldwide as booleans).
function sqliteParams(params) {
  return params.map(p => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
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
    const rows = database.prepare(sqliteSql).all(...sqliteParams(params));
    return { rows, rowCount: rows.length, lastId: null };
  }

  const result = database.prepare(sqliteSql).run(...sqliteParams(params));
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

  // SQLite. better-sqlite3's own database.transaction() helper rejects a callback
  // that returns a promise ("Transaction function cannot return a promise"), and
  // every caller here is async — so drive BEGIN/COMMIT by hand instead. That is
  // safe because better-sqlite3 statements are synchronous and there is a single
  // connection: nothing else can interleave between the awaits.
  const database = getDb();
  const tx = {
    query(sql, params = []) {
      const isSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
      if (isSelect) {
        return { rows: database.prepare(sql).all(...sqliteParams(params)) };
      }
      const result = database.prepare(sql).run(...sqliteParams(params));
      return { rows: [], rowCount: result.changes };
    },
  };

  database.exec('BEGIN');
  try {
    const result = await fn(tx);
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { getDb, closeDb, query, exec, transaction, isPostgres };
