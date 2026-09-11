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
        //
        // DO NOT let the web dyno run on this default. src/web.js serves live traffic and a
        // pool of 6 was not enough: within a minute of trying it, /api/jobs returned 500s with
        // "timeout exceeded when trying to connect" (connectionTimeoutMillis=10s) and the router
        // logged H12s. fastapply-board runs with PG_POOL_MAX=14. Background crawlers can be
        // starved briefly and retry; a user-facing request cannot.
        max: parseInt(process.env.PG_POOL_MAX, 10) || 6,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
        // Abort any query that runs longer than this instead of hanging forever on a
        // half-dead connection (the SA->us-east-1 link drops mid-query and, without
        // these, a query never returns — freezing the whole crawl loop).
        //
        // 15s, not 60s. Heroku's router gives up on a request at 30s, so a 60s ceiling meant
        // a doomed query kept holding its pool connection for a further 30s after the user
        // had already been sent an error. On 2026-08-05 a handful of cold-cache searches
        // running 100-240s occupied all 14 web connections, and *every* request then failed
        // with "timeout exceeded when trying to connect" — a few slow queries took the whole
        // site down rather than just themselves. Failing the slow query fast is strictly
        // better: it frees the connection while the rest of the site keeps serving.
        //
        // Maintenance work that legitimately runs long (VACUUM, bulk UPDATE, index builds)
        // overrides this per session with `SET statement_timeout = 0`, or per process via
        // PG_STATEMENT_TIMEOUT.
        statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT, 10) || 15000,
        // Client-side counterpart of statement_timeout above; kept slightly higher so the
        // server's own cancel wins and we get a real Postgres error rather than a dangling
        // client-side abort.
        query_timeout: (parseInt(process.env.PG_STATEMENT_TIMEOUT, 10) || 15000) + 5000,
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
    client.release();
  }
}

/**
 * Unified query helper. Works with both SQLite and PostgreSQL.
 * - sql: SQL string with ? placeholders (auto-converted to $1,$2... for PG)
 * - params: array of parameters
 * Returns: { rows, rowCount, lastId }
 */
/**
 * Errors worth retrying: the connection never reached Postgres.
 *
 * This machine resolves through one nameserver — the home router — and the fleet (eleven
 * crawlers, two pruners, several backfillers) makes thousands of lookups a minute. Under that
 * load the router's DNS intermittently fails, and `getaddrinfo ENOTFOUND` surfaces on a host
 * that resolves 10/10 when tested by hand. Measured 2026-08-27: the dead-job pruner lost four
 * whole cycles to it between 07:36 and 08:58, dropping retirement from ~9,000/hour to ~200.
 * The same blip killed the Oracle description drain on 08-24 and put a `db_error` line in the
 * health log.
 *
 * A momentary lookup failure should cost a few seconds, not a cycle's work.
 *
 * EADDRNOTAVAIL / EHOSTUNREACH / ENETUNREACH are the same family seen from the other side: the
 * local stack could not get a socket out at all. A long production backfill died on
 * EADDRNOTAVAIL mid-run — the connection never reached Postgres, which is exactly the case this
 * retry exists for, and it was missing only because the earlier failures happened to surface as
 * ENOTFOUND.
 *
 * SQL errors, statement timeouts and read timeouts are deliberately NOT here. Those mean the
 * query genuinely reached the database and failed, or that the database is already struggling —
 * retrying those adds load to something that is telling you it has too much.
 */
const RETRYABLE_DB_ERRORS = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EADDRNOTAVAIL|EHOSTUNREACH|ENETUNREACH|Connection terminated|socket hang up/i;
const DB_RETRY_ATTEMPTS = parseInt(process.env.DB_RETRY_ATTEMPTS, 10) || 3;

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

    let lastErr;
    for (let attempt = 0; attempt < DB_RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await getDb().query(finalSql, params);
        return {
          rows: result.rows,
          rowCount: result.rowCount,
          lastId: result.rows?.[0]?.id || null,
        };
      } catch (err) {
        lastErr = err;
        const transient = RETRYABLE_DB_ERRORS.test(err.message || '') || RETRYABLE_DB_ERRORS.test(err.code || '');
        if (!transient || attempt === DB_RETRY_ATTEMPTS - 1) throw err;
        // Short, growing backoff — a DNS hiccup clears in well under a second, and waiting
        // longer on a write path just holds a pool connection open for no benefit.
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1) ** 2));
      }
    }
    throw lastErr;
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

/**
 * Run a function inside a transaction.
 */
async function transaction(fn) {
  if (isPostgres) {
    const client = await getDb().connect();
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

module.exports = { getDb, closeDb, query, queryWithTimeout, exec, transaction, isPostgres };
