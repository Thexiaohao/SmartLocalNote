# SmartLocalNote — 轻量化 Local-First 苹果风双端工作台工程规范 (SPEC.md)

> **致执行 Agent：** 本文档为本项目的最高技术规范。在编写任何代码前，必须先牢记第 0 章的【核心北极星目标】，所有技术架构、UI 交互与功能实现都必须服务于这条核心用户闭环，绝不能本末倒置或擅自引入重型依赖。

---

## 0. 核心北极星目标与用户痛点闭环（最高优先级，严禁偏离）

本软件要解决用户的**真实学习与办公痛点**，必须完整、丝滑地跑通以下 **4 大核心用户目标 + 5 大轻量级创新微闭环**：

### 0.1 四大核心必达目标
1. **随时随地记录，电脑与手机双端通用（且极度轻量流畅）**：
   - 用户在电脑前或用手机时，都能随时记录学习笔记和“想做的事情”（支持通过导入/剪贴板/语音/网页端零门槛汇入本地）。
   - 软件必须像苹果（macOS / iOS）原生应用一样高级、美观（椭圆胶囊模块 + 丝滑阻尼动效），且**极度轻量、不吃内存、打开即用**。
2. **内置 AI 大模型：自动总结 + 提炼“需要做什么” + 允许自动提醒**：
   - 用户随手记下一段杂乱的想法或学习内容后，内置 AI 自动总结核心内容、明确提炼出**“具体需要做什么（待办清单）”**，并识别时间，允许用户一键开启**自动定时提醒**，到点主动弹窗督促执行。
3. **办公软件直达链接（笔记内一键自动打开应用）**：
   - 只要用户在笔记里记录了“记得打开 XX 软件 / XX 程序”，用户**不需要切回桌面或文件夹手动找图标**，系统自动在笔记本里生成可点击的直达胶囊入口，点击即瞬间拉起电脑上的对应本地软件（支持多软件一键联启）。
4. **电脑已有文件（PDF / Excel / MD / TXT）直接预览，点进去就能写**：
   - 兼容用户电脑硬盘里已有的 `PDF`、`Excel (.xlsx)`、`Markdown (.md)`、`纯文本 (.txt)`，无需搬家或转换私有格式，在软件里直接预览，**点进去就能直接编辑写入并原位保存**。
   - 同时右侧配备**AI 副驾驶与本地工具台**（默认 AI 总结，支持开启 Web 搜索做基础问答，允许把右侧消息直接一键添加到笔记目录、填入本地表格、做知识树分类管理）。

### 0.2 五大轻量级差异化创新（零重依赖融入）
1. **一键“捕获当前桌面现场”生成工作区**：无需手动翻找 `.exe` 路径，点击即可扫描当前桌面已打开的可见窗口，勾选后一键固化为场景工作区。
2. **跨格式“原子级”精准锚点**：除 PDF 页码锚点 `[[file.pdf#page=12]]` 外，独家支持 **Excel 单元格级锚点 `[[file.xlsx#Sheet1!C4]]`**，点击笔记中的蓝色胶囊瞬间定位至指定 Sheet 的对应单元格并触发弹性高亮脉冲。
3. **灵动岛“剪贴板智能嗅探”**：从微信/手机复制待办或资料切回本软件时，顶部灵动岛无感展开 4 秒提示一键 AI 提取或存为笔记，不点自动收起，零后台轮询损耗。
4. **零向量库“跨格式勾选联合问答”**：左侧文件树支持随手勾选多份不同格式文件（如 PDF + Excel + MD），右侧 AI 按需抽取文本联合分析，无需重型向量库即可实现跨文档本地 RAG。
5. **灵动岛专注闭环（计时 → 自动催填进度表）**：点击任意待办/工作区进入专注态，灵动岛化为呼吸感倒计时胶囊；计时结束自动展开微型输入框，回车即可将本次学习成果直接写回本地 Excel 进度表。

> **全流程黄金体验闭环（验收基准）：**
> 手机/电脑随时记下或复制一段内容 → 切回软件灵动岛无感嗅探导入 → 右侧 AI 自动总结出“要做什么”并设好自动提醒 → 一键“捕获/拉起”本地办公软件进入专注倒计时 → 笔记内一键精准跳至本地 PDF 指定页或 Excel 指定单元格修改写入 → 专注结束在灵动岛回车自动沉淀进度至本地 Excel。

---

## 1. 架构与性能红线（严禁违反）

