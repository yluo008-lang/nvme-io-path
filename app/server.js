/* NVMe IO 教学 —— Bootlin 源码代理服务（无第三方依赖）
 * 给定 内核版本 + 标识符(函数/结构体) [+ 文件提示]，从 elixir.bootlin.com
 * 解析出该标识符的“真实定义”代码，返回 JSON。
 * 监听 127.0.0.1:3132，由 nginx 反代到 /nvme-io-path/api/。
 */
"use strict";
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = 3132, HOST = "127.0.0.1", BOOTLIN = "elixir.bootlin.com";
const cache = new Map();          // key -> {t, body}
const srcCache = new Map();       // tag|file -> {t, lines}
const TTL = 1000 * 60 * 60 * 6;

/* ---------- HTTP ---------- */
function fetchText(url, depth) {
  depth = depth || 0;
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("too many redirects"));
    const u = new URL(url);
    const req = https.get(
      { host: u.host, path: u.pathname + u.search, timeout: 15000,
        headers: { "User-Agent": "nvme-io-teach/1.0", "Accept": "text/html" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchText(new URL(res.headers.location, url).toString(), depth + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
        let data = ""; res.setEncoding("utf8");
        res.on("data", (c) => { data += c; if (data.length > 14e6) { req.destroy(); reject(new Error("too large")); } });
        res.on("end", () => resolve(data));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/* ---------- HTML 工具 ---------- */
const stripTags = (s) => s.replace(/<[^>]*>/g, "");
function unescapeHtml(s) {
  const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === "#") {
      const c = /^#x/i.test(g) ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return isFinite(c) ? String.fromCodePoint(c) : m;
    }
    return Object.prototype.hasOwnProperty.call(map, g) ? map[g] : m;
  });
}
function parseLines(html) {
  const lines = [];
  const parts = html.split('<span id="codeline-');
  for (let i = 1; i < parts.length; i++) {
    const m = /^(\d+)">/.exec(parts[i]);
    if (!m) continue;
    lines.push({ n: parseInt(m[1], 10), text: unescapeHtml(stripTags(parts[i].slice(m[0].length))).replace(/\s+$/, "") });
  }
  return lines;
}

/* ---------- 定义定位 ---------- */
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function braceMatch(lines, start) {
  let depth = 0, started = false;
  for (let i = start; i < lines.length; i++) {
    const s = lines[i].text;
    let inBlock = false, inStr = false, inChr = false;
    for (let j = 0; j < s.length; j++) {
      const c = s[j], nx = s[j + 1];
      if (inBlock) { if (c === "*" && nx === "/") { inBlock = false; j++; } continue; }
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; continue; }
      if (inChr) { if (c === "\\") j++; else if (c === "'") inChr = false; continue; }
      if (c === "/" && nx === "/") break;
      if (c === "/" && nx === "*") { inBlock = true; j++; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === "'") { inChr = true; continue; }
      if (c === "{") { depth++; started = true; }
      else if (c === "}") { depth--; if (started && depth === 0) return i; }
    }
    if (!started && /;\s*$/.test(s)) return -1;   // 原型/声明
  }
  return -1;
}

function findDefinition(lines, ident) {
  const callRe = new RegExp("(^|[^\\w.>])" + esc(ident) + "\\s*\\(");
  const typeRe = new RegExp("\\b(struct|union|enum)\\s+" + esc(ident) + "\\b");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if (t.indexOf("." + ident) >= 0 || t.indexOf("->" + ident) >= 0) continue;  // 成员访问
    if (/^\s*(\/\/|\*|\/\*)/.test(t)) continue;                                 // 注释
    const isCall = callRe.test(t), isType = typeRe.test(t);
    if (!isCall && !isType) continue;
    if (/^\s*#\s*define\b/.test(t)) {                                          // 宏
      let e = i; while (e < lines.length - 1 && /\\\s*$/.test(lines[e].text)) e++;
      return { start: i, end: e };
    }
    if (isCall && /;\s*$/.test(t)) continue;                                    // 声明/调用
    const end = braceMatch(lines, i);
    if (end >= i) return { start: i, end: end };
  }
  return null;
}

