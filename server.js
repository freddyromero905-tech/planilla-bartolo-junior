const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 4175);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": type.includes("text/html") ? "no-store" : "no-cache",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      return send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    }

    const cleanPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.resolve(root, `.${cleanPath}`);
    if (!filePath.startsWith(root)) return send(res, 403, "Acceso denegado");

    fs.readFile(filePath, (err, content) => {
      if (err) return send(res, 404, "No encontrado");
      send(res, 200, content, types[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    });
  } catch (error) {
    send(res, 500, `Error servidor: ${error.message}`);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Planilla Bartolo lista en puerto ${port}`);
});