- **性能指标**：空闲内存占用 < 80MB，冷启动 < 1 秒，UI 动效稳定 60fps。
- **反臃肿原则**：
  - 严禁使用 Electron、React、Vue、Angular、Next.js、Webpack、Vite、Tailwind CLI 构建链。
  - 前端必须采用 **纯原生 HTML5 + CSS3（Design Tokens）+ 原生 ES6 Modules (`<script type="module">`)**，零 `node_modules`，零编译打包。
  - 严禁引入重型编辑器（Vditor、Milkdown、Univer、Luckysheet、完整版 PDF.js 套件）以及任何重型向量数据库（Chroma、FAISS、LangChain 等）。
- **防屎山铁律**：
  1. **薄路由、厚核心**：`api/` 下每个路由函数不超过 15 行，仅做参数校验与调用 `core/`，严禁写业务逻辑。
  2. **统一安全 IO 网关**：所有写磁盘操作必须经过 `core/safe_io.py`，严禁在业务模块中直接 `open(..., 'w')` 覆写用户原文件。
  3. **事件总线解耦**：前端左/中/右三栏严禁互相直接操作 DOM，全部通过 `static/js/store.js` 发布/订阅事件通信。
  4. **严格懒加载**：启动时只加载 KB 级 JSON 索引，绝不遍历读取硬盘文档内容；仅在用户打开具体文件或勾选参与联合问答时按需解析。
- **双端运行模式**：
  - FastAPI 默认绑定 `0.0.0.0:8765`，启动时在后台线程运行服务，主线程用 `pywebview` 打开桌面原生窗体（复用系统 WebView2）。
  - 同时支持命令行参数 `--web-only`（仅启动服务，便于浏览器调试与手机局域网/PWA 访问），启动时在终端打印本机局域网访问地址（如 `http://192.168.x.x:8765`）。

---

## 2. 完整项目目录结构

```text
SmartLocalNote/
├── SPEC.md                     # 本工程规范文档
├── main.py                     # 唯一入口：启动 uvicorn 后台线程 + pywebview 原生窗体（支持 --web-only）
├── config.py                   # 配置读写与默认参数（端口、API 设置、白名单、隐私锁列表）
├── requirements.txt            # 严格受控的极简 Python 依赖清单
├── data/                       # 运行时轻量本地索引（首次启动自动创建）
│   ├── config.json             # API Key/BaseURL/模型名/白名单目录/隐私锁路径
│   ├── files.json              # 已导入的本地文件与挂载目录索引
│   ├── apps.json               # 本地办公软件映射与工作区联启组合
│   ├── knowledge_tree.json     # 虚拟知识树节点与文件绑定关系
│   ├── tasks.json              # 待办事项与定时提醒记录
│   └── .snapshots/             # safe_io 自动生成的写前历史快照目录
├── core/                       # 【纯核心业务层】不依赖 FastAPI/HTTP 对象
│   ├── __init__.py
│   ├── safe_io.py              # 安全读写网关（路径白名单、防穿越、写前快照、原子写、回滚、隐私锁）
│   ├── doc_engine.py           # MD/TXT 读写、PDF 流式读取/按页提字/PyMuPDF 批注写入、伴生笔记
│   ├── excel_engine.py         # Excel 分页读取、单元格增量修改、表单追加行、增删行列、导出 CSV、文本摘要抽取
│   ├── app_launcher.py         # .exe/.lnk 解析、捕获当前桌面运行窗口、单软件拉起、工作区一键联启
│   ├── tree_store.py           # 虚拟知识树 CRUD 与表格总览视图数据生成
│   ├── ai_service.py           # OpenAI 兼容 httpx 流式客户端、联网开关、多文件跨格式上下文组装、JSON 动作抽取、填表转换、隐私锁拦截
│   └── scheduler.py            # APScheduler 后台调度 + winotify Windows 原生通知 + SSE 事件推送
├── api/                        # 【薄接口层】只负责收参数、调 core/、返 JSON，绝不写业务逻辑
│   ├── __init__.py
│   ├── system_api.py           # 原生文件/文件夹选择器、配置、健康检查、SSE 事件流
│   ├── files_api.py            # 文件导入、目录树、文档读写、PDF 预览流、快照与回滚
│   ├── excel_api.py            # Excel 分页、单元格修改、追加行、结构编辑、导出
│   ├── tools_api.py            # 软件库、捕获当前桌面窗口、工作区联启、虚拟知识树、提醒任务 CRUD
│   └── ai_api.py               # AI 总结(JSON)、SSE 多文件跨格式联网问答、消息存笔记、消息转表格行
└── static/                     # 【原生前端层】零构建工具、双端自适应、PWA
    ├── index.html              # 语义化三栏骨架 + 灵动岛 + 移动端底部胶囊导航 + Spotlight/BottomSheet 容器
    ├── manifest.json           # PWA 配置（支持手机“添加到主屏幕”全屏运行）
    ├── css/
    │   ├── tokens.css          # 苹果风椭圆 Design Tokens（浅色/暗黑变量、圆角、毛玻璃、动效曲线）
    │   └── app.css             # 三栏悬浮岛、多态灵动岛胶囊、单元格高亮脉冲、Stacked Toast、三端断点
    ├── vendor/                 # 极简离线单文件第三方库（避免外网 CDN 断连）
    │   └── marked.min.js       # 仅 ~12KB 的 Markdown 解析器（本地化存放）
    └── js/
        ├── store.js            # 全局轻量状态中心 + EventBus + 灵动岛状态机（常规/嗅探/专注/提醒）+ Toast
        ├── icons.js            # 按需内联 Lucide 风格 1.5px 极细 SVG 图标字典
        ├── api_client.js       # 统一 fetch 封装与 SSE 流式解析器
        ├── left_tree.js        # 左侧：多源导入、带联合问答勾选框的文件树、软件直达、桌面现场捕获
        ├── center_view.js      # 中间：MD/TXT、分页 Excel（支持锚点定位脉冲与复制锚点）、PDF+伴生笔记+页码跳转
        ├── right_panel.js      # 右侧：三模式切换（AI总结 / 跨格式联网问答+一键入库 / 本地工具与知识树台）
        └── spotlight.js        # Ctrl+K 全局胶囊搜索、剪贴板 focus 智能嗅探、语音速记、专注倒计时与抽屉管理
```

