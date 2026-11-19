# SmartLocalNote — 对话全记录与本地 Antigravity 开发交接手册

> **用途说明**：本文档完整记录了 SmartLocalNote 从零搭建到 V4 的全部对话需求、设计决策、Bug 排查经验、架构红线与 GitHub 源码仓库信息。  
> **在本地电脑打开 Antigravity 后**，只需克隆本项目并在对话中直接引用本文件（或复制下方「第 1 部分：一键交接提示词」发给本地 Antigravity），即可无缝接续开发。

---

## 一、给本地 Antigravity 的一键交接提示词（直接复制发送即可）

```text
请先完整阅读项目根目录的 SPEC.md 和 DEV_HANDOFF.md，了解项目全部上下文、V1–V4 演进决策和架构红线。

背景交接：
1. 我是本项目作者，此前已在云端完成了 SmartLocalNote V1 ~ V4 的开发并打包出 Windows SmartLocalNote.exe，现在切换回我本地 Windows 电脑用 Antigravity 继续迭代（后续验证完桌面闭环后还会做安卓版）。
2. 核心产品定位：不是传统的“文件仓库型笔记（Notion/Obsidian/飞书）”，而是「个人桌面万物直达指挥台」——硬盘文件（PDF/Excel/压缩包/图片/音视频/Word/PPT）全部留在原地零复制，靠 [[...]] 万物直达胶囊、拖拽蓝线精准拼装、块级实时阅览（Live Preview）、右键闪念卡、原生 SVG 脑图与灵动岛专注填表闭环串联。
3. 必须严格遵守的工程红线：
   - 薄路由（api/*.py 每接口 <= 15 行）、厚核心（core/*.py 无 FastAPI 依赖）；
   - 所有本地写操作 100% 经过 core/safe_io.py（白名单、写前 .bak 快照、原子写、隐私锁硬拦截）；
   - 纯原生前端（ES6 Modules + CSS Design Tokens，零 React/Vue/Vite/node_modules，仅动画化 transform/opacity）；
   - 保持 main.py 中对 .js/.mjs 强制 application/javascript MIME 的中间件（防 Windows 注册表 text/plain 导致 WebView2 拒载模块）；
   - 执行大改动时如我要求，先列清晰计划，再高效并行修改、少做无用功、做好自测。

请确认已读取完毕，检查本地 Python 环境并帮我准备本地运行与调试。
```

---

## 二、本地 Windows 开发环境快速接手步骤

### 1. 获取源码与启动调试
- **GitHub 私有仓库**：`https://github.com/Thexiaohao/SmartLocalNote.git`（分支：`main`）
- **当前已内置资产**：
  - `assets/icon.ico`（苹果蓝圆角多分辨率图标）
  - `assets/demo_seed/`（高数演示样本集，首次运行自动释放到 `data/notes/`）
  - `SmartLocalNote.spec` + `build_exe.bat`（本地 Windows 一键编译 `.exe`）
  - `.github/workflows/build-windows-exe.yml`（推送 `main` 自动云端编译并更新 GitHub Release `latest-win64`）

在本地 PowerShell / 终端执行：
```powershell
git clone https://github.com/Thexiaohao/SmartLocalNote.git
cd SmartLocalNote

# 方式 A：纯网页/源码开发模式（改完前端刷新页面即可见，最快）
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe main.py --web-only

# 方式 B：桌面原生 WebView2 窗体模式
.venv\Scripts\python.exe main.py

# 方式 C：在本地重新打包成单文件 dist\SmartLocalNote.exe
.\build_exe.bat
```

---

## 三、完整对话与产品演进时间线（V1 → V4 全记录）

### 阶段 0：读取云盘规范，启动 4 阶段工程化落地（V1）
- **用户指令**：
  > 「执行我云盘中的计划，让Neon模型做快速，高判断力的总指挥，同时允许它调用多个并行的Hydrogen的子Agent，少做无用功，边做边汇报」
- **云盘计划核心（`SPEC.md` + 分阶段执行指令集）**：
  - 北极星闭环：**随时记录/嗅探导入 → AI 总结提炼“需要做什么”+定时提醒 → 捕获/联启本地软件进入灵动岛专注倒计时 → 原位预览/编辑 PDF/Excel/MD/TXT + 跨格式精准锚点 + 跨格式联合问答 → 专注结束自动催填进度表写回本地 Excel**。
  - **V1 实测数据**：冷启动 `0.476s`（`<1s`）、空闲内存 `43.88 MB`（`<80MB`）、薄路由 AST 最长 `13` 行、全链路 14 项验收通过。

---

### 阶段 1：Windows `.exe` 打包与 WebView2 疑难根治
- **用户指令**：
  > 「我需要的是exe形式的软件 / 我需要的是exe形式的程序，等我验证完用途再去做安卓版」
  > 「选择通过 GitHub Actions 编译好 SmartLocalNote.exe 并上传到 Google 云盘」