/* ---------- 解析 ident 页的候选文件（按出现顺序、去重） ---------- */
function resolveCandidates(html) {
  const out = [], seen = {};
  const re = /\/source\/([^#"'?]+?)#L(\d+)/g;
  let m;
  while ((m = re.exec(html))) {
    const f = m[1];
    if (seen[f]) continue; seen[f] = 1;
    out.push({ file: f, line: parseInt(m[2], 10) });
    if (out.length >= 6) break;
  }
  return out;
}

/* ---------- 取源码行（带缓存） ---------- */
async function getSource(tag, file) {
  const key = tag + "|" + file;
  const hit = srcCache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.lines;
  const html = await fetchText("https://" + BOOTLIN + "/linux/" + tag + "/source/" + file);
  const lines = parseLines(html);
  srcCache.set(key, { t: Date.now(), lines: lines });
  if (srcCache.size > 120) srcCache.delete(srcCache.keys().next().value);
  return lines;
}

/* ---------- 主逻辑 ---------- */
async function getCode(ver, ident, fileHint) {
  const tag = /^v/.test(ver) ? ver : "v" + ver;
  const key = tag + "|" + ident + "|" + (fileHint || "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.body;

  const candidates = [];
  if (fileHint) candidates.push({ file: fileHint, line: 0 });
  try { resolveCandidates(await fetchText(identUrl(tag, ident))).forEach((c) => candidates.push(c)); } catch (e) {}

  const tried = {};
  for (const c of candidates) {
    if (!c.file || tried[c.file]) continue;
    tried[c.file] = 1;
    let lines;
    try { lines = await getSource(tag, c.file); } catch (e) { continue; }
    const def = findDefinition(lines, ident);
    if (def) {
      const body = {
        ok: true, ver: tag, ident: ident, file: c.file,
        start: lines[def.start].n, end: lines[def.end].n,
        code: lines.slice(def.start, def.end + 1).map((l) => l.text).join("\n"),
        url: sourceUrl(tag, c.file, lines[def.start].n)
      };
      cache.set(key, { t: Date.now(), body: body });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return body;
    }
  }
  return { ok: false, error: "未在 Linux " + tag + " 中找到 " + ident + " 的定义（可能是版本差异或拼接函数名）", url: identUrl(tag, ident) };
}

const identUrl = (tag, ident) => "https://" + BOOTLIN + "/linux/" + tag + "/ident/" + encodeURIComponent(ident);
const sourceUrl = (tag, file, line) => "https://" + BOOTLIN + "/linux/" + tag + "/source/" + file + (line ? "#L" + line : "");

/* ---------- HTTP 服务 ---------- */
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, "http://" + HOST); } catch (e) { return send(res, 400, { ok: false, error: "bad url" }); }
  if (u.pathname === "/nvme-io-path/api/health") return send(res, 200, { ok: true });
  if (u.pathname === "/nvme-io-path/api/code") {
    const ver = (u.searchParams.get("ver") || "6.8").trim();
    const ident = (u.searchParams.get("ident") || "").trim();
    const file = (u.searchParams.get("file") || "").trim() || null;
    const tag = /^v/.test(ver) ? ver : "v" + ver;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) return send(res, 400, { ok: false, error: "非法标识符", url: identUrl(tag, ident) });
    let body;
    try { body = await getCode(ver, ident, file); }
    catch (e) { body = { ok: false, error: String((e && e.message) || e), url: identUrl(tag, ident) }; }
    return send(res, 200, body);
  }
  send(res, 404, { ok: false, error: "not found" });
}).listen(PORT, HOST, () => console.log("[nvme-io-path] bootlin proxy on http://" + HOST + ":" + PORT));