---

## 3. 依赖白名单与严禁清单

### 3.1 Python 依赖白名单 (`requirements.txt`)
仅允许安装以下轻量化包：
- `fastapi` + `uvicorn[standard]`：轻量异步接口服务
- `pydantic`：严格接口模型校验
- `httpx`：异步 HTTP 与 AI SSE 流式请求（不装臃肿的官方 SDK）
- `openpyxl`：`.xlsx` 分页读取与增量写回
- `PyMuPDF`（导入名 `fitz`）：C 语言底层 PDF 按页文本抽取与批注写入
- `apscheduler`：轻量后台定时提醒调度
- `winotify`：Windows 原生右下角系统通知（非 Windows 或失败时静默降级为前端灵动岛+Toast提醒）
- `pywebview`：复用系统 WebView2 封装轻量桌面窗体（支持 `--web-only` 降级运行）

> **Windows 原生系统能力规范（零重依赖）**：
> - **`.lnk` 快捷方式解析**：直接使用标准库 `subprocess` 调用单行 PowerShell COM (`WScript.Shell`) 提取 `TargetPath` 与 `Arguments`；`.exe` 直接记录路径。
> - **捕获当前桌面现场窗口**：直接使用标准库 `subprocess` 调用 PowerShell `Get-Process | Where-Object {$_.MainWindowTitle -ne "" -and $_.Path} | Select-Object ProcessName, MainWindowTitle, Path | ConvertTo-Json`，严禁安装 `pywin32` / `psutil` 等重型扩展。
> - **本地文件完整路径选取**：PC 端通过 `/api/system/pick-path` 调用 `pywebview` 对话框或标准库 `tkinter.filedialog` 获取真实硬盘绝对路径；手机端访问时支持直接文本/剪贴板导入或上传文件到默认本地工作区目录。

### 3.2 前端依赖白名单
- `static/vendor/marked.min.js`（~12KB）：纯 Markdown 转 HTML（渲染输出前须做基础 XSS 过滤或转义 `<script>`）。
- 图标：全部在 `static/js/icons.js` 中按需内联 1.5px 线条 SVG（Lucide 风格），零外部图标字体请求。
- 动效：纯 CSS3 `transform` / `opacity` + 原生 JS 实现平滑过渡（严禁引入 jQuery、GSAP、Framer Motion 等重型动画库）。

---

## 4. `core/safe_io.py` 安全读写与防损坏规范

所有对本地磁盘文件的**读取校验**与**写入修改**必须经过 `safe_io.py`：