- **遭遇问题 & 排查实录**：
  1. **首次运行界面卡在「正在初始化工作区…」**：
     - 用户截图反馈桌面窗口与 CSS 已渲染，但左右中三栏停留在 HTML 静态占位符。
     - **根因**：Windows 注册表常将 `.js` 识别为 `text/plain`，FastAPI `StaticFiles` 沿用后，WebView2 对 `<script type="module">` 严格校验 MIME 导致拒载脚本。
     - **解法**（commit `95e81e0`）：在 `main.py` 中用 `mimetypes.add_type` 并增加 HTTP 中间件，强制所有 `.js`/`.mjs` 返回 `application/javascript; charset=utf-8`；在 `index.html` 加缓存版本参数与未启动诊断兜底；在 GitHub Actions 增加 `.js` MIME 硬校验。
  2. **SmartScreen 蓝屏拦截提示「发布者未知」**：
     - 系自编译无商业 EV 代码签名所致，指导用户「更多信息 → 仍要运行」或文件属性勾选「解除锁定」放行。

---

### 阶段 2：初次上手后的 8 项核心痛点改造（V2 · commit `513df22`）
- **用户原话反馈**：
  1. 预览 MD 文件显示不全；
  2. PDF 展示不出来；
  3. 三个窗口左右间距不可自定义；
  4. 左侧资料与工作区和右侧应当是模块化设计，用户可以自定义添加功能和排序等操作；
  5. 修改文档字体可以自定义大小；
  6. 搜索加一个根据关键词检索和一个根据语义描述检索（需要 AI）；
  7. 先接入一些免费 AI 提供最基本的服务；
  8. 加入可拖动元素，比如 AI 的总结在左侧栏/右侧栏可以直接拖到中间笔记栏目放进去。
- **V2 落地成果**：
  - 修复 `.main-grid` 缺少 `grid-template-rows: minmax(0, 1fr)` 导致的预览截断，加独立 `.md-scroll-area`；
  - 新增 `GET /api/files/pdf-page`（PyMuPDF 本地高清 PNG 渲染 + 32 页 LRU 缓存），彻底替代易空白的 WebView2 PDF iframe，同时保留「原生预览」切换；
  - 新增三栏可拖拽分隔条 `#resizer-left` / `#resizer-right`（持久化 `localStorage`）；
  - 左右双栏全面模块化（支持显隐、拖动排序、新增「灵感便签」「最近打开」「快捷专注」「AI 常用指令模板」）；
  - 中间文档工具栏增加 `A-` / `A+`（12–24px）与字体风格切换（无衬线/衬线/等宽）；
  - 新增 `core/search_engine.py` + `POST /api/search`，Spotlight 升级三模式：`⚡ 快捷跳转` / `🔍 关键词全文检索` / `✨ AI 语义描述检索`；
  - `ai_service.py` 接入三级免费 AI 自动路由（自定义 Key → 本机 Ollama 自动探测 → 免 Key 免费公共通道 → 本地增强语义引擎），设置页增加 7 组免费/国产模型一键预设（智谱 GLM-4-Flash、硅基流动、Gemini、Groq、Ollama 等）；
  - 实现跨栏拖拽放置（AI 总结、待办、对话回复、左侧文件锚点均支持拖入中间笔记）。

---

### 阶段 3：深化产品方向与 10 项需求 + 5 项创新（V3 · commit `55a446b`）
- **用户原话反馈**：
  1. 加多支持文件格式，大部分文件都能打开，如压缩包不解压、提供简单预览；
  2. 拖入后切换其他界面不会自动保存，希望提醒用户保存，并在设置里加「切换文件自动保存」选项不再提醒；
  3. 希望把 `[[...]]` 发展成“万物直达胶囊”（MD 也能直达、网址连接、压缩包都能做成小模块直达，不用存入笔记本内部避免文件重复）；
  4. 办公软件直达也希望能拖入预览框内部直接到达；
  5. 不知道“场景工作区”是干嘛的，要求解释；
  6. 灵感便签应在右键的时候召唤出来，而不是固定藏在左边输入；
  7. 预览时用户也能自己修改样式（`>`、`#` 等），让文档更醒目；
  8. 插入不能只插到底部，要按用户拖拽位置插入，并自动在上下各空一行；
  9. 自定义默认笔记目录；
  10. 加入生成脑图、思维导图功能，并继续提出更多创新想法。
