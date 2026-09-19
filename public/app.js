/* NVMe IO 链路互动教学 —— 应用逻辑（点击跳转版，无播放菜单）
 * 导航方式：点击左下节点 / 框图模块 / 右下函数、键盘 ← →、Shell 命令。
 */
(function () {
  const D = window.APP_DATA;
  const $ = (id) => document.getElementById(id);

  const state = { scenarioKey: "read", kernel: "6.8", step: -1 };

  let nodeEls = [];        // 按步骤顺序存节点 DOM（左下）
  let layerGroupEls = {};  // layer -> 节点分组元素

  /* ---------- helper ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function hexA(hex, a) {
    const h = hex.replace("#", "");
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
  }
  function extractIdent(s) {
    if (!s) return "";
    const seg = String(s).split("→")[0];
    const m = /[A-Za-z_][A-Za-z0-9_]*/.exec(seg);
    return m ? m[0] : "";
  }
  function stepFile(s) {
    const f = s && s.file ? String(s.file) : "";
    return f.indexOf("/") >= 0 ? f : "";
  }
  function funcFor(step, ver) {
    if (typeof step.func === "string") return step.func;
    if (step.func && typeof step.func === "object")
      return step.func[ver] || step.func["*"] || Object.values(step.func)[0] || "";
    return "";
  }
  function noteFor(step, ver) {
    if (!step.vnote) return "";
    if (typeof step.vnote === "string") return step.vnote;
    return step.vnote[ver] || step.vnote["*"] || "";
  }
  function scenario() { return D.scenarios[state.scenarioKey]; }

  /* ---------- Bootlin 源码弹窗 ---------- */
  function wireCodeLinks(container) {
    container.querySelectorAll(".fname[data-ident]").forEach((el) => {
      const id = el.getAttribute("data-ident");
      if (!id) return;
      el.classList.add("clic");
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openCodeModal(id, state.kernel, el.getAttribute("data-file") || "");
      });
    });
  }
  function openCodeModal(ident, ver, file) {
    const modal = $("codeModal");
    if (!modal) return;
    $("cmIdent").textContent = ident + "( )";
    $("cmMeta").textContent = "Linux " + ver + (file ? " · " + file : "");
    $("cmBody").innerHTML = '<div class="dim cm-loading">⏳ 正在从 Bootlin 获取源码…</div>';
    $("cmBody").dataset.code = "";
    $("cmLink").href = "https://elixir.bootlin.com/linux/v" + ver + "/ident/" + encodeURIComponent(ident);
    modal.hidden = false;
    const url = "/nvme-io-path/api/code?ver=" + encodeURIComponent(ver) + "&ident=" + encodeURIComponent(ident) + (file ? "&file=" + encodeURIComponent(file) : "");
    fetch(url).then((r) => r.json()).then((j) => {
      if (j.ok) {
        $("cmMeta").textContent = "Linux " + ver + " · " + j.file + " : L" + j.start + "-" + j.end;
        $("cmBody").innerHTML = '<pre class="codeview"><code>' + esc(j.code) + "</code></pre>";
        $("cmBody").dataset.code = j.code;
        if (j.url) $("cmLink").href = j.url;
      } else {
        $("cmBody").innerHTML = '<div class="dim">' + esc(j.error || "未找到定义") + "</div>";
        if (j.url) $("cmLink").href = j.url;
      }
    }).catch((e) => { $("cmBody").innerHTML = '<div class="dim">获取失败：' + esc(String(e)) + "</div>"; });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    const ksel = $("kernelSelect");
    D.KERNELS.forEach((k) => {
      const o = document.createElement("option");
      o.value = k; o.textContent = "Linux " + k;
      if (k === state.kernel) o.selected = true;
      ksel.appendChild(o);
    });
    ksel.addEventListener("change", () => {
      state.kernel = ksel.value;
      termPrint("# 切换内核版本 → Linux " + state.kernel, "dim");
      refresh();
    });

    // 左下框图：点击模块跳转
    $("diagramBox").addEventListener("click", (e) => {
      const g = e.target.closest("[data-layer]");
      if (!g) return;
      jumpToLayer(g.getAttribute("data-layer"));
    });

    // 键盘 ← / → 步进
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight") stepForward();
      if (e.key === "ArrowLeft") stepBack();
    });

    // 弹窗关闭
    const closeModal = () => { $("codeModal").hidden = true; };
    $("cmClose").addEventListener("click", closeModal);
    $("codeModal").addEventListener("click", (e) => { if (e.target.id === "codeModal") closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
    $("cmCopy").addEventListener("click", () => {
      const c = $("cmBody").dataset.code || "";
      if (c && navigator.clipboard) navigator.clipboard.writeText(c).then(() => { $("cmCopy").textContent = "已复制 ✓"; setTimeout(() => ($("cmCopy").textContent = "复制代码"), 1200); });
    });

    // 终端
    const input = $("termInput");
    let termHistory = [], histIdx = 0;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = input.value.trim(); input.value = "";
        if (v) { termPrint("$ " + v, "echo"); handleCommand(v); }
      } else if (e.key === "ArrowUp") {
        if (termHistory.length) { histIdx = Math.max(0, histIdx - 1); input.value = termHistory[histIdx]; }
      } else if (e.key === "ArrowDown") {
        histIdx = Math.min(termHistory.length, histIdx + 1);
        input.value = termHistory[histIdx] || "";
      }
    });
    app._pushHistory = (v) => { termHistory.push(v); histIdx = termHistory.length; };

    renderPath();
    termPrint("NVMe IO 链路互动教学平台 —— 输入 help 查看命令。", "ok");
    termPrint("场景命令：insmod nvme（初始化） / read / write / io_uring", "dim");
    termPrint("跳转：点左下节点或框图模块、点右下函数看源码、← / → 步进。", "dim");
  }

  /* ---------- 左下：链路节点 ---------- */
  function renderPath() {
    const sc = scenario();
    const wrap = $("pathWrap");
    wrap.innerHTML = "";
    nodeEls = []; layerGroupEls = {};
    const used = sc.order.filter((L) => sc.steps.some((s) => s.layer === L));

    used.forEach((L) => {
      const meta = D.LAYERS[L] || { name: L, color: "#94a3b8", icon: "•" };
      const g = document.createElement("div");
      g.className = "layer-group";
      g.style.setProperty("--lc", meta.color);
      const head = document.createElement("div");
      head.className = "layer-head";
      head.innerHTML = '<span class="layer-ico">' + meta.icon + '</span><span class="layer-name">' + esc(meta.name) + "</span>";
      g.appendChild(head);
      const nodes = document.createElement("div");
      nodes.className = "layer-nodes";
      sc.steps.forEach((s, gi) => {
        if (s.layer !== L) return;
        const el = document.createElement("button");
        el.className = "node";
        el.dataset.idx = gi;
        el.innerHTML = '<span class="node-dot"></span><span class="node-title">' + esc(s.title) + "</span>";
        el.addEventListener("click", () => selectStep(gi));
        nodes.appendChild(el);
        nodeEls[gi] = el;
      });
      g.appendChild(nodes);
      wrap.appendChild(g);
      layerGroupEls[L] = g;
    });

    state.step = -1;
    refresh();
  }

  function jumpToLayer(L) {
    const sc = scenario();
    const i = sc.steps.findIndex((s) => s.layer === L);
    if (i >= 0) selectStep(i);
  }

  /* ---------- 左下：系统模块框图（可点击） ---------- */
  function renderDiagram(sc, activeLayer) {
    const L = D.LAYERS, AL = D.ARROW_LABELS || {};
    const order = sc.order.filter((lay) => sc.steps.some((s) => s.layer === lay));
    const boxH = 20, gap = 14, pad = 4, W = 340, x = 10, w = W - 20, cx = W / 2 + 38;
    const H = pad * 2 + order.length * boxH + (order.length - 1) * gap;
    let svg = '<svg class="diagram" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">';
    svg += '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">' +
      '<path d="M0,0 L6,3 L0,6 Z" fill="#5b6b86"/></marker>' +
      '<filter id="glow"><feGaussianBlur stdDeviation="2.6" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
    order.forEach((lay, i) => {
      const meta = L[lay] || { name: lay, color: "#94a3b8", icon: "•" };
      const y = pad + i * (boxH + gap);
      const active = lay === activeLayer;
      svg += '<g class="dg" data-layer="' + lay + '">' +
        '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + boxH + '" rx="6" ' +
        'fill="' + (active ? hexA(meta.color, 0.16) : "#131c30") + '" stroke="' + (active ? meta.color : "#24304a") +
        '" stroke-width="' + (active ? 2 : 1) + '"' + (active ? ' filter="url(#glow)"' : "") + "/>" +
        '<text x="' + (x + 9) + '" y="' + (y + boxH / 2 + 3.5) + '" font-size="11" fill="' +
        (active ? meta.color : "#cbd5e1") + '">' + esc(meta.icon + " " + meta.name) + "</text></g>";
      if (i < order.length - 1) {
        const y2 = y + boxH, y3 = y + boxH + gap;
        const label = AL[order[i + 1]] || "";
        const hot = active || order[i + 1] === activeLayer;
        svg += '<line x1="' + cx + '" y1="' + (y2 + 3) + '" x2="' + cx + '" y2="' + (y3 - 4) +
          '" stroke="' + (hot ? meta.color : "#33415c") + '" stroke-width="1.6" marker-end="url(#arrow)"/>';
        if (label)
          svg += '<text x="' + (cx + 6) + '" y="' + ((y2 + y3) / 2 + 3) + '" font-size="9.5" fill="' +
            (hot ? "#9fb3d1" : "#5b6b86") + '">' + esc(label) + "</text>";
      }
    });
    return svg + "</svg>";
  }
  function updateDiagram() {
    const sc = scenario();
    const active = state.step >= 0 ? sc.steps[state.step].layer : null;
    $("diagramBox").innerHTML = renderDiagram(sc, active);
  }

  /* ---------- 右上：功能说明 & 关键代码逻辑 ---------- */
  function renderFields(list) {
    let h = '<table class="ftable"><thead><tr><th>字段</th><th>位置</th><th>说明</th></tr></thead><tbody>';
    list.forEach((f) => { h += '<tr><td class="fn">' + esc(f.n) + '</td><td class="fb">' + esc(f.b || "") + "</td><td>" + esc(f.d || "") + "</td></tr>"; });
    return h + "</tbody></table>";
  }
  function renderLayout(segs) {
    const pal = ["#38bdf8", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c", "#4ade80", "#e879f9", "#60a5fa", "#facc15", "#2dd4bf"];
    let h = '<div class="bytestrip">';
    segs.forEach((s, i) => {
      const c = pal[i % pal.length];
      h += '<div class="bseg" style="flex-grow:' + s.w + ";border-color:" + c + ";color:" + c + '" title="' + esc(s.f) + " (" + s.w + 'B)">' + esc(s.f) + '<span class="bw">' + s.w + "B</span></div>";
    });
    return h + "</div>";
  }

  function renderDetail() {
    const sc = scenario();
    const box = $("detail");
    const s = state.step >= 0 ? sc.steps[state.step] : null;
    if (!s) {
      box.innerHTML = '<div class="d-empty"><h3>未选择步骤</h3><p>' + esc(sc.blurb) + "</p>" +
        '<p class="dim">点击左下节点 / 框图模块跳转；点右下函数查看 Bootlin 源码。</p>' +
        '<div class="d-hint">场景：<b>' + esc(sc.name) + "</b></div></div>";
      return;
    }
    const meta = D.LAYERS[s.layer] || { name: s.layer, color: "#94a3b8", icon: "•" };
    const func = funcFor(s, state.kernel);
    const note = noteFor(s, state.kernel);
    const fid = extractIdent(func);
    let html = "";
    html += '<div class="d-layer" style="--lc:' + meta.color + '">' + meta.icon + " " + esc(meta.name) + "</div>";
    html += "<h3>" + esc(s.title) + "</h3>";
    html += '<p class="d-desc">' + esc(s.desc) + "</p>";
    html += '<div class="d-row"><span class="d-k">函数 / 动作</span>' +
      (fid ? '<code class="fname" data-ident="' + esc(fid) + '" data-file="' + esc(stepFile(s)) + '" title="点击查看 Bootlin 源码">' + esc(func) + "</code>"
           : '<code>' + esc(func) + "</code>") + "</div>";
    if (s.file) html += '<div class="d-row"><span class="d-k">源码位置</span><code>' + esc(s.file) + "</code></div>";

    if (s.structs && s.structs.length) {
      html += '<div class="d-sec-t">简化关键结构体</div>';
      s.structs.forEach((n) => {
        const def = (D.STRUCTS && D.STRUCTS[n]) || null;
        html += '<div class="d-struct"><div class="d-struct-name fname" data-ident="' + esc(n) + '" data-file="" title="点击查看 Bootlin 源码">' + esc(n) + "</div>" +
          (def ? '<pre class="d-code"><code>' + esc(def) + "</code></pre>" : '<div class="dim">（暂无简化定义）</div>');
        if (D.LAYOUT && D.LAYOUT[n]) html += renderLayout(D.LAYOUT[n]);
        if (D.FIELDS && D.FIELDS[n]) html += renderFields(D.FIELDS[n]);
        html += "</div>";
      });
    }
    if (D.PROTO && D.PROTO[s.title]) {
      html += '<div class="d-sec-t">协议寄存器 / 命令字段</div>';
      html += renderFields(D.PROTO[s.title]);
    }
    const logic = (D.LOGIC && D.LOGIC[s.title]) || s.code;
    if (logic) {
      html += '<div class="d-sec-t">关键代码逻辑</div>';
      html += '<pre class="d-code logic"><code>' + esc(logic) + "</code></pre>";
    }
    if (note) html += '<div class="d-note"><b>版本差异 (Linux ' + esc(state.kernel) + ")</b><br>" + esc(note) + "</div>";
    html += '<div class="d-nav">' +
      '<button id="dPrev"' + (state.step === 0 ? " disabled" : "") + ">← 上一步</button>" +
      '<span class="d-pos">' + (state.step + 1) + " / " + sc.steps.length + "</span>" +
      '<button id="dNext"' + (state.step === sc.steps.length - 1 ? " disabled" : "") + ">下一步 →</button></div>";
    box.innerHTML = html;
    wireCodeLinks(box);
    const p = $("dPrev"), n = $("dNext");
    if (p) p.addEventListener("click", stepBack);
    if (n) n.addEventListener("click", stepForward);
  }

  /* ---------- 右下：各层核心代码操作 ---------- */
  function renderCodeMap() {
    const sc = scenario();
    const box = $("codemap");
    let html = "";
    sc.order.forEach((L) => {
      const entries = sc.steps.map((s, i) => ({ s: s, i: i })).filter((x) => x.s.layer === L);
      if (!entries.length) return;
      const meta = D.LAYERS[L] || { name: L, color: "#94a3b8", icon: "•" };
      html += '<div class="cm-layer" style="--lc:' + meta.color + '">';
      html += '<div class="cm-h">' + meta.icon + " " + esc(meta.name) + "</div>";
      entries.forEach((x) => {
        const active = x.i === state.step;
        const fid = extractIdent(funcFor(x.s, state.kernel));
        html += '<div class="cm-item' + (active ? " active" : "") + '" data-idx="' + x.i + '">' +
          '<code class="cm-func' + (fid ? " fname" : "") + '" data-ident="' + esc(fid) + '" data-file="' + esc(stepFile(x.s)) + '"' + (fid ? ' title="点击查看 Bootlin 源码"' : "") + ">" + esc(funcFor(x.s, state.kernel)) + "</code>" +
          (x.s.file ? '<span class="cm-file">' + esc(x.s.file) + "</span>" : "") + "</div>";
      });
      html += "</div>";
    });
    box.innerHTML = html;
    wireCodeLinks(box);
    box.querySelectorAll(".cm-item").forEach((el) =>
      el.addEventListener("click", () => selectStep(parseInt(el.dataset.idx, 10))));
  }

  /* ---------- 统一刷新 ---------- */
  function refresh() {
    updateDiagram();
    renderDetail();
    renderCodeMap();
    updateProgress();
  }

  function selectStep(i) {
    const sc = scenario();
    if (i < -1) i = -1;
    if (i >= sc.steps.length) i = sc.steps.length - 1;
    state.step = i;
    nodeEls.forEach((el, idx) => {
      if (!el) return;
      el.classList.toggle("active", idx === i);
      el.classList.toggle("done", idx < i);
    });
    Object.values(layerGroupEls).forEach((g) => g.classList.remove("active-layer"));
    if (i >= 0) {
      const cur = sc.steps[i];
      if (layerGroupEls[cur.layer]) layerGroupEls[cur.layer].classList.add("active-layer");
      if (nodeEls[i]) nodeEls[i].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    refresh();
  }
  function stepForward() { const max = scenario().steps.length - 1; if (state.step < max) selectStep(state.step + 1); }
  function stepBack() { if (state.step > 0) selectStep(state.step - 1); }

  function updateProgress() {
    const sc = scenario();
    const total = sc.steps.length;
    const done = state.step + 1;
    const pct = total ? Math.round((Math.max(done, 0) / total) * 100) : 0;
    $("progFill").style.width = pct + "%";
    $("progText").textContent = (state.step >= 0 ? "步骤 " + done + " / " + total : "0 / " + total) + "  ·  Linux " + state.kernel;
  }

  /* ---------- 场景切换（Shell 驱动） ---------- */
  function runScenario(key) {
    if (!D.scenarios[key]) return;
    state.scenarioKey = key;
    termPrint("# 加载场景：" + D.scenarios[key].name + "  (" + D.scenarios[key].steps.length + " 步)", "ok");
    renderPath();
  }

  /* ---------- 终端 ---------- */
  function termPrint(text, cls) {
    const out = $("termOut");
    const line = document.createElement("div");
    line.className = "tl " + (cls || "");
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }
  function handleCommand(raw) {
    const v = raw.trim();
    if (app._pushHistory) app._pushHistory(v);
    const parts = v.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    if (cmd === "help" || cmd === "?") {
      termPrint("可用命令：", "ok");
      termPrint("  insmod nvme | modprobe nvme      驱动加载 / 初始化场景", "");
      termPrint("  read | write | io_uring           读 / 写 / 异步 IO 场景", "");
      termPrint("  kernel <4.19|5.4|5.15|6.1|6.8>    切换内核版本", "");
      termPrint("  next | step | reset               链路步进 / 重置", "");
      termPrint("  clear                             清屏", "");
      return;
    }
    if (cmd === "clear") { $("termOut").innerHTML = ""; return; }
    if (cmd === "versions" || cmd === "kernel") {
      if (cmd === "kernel" && arg) {
        if (D.KERNELS.indexOf(arg) >= 0) {
          state.kernel = arg; $("kernelSelect").value = arg; refresh();
          termPrint("内核版本 → Linux " + arg, "ok");
        } else termPrint("未知版本：" + arg + "（可用 " + D.KERNELS.join(" / ") + "）", "warn");
      } else termPrint("可用内核版本：" + D.KERNELS.join(" / "), "");
      return;
    }
    if (cmd === "next" || cmd === "step" || cmd === "n") { stepForward(); return; }
    if (cmd === "reset") { selectStep(-1); termPrint("已重置。", "dim"); return; }

    if (cmd === "insmod" || cmd === "modprobe" || (cmd === "nvme" && (arg === "init" || arg === "")) || cmd === "init") { runScenario("init"); return; }
    if (cmd === "read" || cmd === "cat" || cmd === "dd" || cmd === "pread") { runScenario("read"); return; }
    if (cmd === "write" || cmd === "echo") { runScenario("write"); return; }
    if (cmd === "io_uring" || cmd === "ring" || cmd === "aio") { runScenario("iouring"); return; }
    if (cmd === "ls" && arg.indexOf("/dev/nvme") === 0) {
      termPrint("brw-rw---- 1 root disk 259, 0 ... /dev/nvme0n1   (block)", "");
      termPrint("crw------- 1 root root 242, 0 ... /dev/nvme0       (char, ioctl)", "");
      return;
    }
    termPrint("未识别的命令：'" + v + "'。输入 help 查看用法。", "warn");
  }

  /* ---------- 启动 ---------- */
  const app = { _pushHistory: null };
  window.addEventListener("DOMContentLoaded", init);
  window.__nvmeApp = app;
})();
