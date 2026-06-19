const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 4175);
const databaseUrl = process.env.DATABASE_URL || "";
const localStorePath = path.join(root, ".planilla-cloud.json");
const Pool = databaseUrl ? require("pg").Pool : null;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: /localhost|\.internal(?::|\/|$)/i.test(databaseUrl) ? false : { rejectUnauthorized: false }
    })
  : null;

let localRecords = {};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": type.includes("text/html") || type.includes("json") ? "no-store" : "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS"
  });
  res.end(body);
}

function sendJson(res, code, payload) {
  send(res, code, JSON.stringify(payload), "application/json; charset=utf-8");
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error("Datos demasiado grandes");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function initStorage() {
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS planilla_records (
        record_key TEXT PRIMARY KEY,
        record_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return;
  }

  try {
    localRecords = JSON.parse(await fs.promises.readFile(localStorePath, "utf8"));
  } catch {
    localRecords = {};
  }
}

async function getRecords() {
  if (pool) {
    const result = await pool.query(
      "SELECT record_key, record_type, payload, updated_at FROM planilla_records ORDER BY record_key"
    );
    return result.rows.map((row) => ({
      key: row.record_key,
      type: row.record_type,
      data: row.payload,
      updatedAt: row.updated_at
    }));
  }

  return Object.values(localRecords);
}

async function upsertRecords(records) {
  const normalized = records.slice(0, 500).map((record) => ({
    key: String(record.key || "").slice(0, 220),
    type: String(record.type || "data").slice(0, 40),
    data: record.data && typeof record.data === "object" ? record.data : {},
    updatedAt: new Date().toISOString()
  })).filter((record) => record.key);

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of normalized) {
        await client.query(
          `INSERT INTO planilla_records (record_key, record_type, payload, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (record_key)
           DO UPDATE SET record_type = EXCLUDED.record_type, payload = EXCLUDED.payload, updated_at = NOW()`,
          [record.key, record.type, JSON.stringify(record.data)]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return normalized.length;
  }

  normalized.forEach((record) => {
    localRecords[record.key] = record;
  });
  await fs.promises.writeFile(localStorePath, JSON.stringify(localRecords, null, 2), "utf8");
  return normalized.length;
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, storage: pool ? "postgres" : "local" });
  }

  if (url.pathname === "/api/sync" && req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      storage: pool ? "postgres" : "local",
      records: await getRecords()
    });
  }

  if (url.pathname === "/api/sync" && (req.method === "PUT" || req.method === "POST")) {
    const body = await readJson(req);
    if (!Array.isArray(body.records)) return sendJson(res, 400, { ok: false, error: "Faltan registros" });
    const saved = await upsertRecords(body.records);
    return sendJson(res, 200, { ok: true, saved, storage: pool ? "postgres" : "local" });
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled !== false) return;
      return sendJson(res, 404, { ok: false, error: "API no encontrada" });
    }

    const cleanPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.resolve(root, `.${cleanPath}`);
    if (!filePath.startsWith(root) || path.basename(filePath).startsWith(".")) {
      return send(res, 403, "Acceso denegado");
    }

    fs.readFile(filePath, (error, content) => {
      if (error) return send(res, 404, "No encontrado");
      send(res, 200, content, types[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

initStorage()
  .then(() => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`Planilla Bartolo lista en puerto ${port} (${pool ? "Postgres" : "archivo local"})`);
    });
  })
  .catch((error) => {
    console.error("No se pudo iniciar almacenamiento:", error);
    process.exit(1);
  });