- **V3 落地成果 & 5 项延伸创新**：
  - 扩展 `safe_io.py` / `doc_engine.py` 支持代码文本、`.zip/.tar/.gz` **纯内存免解压树状目录与文本/图片预览**、图片/音视频流式播放、`.docx/.pptx` 标准库 XML 速览与系统默认程序打开；
  - 升级 **万物直达胶囊协议**：`[[note.md#章节]]`、`[[pack.zip!内部文件]]`、`[[video.mp4#t=MM:SS]]`、`[[app:软件名]]`、`[[url:标题|链接]]`（`POST /api/tools/fetch-url-title`）；
  - 新增 **断链自动寻回**（`POST /api/files/relocate`）与 **双向反向引用徽章**（`GET /api/files/backlinks`）；
  - 新增切换文件/失焦未保存弹窗提醒 + 设置页 `auto_save_on_switch` 开关 + 默认笔记目录原生文件夹选择；
  - 预览态划词悬浮格式美化条 + 双击段落原地改字 + 苹果蓝精准落点插入线与自动空一行（`insertMarkdownWithPadding`）；
  - 新增 `mindmap.js` 纯原生 SVG 交互式脑图（支持缩放拖拽、双击回写 `.md`、右键标记 `🟢/🟡/🔴` 掌握度并直接进入专注、导出 SVG/PNG、AI 提炼脑图 `/api/ai/mindmap` & 碎片润色 `/api/ai/polish`）；
  - 「场景工作区」更名为 **「一键场景包」** 并加说明；所有本地软件胶囊可拖入笔记。

---

### 阶段 4：与 Notion / Obsidian / 飞书的定位对比
- **用户提问**：「OBsidian和notion和飞书这三个跟我这个很像啊，我对比他们有什么优势吗」
- **核心结论**：
  - 不去拼云端多人协作（Notion/飞书）或海量社区插件生态（Obsidian）；
  - 切中空白地带——**极轻量（~44MB 内存）+ 零文件复制原位掌控本地硬盘（Excel 原位改、压缩包免解压看、音视频时间戳直达）+ 桌面软件联启与专注填表行动闭环 + 开箱即用免折腾与单文件隐私硬锁**。

---

### 阶段 5：体验打磨与 Live Preview 质变升级（V4 · commit `ce1eaf7`）
- **用户原话反馈（12 条）**：
  1. 灵感便签太像 macOS，且拖动不灵敏、点 `✕` 会变色；
  2. 拖入自动分行还是不够灵敏；
  3. **大胆想法：预览与编辑放一起**（既有醒目提示又不破坏原文档）；
  4. 左侧排列方式待改进（按名称、字母、类型、修改时间排序，显示修改时间）；
  5. 导入界面文案仍写着只支持那四个格式；
  6. 预览直接支持图片显示和视频封面显示，允许调节图片和视频大小；
  7. 补齐通用快捷键（`Ctrl+Z` 撤回等）；
  8. 右键菜单应分区（只在中间面板右键召唤便签，左侧右键文件显示重命名/打开位置等服务）；
  9. 左右模块大小不应固定死，可自由调节高度，并可一键恢复默认；
  10. 增加已勾选联合问答笔记的上限；
  11. 左侧目录往下滑后主文件夹要常驻置顶，增加文件夹内搜索；
  12. 可借鉴 GitHub 优秀项目与 Obsidian 的成熟交互思路（原创实现，不侵权）。
- **V4 落地成果**：
  - **#1 原创「毛玻璃闪念卡」**（`static/js/stickies.js`）：去 macOS 纸片与圆点，改为中性毛玻璃+左侧细强调条，零 CSS transition 的 60fps `requestAnimationFrame` 跟手拖动，支持右下角调大小，修复 `✕` 误变色；
  - **#3 块级实时阅览 Live Preview**（`static/js/center_view.js`）：顶栏升级为 `实时阅览（默认）| 纯源码 | 🧠 脑图`；未点击块按醒目样式展示，点击任意块原地编辑源码，方向键上下无缝跨块，`.md` 原文件保持 100% 纯净；
  - **#2 精准蓝线落点**：在实时阅览下按各块中线动态定位蓝线，源码模式按行高反算坐标，100% 保证上下各空一行；
  - **#6 内联媒体与封面缩放**：`[[图.png|w=420]]`、`[[视频.mp4#t=01:20|w=480]]` 直接在笔记内显示图片/视频首帧封面，支持原地点击播放、预设宽度按钮与右下角拖拽缩放手柄；
  - **#7 全局快捷键与 80 步撤回重做栈**：`Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`) 覆盖打字、拖拽插入、格式化、媒体缩放与脑图改字；补齐 `Ctrl+F` 页内查找替换条、`Ctrl+S`、`Ctrl+B/I//`、`Ctrl+N`、`Alt+N` 与快捷键速查表；
  - **#8 分区右键**：中间栏右键弹闪念卡/插网址/AI 润色/脑图；左侧文件右键弹重命名（`POST /api/files/rename` 同步所有引用）、打开文件夹、系统打开、隐私锁、移出列表（`POST /api/files/remove` 不删盘）；
  - **#4/#5/#9/#10/#11**：左侧吸顶固定头部 + 文件夹内实时过滤搜索 + 一键回顶 + 4 维排序与修改时间；左右各模块底部增加垂直高度拖拽条 + 一键恢复默认三栏宽度与模块尺寸；联合问答上限从 5 份提升至 **20 份**（30,000 字动态预算）；更新全格式导入文案。