1. **目录白名单与路径穿越防护**：
   - `resolve_safe_path(path_str: str) -> Path`：强制 `Path(path_str).resolve()`。
   - 校验目标路径必须位于用户已显式导入的文件列表、已授权挂载目录白名单或项目 `data/` 目录内；拒绝任何 `..` 越权访问，违规抛出 `PermissionError`（API 返回 HTTP 403）。
2. **写前自动快照（Snapshot）**：
   - 每次执行修改前，调用 `create_snapshot(target_path: Path) -> Path`，将原文件复制到 `data/.snapshots/<md5_of_path>/<YYYYMMDD_HHMMSS_fff>.bak`。
   - 单个文件最多保留最近 15 份快照，超额自动清理最旧快照。
3. **原子写入（Atomic Write）**：
   - 文本/JSON/二进制写回时，先写入同目录下的临时文件 `.<filename>.tmp`，调用 `fsync` 落盘后再通过 `os.replace(tmp, target)` 原子替换，防止中途异常或断电损坏原文件。
4. **一键回滚**：
   - `list_snapshots(target_path)` 返回历史快照时间列表；`restore_snapshot(target_path, snapshot_id)` 先对当前文件做一次快照再恢复目标版本。
5. **隐私锁强拦截**：
   - `is_private(target_path)` 检查文件是否被标记为隐私锁；若为 `True`，`ai_service.py`（包括单文件总结与多文件跨格式联合问答）必须硬拦截，严禁将该文件内容发送至任何外部大模型 API，并明确提示用户哪份文件处于隐私锁定状态。

---

## 5. 本地轻量索引 Schema (`data/*.json`)

- **`data/config.json`**：
  ```json
  {
    "port": 8765,
    "theme": "light",
    "ai": {
      "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api_key": "",
      "model": "qwen-plus",
      "web_search_param": "enable_search"
    },
    "whitelist_dirs": [],
    "private_files": [],
    "default_notes_dir": "./data/notes",
    "default_progress_excel": ""
  }
  ```
- **`data/apps.json`**：
  ```json
  {
    "apps": [
      { "id": "app_1", "name": "WPS Office", "aliases": ["WPS", "文档"], "path": "C:/.../wps.exe", "args": "" }
    ],
    "workspaces": [
      { "id": "ws_1", "name": "高数复习模式", "app_ids": ["app_1"], "file_paths": ["D:/Study/高数笔记.pdf", "D:/Study/刷题表.xlsx"] }
    ]
  }
  ```
- **`data/knowledge_tree.json`**（物理文件不动，虚拟树映射）：
  ```json
  {
    "nodes": [
      {
        "id": "node_root_1",
        "name": "高等数学",
        "parent_id": null,
        "files": [
          { "path": "D:/Study/高数笔记.pdf", "status": "复习中", "updated_at": "2026-11-19T20:00:00" }
        ]
      }
    ]
  }
  ```

---

## 6. REST & SSE API 契约

所有 JSON 响应统一结构：`{ "ok": true, "data": ..., "message": "" }`（错误时返回对应 HTTP 状态码与 `{ "ok": false, "message": "可读中文提示" }`）。

### 6.1 系统与导入 (`api/system_api.py`)
| 方法 | 路径 | 请求参数 / Body | 说明 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/system/info` | 无 | 返回本机局域网 IP、端口、当前运行平台、AI 是否已配置 |
| `GET` / `PUT` | `/api/system/config` | `ConfigPayload` | 获取/更新 AI 配置、主题、白名单、默认笔记目录、默认进度表路径 |
| `POST` | `/api/system/pick-path` | `{"mode": "file"\|"folder"\|"app"}` | 调起桌面原生文件/目录/exe(.lnk) 选择对话框并返回真实路径 |
| `GET` | `/api/events` | 无（SSE 长连接） | 推送后台事件（如 `reminder:fired`、`snapshot:created`）以驱动前端灵动岛实时响应 |

### 6.2 多格式文档与快照 (`api/files_api.py`)
| 方法 | 路径 | 请求参数 / Body | 说明 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/files/list` | 无 | 返回已挂载的文件树与隐私锁标记 |
| `POST` | `/api/files/import` | `{"paths": [...], "is_dir": false}` | 导入本地文件或挂载整个目录（仅登记路径索引，不复制原文件） |
| `POST` | `/api/files/create-note` | `{"title": "...", "content": "...", "node_id": null}` | 在默认笔记目录新建 `.md` 文件并可选绑定至知识树节点 |
| `GET` | `/api/files/read` | `?path=...` | 读取 `.md`/`.txt` 原文，或返回 `.pdf` 元信息（总页数、伴生 `.md` 路径） |
| `PUT` | `/api/files/write` | `{"path": "...", "content": "..."}` | 经 `safe_io` 自动快照后原位原子覆写 `.md`/`.txt` |
| `GET` | `/api/files/pdf-stream` | `?path=...` | 以 `application/pdf` 流式输出供原生浏览器/WebView2 硬件渲染（前端拼 `#page=N` 跳页） |
| `POST` | `/api/files/pdf-annotate` | `{"path": "...", "page": 1, "note_text": "..."}` | 使用 `PyMuPDF` 写入 PDF 批注（经 `safe_io` 快照保护） |
| `POST` | `/api/files/privacy` | `{"path": "...", "private": true}` | 切换单文件隐私锁状态 |
| `GET` / `POST` | `/api/files/snapshots` | `?path=...` / `{"path": "...", "snapshot_id": "..."}` | GET 列出历史 `.bak` 快照；POST 执行一键回滚 |

