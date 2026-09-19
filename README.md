# NVMe IO 链路互动教学平台

> **作者：罗毅**
> 一个把「应用程序 → Linux 内核 → NVMe 驱动 → SQ/CQ」完整 IO 链路**可视化、可点击、可对照内核版本**的互动教学平台。

在线演示（本机 nginx 部署）：`https://<your-domain>/nvme-io-path/`

---

## ✨ 功能特性

- **2×2 仪表盘布局**
  - 左上 · **Shell 模拟**：输入 `insmod nvme` / `read` / `write` / `io_uring` 等命令驱动教学
  - 右上 · **功能说明 & 关键代码逻辑**：层级、函数、源码位置、简化结构体、协议字段、代码逻辑、版本差异
  - 左下 · **系统框图 & 链路分层**：模块框图（当前模块高亮）+ 可点击链路节点
  - 右下 · **各层核心代码操作**：按层列出核心函数与源码文件，点击即查
- **四个场景**：驱动加载/初始化、应用读 IO、应用写 IO、io_uring 异步 IO
- **五档内核版本**：Linux 4.19 / 5.4 / 5.15 / 6.1 / 6.8（函数名、路径、page↔folio 等差异自动切换）
- **每步四件套**：系统模块框图 + 简化关键结构体 +（协议步骤的）字段表/字节布局 + 关键代码逻辑
- **点击函数/结构体 → 弹出 Bootlin 源码**：按内核版本从 `elixir.bootlin.com` 检索出完整定义（本地小代理解析，带缓存）

## 📁 目录结构

```
nvme-io-path/
├── public/                 # 静态站点（纯 HTML/CSS/JS，无第三方依赖）
│   ├── index.html
│   ├── app.js              # 交互逻辑
│   ├── data.js             # 场景 / 步骤 / 分层数据
│   ├── kb.js               # 结构体库 / 代码逻辑 / 协议字段 / 字节布局
│   └── styles.css
├── app/
│   └── server.js           # 可选后端：Bootlin 源码代理（Node 内置模块，零依赖）
├── nginx/
│   └── location.conf       # nginx 子路径部署配置
├── docs/
│   └── nvme-io-path.md     # 完整链路技术文档（含 SPEC 1.2→2.4 演进）
└── README.md
```

## 🚀 本地运行

### 1) 静态站点
把 `public/` 作为站点根放在 `/nvme-io-path/` 子路径下即可（站点内资源路径均为 `/nvme-io-path/...`）。

快速预览（任选）：
```bash
# 用自带 nginx 配置（推荐，配合下面的代理）
sudo cp nginx/location.conf /etc/nginx/conf.d/snippets/nvme-io-path.conf   # 或 symlink
sudo nginx -t && sudo systemctl reload nginx
```

### 2) Bootlin 源码代理（可选，点函数看源码需要）
`elixir.bootlin.com` 禁用了 iframe 且无 CORS，因此用一个零依赖的 Node 服务做服务端拉取：

```bash
node app/server.js          # 监听 127.0.0.1:3132
```

nginx 将 `/nvme-io-path/api/` 反代到该端口（见 `nginx/location.conf`）。

常驻可用 systemd：
```ini
# /etc/systemd/system/nvme-io-path.service
[Unit]
Description=NVMe IO teaching - Bootlin source proxy
After=network-online.target
[Service]
ExecStart=/usr/bin/node /path/to/nvme-io-path/app/server.js
Restart=always
User=<you>
[Install]
WantedBy=multi-user.target
```

## 🔧 技术要点

- **Bootlin 解析**：`ident 页 → 候选文件 → 源码页解析 <span id="codeline-N"> → 花括号配对定位真实定义体`（自动跳过头文件声明/调用点），带内存缓存
- **版本差异建模**：`func`/`vnote` 按内核版本取值（如 `submit_bio_noacct`(5.9+) vs `generic_make_request`、`filemap_read`(5.15+) vs `generic_file_read_iter`）
- **纯前端渲染**：框图用内联 SVG 动态生成，与当前模块联动高亮

## 📜 许可

MIT License © 罗毅
