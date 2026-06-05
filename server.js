const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = 80;
const DATA_FILE = path.join(__dirname, "data", "data.json");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

let database = {};
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      database = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (e) { console.error("读数据文件失败:", e.message); }
}
function saveData() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(database, null, 2));
  } catch (e) { console.error("保存数据文件失败:", e.message); }
}
loadData();

const TABLES = ["stores","products","shipments","boxes","box_labels","box_products","daily_sales"];
for (const t of TABLES) { if (!database[t]) database[t] = []; }

function sendJSON(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, fileRequested) {
  const filePath = path.join(__dirname, fileRequested);
  if (!filePath.startsWith(__dirname)) {
    sendJSON(res, 403, { error: "Forbidden" });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const ct = MIME[ext] || "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, "index.html"), (err2, data2) => {
        if (err2) sendJSON(res, 404, { error: "Not Found" });
        else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(data2); }
      });
    } else {
      res.writeHead(200, { "Content-Type": ct });
      res.end(data);
    }
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const reqPath = parsed.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    });
    res.end();
    return;
  }

  // POST /api/import
  if (reqPath === "/api/import" && method === "POST") {
    parseBody(req).then(data => {
      for (const t of TABLES) { if (Array.isArray(data[t])) database[t] = data[t]; }
      saveData();
      sendJSON(res, 200, { success: true });
    }).catch(() => sendJSON(res, 400, { error: "Invalid JSON" }));
    return;
  }

  // GET /api/export
  if (reqPath === "/api/export" && method === "GET") {
    sendJSON(res, 200, database);
    return;
  }

  // GET /api/stats
  if (reqPath === "/api/stats" && method === "GET") {
    const stats = {};
    for (const t of TABLES) stats[t] = (database[t] || []).length;
    sendJSON(res, 200, stats);
    return;
  }

  // Match /api/<table>/...
  const apiMatch = reqPath.match(/^\/api\/(\w+)(?:\/(.+))?$/);
  if (apiMatch) {
    const table = apiMatch[1];
    const rest = apiMatch[2] || "";

    if (!database[table]) {
      sendJSON(res, 404, { error: "表不存在" });
      return;
    }

    // GET /api/:table/index/:indexName/:value
    const idxMatch = rest.match(/^index\/([^\/]+)\/(.+)$/);
    if (idxMatch && method === "GET") {
      const results = database[table].filter(r => String(r[idxMatch[1]]) === idxMatch[2]);
      sendJSON(res, 200, results);
      return;
    }

    // GET /api/:table/composite/:indexName/:values
    const compMatch = rest.match(/^composite\/([^\/]+)\/(.+)$/);
    if (compMatch && method === "GET") {
      const values = compMatch[2].split(",");
      const results = database[table].filter(r => {
        const idx = r[compMatch[1]];
        return idx && idx.length === values.length && idx.every((v, i) => String(v) === values[i]);
      });
      sendJSON(res, 200, results);
      return;
    }

    // GET /api/:table/range/:indexName/:lower/:upper
    const rangeMatch = rest.match(/^range\/([^\/]+)\/([^\/]+)\/([^\/]+)$/);
    if (rangeMatch && method === "GET") {
      const results = database[table].filter(r => {
        const val = r[rangeMatch[1]];
        return val && val >= rangeMatch[2] && val <= rangeMatch[3];
      });
      sendJSON(res, 200, results);
      return;
    }

    // With numeric ID
    const idNum = parseInt(rest);
    if (!isNaN(idNum)) {
      if (method === "GET") {
        const record = database[table].find(r => r.id === idNum);
        if (!record) { sendJSON(res, 404, { error: "记录不存在" }); return; }
        sendJSON(res, 200, record);
        return;
      }
      if (method === "PUT") {
        const idx = database[table].findIndex(r => r.id === idNum);
        if (idx === -1) { sendJSON(res, 404, { error: "记录不存在" }); return; }
        parseBody(req).then(data => {
          database[table][idx] = { ...database[table][idx], ...data, id: idNum };
          saveData();
          sendJSON(res, 200, database[table][idx]);
        }).catch(() => sendJSON(res, 400, { error: "Invalid JSON" }));
        return;
      }
      if (method === "DELETE") {
        const idx = database[table].findIndex(r => r.id === idNum);
        if (idx === -1) { sendJSON(res, 404, { error: "记录不存在" }); return; }
        database[table].splice(idx, 1);
        saveData();
        sendJSON(res, 200, { success: true });
        return;
      }
    }

    // Without ID
    if (method === "GET") { sendJSON(res, 200, database[table]); return; }
    if (method === "POST") {
      parseBody(req).then(data => {
        const maxId = database[table].reduce((max, r) => Math.max(max, r.id || 0), 0);
        data.id = maxId + 1;
        database[table].push(data);
        saveData();
        res.writeHead(201, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(data));
      }).catch(() => sendJSON(res, 400, { error: "Invalid JSON" }));
      return;
    }

    sendJSON(res, 405, { error: "Method Not Allowed" });
    return;
  }

  // Static files
  let filePath = reqPath === "/" ? "/index.html" : reqPath;
  serveStatic(req, res, filePath);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("  库存与销量管理系统 - HTTP 服务器已启动");
  console.log("  本机访问: http://localhost:" + PORT);
  const os2 = require("os");
  const ifaces = os2.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log("  局域网访问: http://" + iface.address + ":" + PORT);
      }
    }
  }
  console.log("========================================");
  console.log("  按 Ctrl+C 停止服务器");
});