### 6.3 Excel 轻量化原位引擎 (`api/excel_api.py`)
| 方法 | 路径 | 请求参数 / Body | 说明 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/excel/sheets` | `?path=...` | 返回所有 Sheet 名称、表头列与总行数 |
| `GET` | `/api/excel/rows` | `?path=...&sheet=...&page=1&page_size=100&q=&sort_col=&sort_dir=` | 开启 `read_only=True` 分页读取，支持关键词筛选与单列排序 |
| `PATCH` | `/api/excel/cells` | `{"path": "...", "sheet": "...", "changes": [{"row": 2, "col": 3, "value": "95%"}]}` | 经 `safe_io` 快照后增量修改指定单元格并原子回写原 `.xlsx` |
| `POST` | `/api/excel/append-rows` | `{"path": "...", "sheet": "...", "rows": [[...], [...]]}` | 右侧表单填表、AI 提取或灵动岛专注结束时一键追加多行 |
| `POST` | `/api/excel/structure` | `{"path": "...", "sheet": "...", "op": "add_col"\|"del_row"\|"del_col", "index": 1, "name": "备注"}` | 基础表格增列、删行、删列操作 |
| `GET` | `/api/excel/export-csv` | `?path=...&sheet=...` | 将当前 Sheet 导出为 UTF-8 BOM CSV 下载 |

### 6.4 软件直达、桌面捕获、知识树与提醒 (`api/tools_api.py`)
| 方法 | 路径 | 请求参数 / Body | 说明 |
| :--- | :--- | :--- | :--- |
| `GET` / `POST` / `DELETE` | `/api/apps` | `{"name": "...", "aliases": [...], "path": "..."}` | 管理本地软件映射表（自动解析 `.lnk`） |
| `GET` | `/api/apps/running-windows` | 无 | **【创新 1】** 捕获当前桌面正在运行的可见软件窗口（返回去重后的进程名、窗口标题、`.exe` 路径，自动过滤本软件自身与系统宿主进程） |
| `POST` | `/api/apps/launch` | `{"app_id": "..."}` 或 `{"workspace_id": "..."}` | 非阻塞拉起单个软件，或一键联启工作区内的所有软件与文件 |
| `GET` / `POST` / `DELETE` | `/api/workspaces` | `{"name": "...", "app_ids": [...], "file_paths": [...]}` | 管理场景工作区组合（支持由桌面现场捕获一键创建） |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/tree` | 节点 CRUD & 绑定/解绑文件路径 & 更新学习状态 | 管理虚拟知识树，提供树状与扁平表格两种视图数据 |
| `GET` / `POST` / `DELETE` | `/api/reminders` | `{"title": "...", "trigger_at": "ISO8601", "delay_seconds": 10, "app_ids": [...], "file_paths": [...]}` | 创建/取消定时提醒（支持 `delay_seconds` 快速演示测试）；到点弹出 `winotify` 并经 `/api/events` 推送前端 |