---

## 四、当前项目结构速查（供本地 Antigravity 快速定位）

```text
SmartLocalNote/
├── SPEC.md                        # 最高工程规范与红线
├── DEV_HANDOFF.md                 # 本交接文档（对话记录 + 本地开发指南）
├── main.py                        # FastAPI + PyWebView2 入口（含 Windows .js MIME 强制中间件、_MEIPASS 资源分离）
├── config.py                      # 配置读写、7 组免费 AI 预设、首次运行释放 demo_seed
├── SmartLocalNote.spec            # PyInstaller 打包配置（onefile / onedir）
├── build_exe.bat / start.bat      # Windows 本地一键打包 / 一键启动脚本
├── .github/workflows/             # windows-latest 自动编译 + 冒烟测试 + Release 发布
├── assets/
│   ├── icon.ico                   # 多分辨率桌面图标
│   └── demo_seed/                 # 高数复习笔记.md / 高数刷题进度表.xlsx / 高数重点讲义.pdf
├── core/                          # 【纯核心业务层，不依赖 FastAPI】
│   ├── safe_io.py                 # 白名单防穿越、15份 .bak 快照、原子写、一键回滚、隐私锁
│   ├── doc_engine.py              # 多格式引擎（MD/TXT/代码/PyMuPDF高清渲染/ZIP免解压/音视频/Office XML/重命名/断链寻回）
│   ├── excel_engine.py            # openpyxl read_only 分页、筛选排序、单元格增量改、CSV 导出
│   ├── search_engine.py           # 关键词全文检索 + AI 语义描述检索 + 双向反向引用
│   ├── ai_service.py              # 3级免费 AI 路由、20份跨格式流式问答、总结、填表、脑图提炼、碎片润色
│   ├── app_launcher.py            # PowerShell 桌面窗口捕获、.lnk 解析、应用联启、网址标题抓取
│   ├── tree_store.py              # 虚拟知识树 JSON 映射
│   └── scheduler.py               # APScheduler 提醒调度 + winotify + SSE 广播
├── api/                           # 【薄路由层，每接口 <= 15 行】
│   ├── __init__.py                # 统一 ok/err 封装与全局异常映射
│   ├── system_api.py / files_api.py / excel_api.py / tools_api.py / ai_api.py / search_api.py
└── static/                        # 【纯原生 ES6 Modules 前端，零构建链】
    ├── index.html / manifest.json / vendor/marked.min.js
    ├── css/{tokens.css, app.css}
    └── js/
        ├── store.js               # 全局状态、EventBus、万物直达胶囊渲染、空行插入、媒体缩放解析
        ├── api_client.js          # fetch & SSE 流式客户端
        ├── icons.js               # 1.5px 内联 SVG 图标
        ├── app.js                 # 启动器、三栏宽度拖拽分隔条、全局 Ctrl+N、移动端导航
        ├── left_tree.js           # 吸顶搜索、4维排序、20份多选、文件右键菜单、一键场景包、模块化定制
        ├── center_view.js         # Live Preview 块编辑、Ctrl+Z/Y/F、多格式阅览、媒体缩放、SVG 脑图切换
        ├── right_panel.js         # 三模式 AI 副驾驶、卡片拖拽入笔记、工具台、模块高度调节
        ├── spotlight.js           # Ctrl+K 三模式搜索、五态灵动岛、剪贴板嗅探、专注填表、免费 AI 设置
        ├── stickies.js            # 原创毛玻璃闪念卡（仅中间栏右键召唤）
        └── mindmap.js             # 零依赖原生 SVG 交互脑图（标色掌握度 + 专注联动 + 导出 SVG/PNG）
```

---

## 五、后续本地开发建议优先级
1. **本地实测一轮 V4**：重点在真实 Windows 上测试「实时阅览点块编辑」、「拖入本地图片/视频并拖动右下角缩放」、「右键闪念卡拖动与关闭」、「左侧右键重命名/移出」。
2. **打磨高频体验后再定型安卓版**：等桌面端 100% 顺手后，安卓端可直接复用当前 FastAPI 后端 API 协议与 `[[...]]` 胶囊语法，主打「3 秒语音/拍照/剪贴板速记 + 脑图查看 + 专注倒计时」。