### 6.5 右侧三模式 AI 副驾驶 (`api/ai_api.py`)
| 方法 | 路径 | 请求参数 / Body | 说明 |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/ai/summarize` | `{"text": "...", "file_path": null}` | 强制返回结构化 JSON：`{summary, tags, todos, trigger_time, matched_app_ids, matched_files}`；未配 Key 时提供离线规则提取降级演示 |
| `POST` | `/api/ai/chat` | `{"messages": [...], "web_search": false, "context_paths": []}` | **【创新 4】** **SSE 流式输出**问答；支持传入多个勾选文件路径（`context_paths`，最多 5 份跨格式文件）按需抽取纯文本联合分析；`web_search=true` 透传原生联网参数；逐文件强校验隐私锁 |
| `POST` | `/api/ai/extract-table` | `{"text": "...", "headers": ["章节", "题数", "状态"]}` | 将右侧问答、粘贴文本或专注结语转化为匹配目标 Excel 表头的二维预览数组 `[[...]]`，供用户确认后写入 |
| `POST` | `/api/ai/classify` | `{"file_path": "...", "summary": "..."}` | 根据现有知识树节点列表，推荐最匹配的归类节点名称 |

---

## 7. 五大轻量级创新微闭环详细实现规范

### 7.1 一键“捕获当前桌面现场”生成工作区
- **后端 (`core/app_launcher.py`)**：通过 `subprocess.run` 调用 PowerShell 抓取所有含 `MainWindowTitle` 且有有效 `Path` 的前台 GUI 进程，过滤掉 `explorer`、`ApplicationFrameHost`、`TextInputHost` 及本应用自身，按可执行路径去重后返回 `[{process_name, title, path}]`（非 Windows 环境优雅返回空列表并提示手动添加）。
- **前端 (`left_tree.js` / `right_panel.js`)**：在工作区区域提供 `[📸 捕获当前现场]` 椭圆按钮；点击弹出勾选卡片，用户勾选所需正在运行的软件与当前已打开的文档、输入工作区名称（如“高数复习现场”），点击保存时自动将新软件补录进 `apps.json` 并生成工作区组合。

### 7.2 跨格式“原子级”精准锚点（PDF 页码 + Excel 单元格）
- **统一锚点语法**：
  - PDF 页码锚点：`[[文件名.pdf#page=12]]`
  - Excel 单元格锚点：`[[文件名.xlsx#Sheet1!C4]]`（支持省略 Sheet 名时默认首个 Sheet，如 `[[文件名.xlsx#C4]]`）
- **交互规范 (`center_view.js` & `right_panel.js`)**：
  - Markdown 预览区与 AI 回复气泡中的上述语法自动渲染为浅蓝苹果风椭圆胶囊（带对应格式小图标）。
  - 在 Excel 编辑区选中任意单元格时，工具栏提供 `[📌 复制单元格锚点]` 胶囊按钮（一键生成 `[[当前表.xlsx#Sheet!Cell]]` 并写入剪贴板）。
  - 点击 Excel 锚点胶囊时，触发 `store.emit('anchor:jump', { file, sheet, cell })`：中间栏自动打开目标 `.xlsx`、切换至对应 Sheet、自动计算该行所在分页并跳转、`scrollIntoView({ behavior: 'smooth', block: 'center' })` 滚动定位至目标 `<td>`，并叠加 1.2 秒的 `.cell-anchor-pulse` 弹性高亮边框脉冲动画。

### 7.3 灵动岛“剪贴板智能嗅探”
- **零轮询触发 (`spotlight.js` & `store.js`)**：
  - 仅监听 `window.addEventListener('focus', ...)`，绝不在后台跑 `setInterval` 轮询剪贴板。
  - 维护内存变量 `lastSniffedText` 与 `internalCopyText`（软件内部执行复制锚点/文本时同步更新 `internalCopyText`，避免嗅探自己复制的内容）。
  - 窗口重获焦点时静默尝试读取 `navigator.clipboard.readText()`（权限被拒时静默忽略不报错）；若内容为非空新文本（长度 ≥ 4）且与前值不同，顶部灵动岛切换为 **`sniff` 模式**并平滑展开 4 秒，展示截断预览文案 + `[✨ AI 提取待办]` `[📝 存为笔记]` `[✕]` 三个微型胶囊；鼠标悬停时暂停倒计时，移开或超时自动收起回常规态。

### 7.4 零向量库“跨格式勾选联合问答”
- **前端 (`left_tree.js` & `right_panel.js`)**：
  - 左侧文件树每一项左侧提供轻量圆形勾选框（最多同时勾选 5 份文件，防止上下文过载）。
  - 选中文件后，右侧【联网问答】输入框上方自动浮现已选文件的微型胶囊标签条（如 `[📕 高数笔记.pdf ×] [📊 刷题表.xlsx ×]`），支持随时点击 `×` 移除。
- **后端 (`core/ai_service.py`)**：
  - 接收 `context_paths: list[str]` 后，先逐个调用 `safe_io.resolve_safe_path` 与 `safe_io.is_private` 强校验（任意一份锁定则拦截并明确告知文件名）。
  - 按文件后缀复用现有引擎按需提取纯文本：`.md/.txt` 直读；`.pdf` 用 `PyMuPDF` 提取前 N 页关键文本；`.xlsx` 用 `excel_engine` 序列化表头与前 60 行 Markdown 表格格式。
  - 严格控制字符预算（单文件上限约 4000 字，总上下文上限约 12000 字，超长部分做头尾截断并注明已截断），拼装为清晰的分段参考资料注入 System Prompt，零向量库开销实现跨文档联合问答。

### 7.5 灵动岛专注闭环（倒计时 → 结束自动催填进度表）
- **专注触发 (`right_panel.js` & `store.js`)**：
  - 每条待办任务与场景工作区卡片均配备 `[▶ 专注]` 胶囊按钮（默认 25 分钟，长按或下拉可选 `15秒演示` / `15分钟` / `25分钟` / `45分钟`）。
- **倒计时与收尾闭环 (`store.js` & `spotlight.js`)**：
  - 启动后灵动岛切换为 **`focus` 模式**：显示绿色呼吸小圆点 + 倒计时 + 任务名（`● 24:59 · 高数第三章`）+ 悬停显示暂停/提前结束按钮。
  - 计时归零时（同时触发系统提醒/温和提示音），灵动岛平滑展开为 **`focus-done` 收尾态**，内嵌一行极简输入框与目标 Excel 下拉（默认记住 `config.default_progress_excel` 或当前已导入的首个 `.xlsx`）：提示 *“刚完成了什么？回车直接记入进度表”*。
  - 用户输入一句话敲回车后：优先按当前表头映射（或调用 `/api/ai/extract-table` 快速匹配列，离线时按 `[当前日期, 任务名, 用户输入, "已完成"]` 兜底）直接经 `/api/excel/append-rows` 原位写回本地 `.xlsx`，并弹出成功 Toast 与快照提示。

---

## 8. 苹果风椭圆美学 CSS Design Tokens 与动效规范

`static/css/tokens.css` 必须严格采用以下视觉令牌，严禁使用高饱和紫蓝渐变或生硬边框：

```css
:root {
  /* 画布与悬浮岛屿色阶（浅色 macOS Sonoma/Sequoia 风格） */
  --bg-canvas: #F5F5F7;
  --bg-island: #FFFFFF;
  --bg-glass: rgba(255, 255, 255, 0.72);
  --bg-glass-strong: rgba(255, 255, 255, 0.86);
  --bg-subtle: rgba(118, 118, 128, 0.09);
  --bg-hover: rgba(118, 118, 128, 0.14);

  /* 文字色阶 */
  --text-primary: #1D1D1F;
  --text-secondary: #6E6E73;
  --text-tertiary: #8E8E93;

  /* 苹果克制强调色 */
  --accent: #007AFF;
  --accent-soft: rgba(0, 122, 255, 0.12);
  --success: #34C759;
  --warning: #FF9500;
  --danger: #FF3B30;

  /* 细微高光描边与漫反射阴影 */
  --border-hairline: rgba(0, 0, 0, 0.07);
  --border-glass-edge: rgba(255, 255, 255, 0.65);
  --shadow-island: 0 8px 30px rgba(0, 0, 0, 0.045), 0 1px 2px rgba(0, 0, 0, 0.03);
  --shadow-float: 0 16px 48px rgba(0, 0, 0, 0.10), 0 2px 6px rgba(0, 0, 0, 0.04);

  /* 椭圆与超椭圆几何层级 */
  --radius-pill: 9999px;      /* 导航分段器、动作按钮、软件标签、搜索框、灵动岛 */
  --radius-island: 22px;      /* 三栏悬浮主卡片、弹窗、Bottom Sheet */
  --radius-card: 16px;        /* 内部信息卡片、气泡、待办项 */
  --radius-control: 12px;     /* 输入框、下拉项、表格单元格高亮 */

  /* 毛玻璃滤镜 */
  --blur-glass: blur(20px) saturate(180%);

  /* 系统原生字体栈（零外部字体加载） */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;

  /* 物理阻尼动效曲线（严禁动画化 width/height/top/left，只动 transform/opacity） */
  --ease-apple: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --dur-fast: 160ms;
  --dur-normal: 280ms;
  --dur-slow: 420ms;
}

[data-theme="dark"] {
  --bg-canvas: #0D0D0F;
  --bg-island: #1C1C1E;
  --bg-glass: rgba(28, 28, 30, 0.76);
  --bg-glass-strong: rgba(38, 38, 42, 0.88);
  --bg-subtle: rgba(255, 255, 255, 0.08);
  --bg-hover: rgba(255, 255, 255, 0.13);
  --text-primary: #F5F5F7;
  --text-secondary: #A1A1A6;
  --text-tertiary: #636366;
  --accent: #0A84FF;
  --accent-soft: rgba(10, 132, 255, 0.18);
  --border-hairline: rgba(255, 255, 255, 0.09);
  --border-glass-edge: rgba(255, 255, 255, 0.14);
  --shadow-island: 0 10px 32px rgba(0, 0, 0, 0.38);
  --shadow-float: 0 20px 56px rgba(0, 0, 0, 0.55);
}
```

### 必备核心视觉与动效组件
1. **顶部居中多态“灵动岛”状态胶囊 (`.dynamic-island`)**：全椭圆深色毛玻璃悬浮条，支持 5 种状态平滑切换——`idle`（当前文档与状态）、`sniff`（剪贴板无感嗅探动作条）、`focus`（绿色呼吸点 + 专注倒计时）、`focus-done`（专注结束微型进度填表条）、`alert`（定时提醒到达 +【一键执行】）。
2. **椭圆分段控制器 (`.segmented-pill`)**：用于右侧栏三模式切换（`AI总结` / `联网问答` / `工具台`）及 MD 编辑/预览切换，底部跟随滑块使用 `--ease-spring` 平滑滑动。
3. **Excel 锚点高亮脉冲 (`.cell-anchor-pulse`)**：跳转定位到目标单元格时，触发 1.2 秒苹果蓝柔光边框与轻微缩放回弹动画。
4. **物理按压反馈**：所有 `.pill-btn` 必须定义 `:active { transform: scale(0.96); }`。
5. **右下角堆叠提示条 (Stacked Toast)**：参考 Sonner，全椭圆卡片从底部淡入微弹，支持同时堆叠 3 条不重叠。

---

## 9. 双端通用响应式断点与 PWA 规范

### 9.1 三级视口断点
- **Desktop (`min-width: 1024px`) — macOS 三栏悬浮岛**：
  - 画布留白 `12px`，三栏间距 `12px`：`左侧 260px` | `中间 minmax(0, 1fr)` | `右侧 360px`（均支持顶部胶囊折叠左右栏进入专注模式）。
  - 启用 `Ctrl+K` Spotlight 居中悬浮胶囊搜索面板（搜笔记、搜文件、直接敲回车启动绑定的本地软件）。
- **Tablet (`768px <= width <= 1023px`) — iPadOS 双栏 + 侧滑抽屉**：
  - 左侧目录隐藏为左侧毛玻璃抽屉；主屏显示“中间文档 + 右侧 AI/工具台”双栏并排。
- **Mobile (`max-width: 767px`) — iOS 单栏聚焦 + 拇指热区设计**：
  - 主区域占满 `100dvh`（适配手机浏览器动态地址栏与安全区 `env(safe-area-inset-bottom)`），同时仅渲染当前激活的视图（目录 / 文档 / AI工具台）。
  - **底部悬浮全椭圆毛玻璃导航栏**：居中悬浮距底 `16px`，包含 `[📁 目录]` `[📄 文档]` `[✨ AI/工具]` 三个胶囊切换项，右侧独立悬浮 `[+]` 椭圆按钮用于一键剪贴板导入/语音速记。
  - 所有新建节点、桌面捕获、表单填表、AI 设置、快照回滚弹窗在移动端自动变为 **Bottom Sheet（底部圆角抽屉，圆角 `24px 24px 0 0`）**，便于单手拇指操作。

### 9.2 PWA 配置 (`static/manifest.json`)
- 设置 `display: "standalone"`、`theme_color: "#F5F5F7"`、`background_color: "#F5F5F7"`，内置内联 SVG 图标引用，保证手机端通过局域网地址“添加到主屏幕”后无浏览器地址栏干扰。