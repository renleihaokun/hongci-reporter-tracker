# 弘慈住院报告追踪（hongci-report-tracker）

给住院患者家属看的报告追踪面板。一键抓取**苏大附一院弘慈血液病医院**微信查询系统的住院检验报告与超声报告，归档到 Cloudflare D1，展示关键指标（白细胞 / 血红蛋白 / 血小板 / 中性粒细胞 / CRP）趋势图，支持一键生成 AI 分析提示词（复制到 DeepSeek 等问答式 AI 使用，**无需配置任何 API Key**）。

> ⚠️ 本项目仅供家属参考，不构成任何医疗建议，所有结果请以主治医生解读为准。

## 为什么做这个

医院的查询页有几个痛点：

- 检验报告**只保留 7 天**，过了就查不到，无法回顾病程变化
- 页面是给微信公众号内嵌用的，没有趋势图，家属只能一份份点开看
- 每天得手动输住院号查

本项目把报告**每日归档进 D1**，历史永久保留，自动生成趋势图，点一下按钮就能拿到最新报告。

## 功能

- 📊 **关键指标趋势**：白细胞、血红蛋白、血小板、中性粒细胞、CRP 折线图，绿色带为正常参考区间，异常点红/蓝标注
- 🔄 **一键刷新**：`获取最新报告`按钮，服务端抓取医院页面，增量入库，返回新增与异常摘要
- 🗂 **全量归档**：检验明细 + 超声所见/结论，按日期分组，不受医院 7 天窗口限制
- 🤖 **AI 解读（零成本 / 免 API）**：一键生成分析提示词并复制到剪贴板，去 DeepSeek 网页版或 App 粘贴提问，自动获得家属能看懂的通俗解读；服务端不存任何 API Key
- 📱 **移动端优先**：手机浏览器直接使用，无需构建工具、无前端依赖
- 🔑 **访问密码**：可选 `ACCESS_PASSWORD` 环境变量，配置后全站登录访问（Pages Middleware 拦截 + HttpOnly Cookie）
- 🔒 **隐私安全**：住院号与 API Key 全部放在服务端环境变量，患者数据只存在你自己的 D1 里

## 技术架构

```
手机/浏览器
   │  GET /            → Cloudflare Pages 静态页（public/，无框架）
   │  POST /api/refresh→ Pages Function：抓取医院页面(GBK)→解析→D1 增量入库
   │  GET  /api/data   → Pages Function：读 D1 全量归档
   │  🤖 AI 解读        → 前端本地生成提示词→剪贴板→用户自行粘贴到 DeepSeek
   ▼
Cloudflare D1（SQLite）：lab_reports / us_reports / meta
```

- 抓取解析逻辑在 `functions/_lib/scraper.js`：GBK 解码、报告卡片解析、**参考范围智能拆分**（源站数据丢失分隔符，如 `4.0010.00` 实为 4.00~10.00，用结果值+箭头方向一致性还原）
- **关键指标按报告类型过滤**：尿沉渣等体液报告里也有同名"白细胞"（/μL）与血常规白细胞（×10⁹/L）不同量纲，趋势与最新值只从血常规类报告取数（`app.js` 与 `refresh.js` 各维护一份同步的过滤规则）
- 医院查询无需鉴权（住院号即凭证）、无需会话 Cookie，Function 直接抓取

## 部署（约 10 分钟）

全程在 Cloudflare 控制台完成，无需安装任何工具。

### 1. 创建 D1 数据库并建表

Dashboard → **Storage & Databases → D1 SQL Database → Create database**，命名 `hongci-reports`。
进入数据库 → **Console** 标签 → 把 `schema.sql` 全部内容粘贴进去 → **Execute**（建出 `lab_reports` / `us_reports` / `meta` 三张表）。

### 2. 部署到 Pages

**Workers & Pages → Create → Pages → Connect to Git**，选择本仓库。构建设置：**Framework preset 选 None，Build command 留空，Build output directory 填 `public`**，保存并部署。

### 3. 绑定 D1 与配置环境变量

进入 Pages 项目 → **Settings**：

- **Bindings → Add → D1 database**：**变量名必须填 `DB`**（代码中为 `env.DB`），选中第 1 步创建的数据库。Production 和 Preview 都要绑。
- **Environment variables**（Production 和 Preview 都要配）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `PATIENT_PID` | ✅ | 住院号（六位数字） |
| `ACCESS_PASSWORD` | 强烈建议 | 访问密码。配置后全站（页面+API）需登录，Cookie 30 天有效；不配置则完全开放 |
| `HOSPITAL_BASE` | 可选 | 医院查询系统地址，默认 `http://wx.hcxyb.cn:88/` |

> 本仓库**不含 `wrangler.toml`**：Pages 项目一旦检测到该文件，绑定（Bindings）就会被锁定为只能通过文件管理。
> 为保证 fork 后全程可在控制台操作，D1 绑定一律走 Settings → Bindings，环境变量走 Settings → Environment variables。

配好后 **重新部署一次**（Deployments → 最新一条 → Retry deployment）让绑定与变量生效。

### 4. 使用

打开 `https://hongci-report-tracker.pages.dev`，点 **🔄 获取最新报告**。第一次会抓取近 7 天全部检验报告和近一个月超声报告；之后每次只增量抓取新报告。建议家属每天点一次。

想看 AI 解读就点 **🤖 AI 解读**：提示词会自动复制到剪贴板，再去 [DeepSeek 网页版](https://chat.deepseek.com)（或手机 App）新建对话、粘贴发送即可（建议开启「深度思考 R1」）。提示词只含检验数值与报告类型，不含姓名和住院号。

## 本地开发

无需 Cloudflare 账号，用内置的虚构示例数据预览前端：

```bash
node test/dev-server.mjs
# 打开 http://localhost:8788
```

用 wrangler 联调真实 D1：

```bash
npx wrangler pages dev public --d1 DB=hongci-reports \
  --binding PATIENT_PID=你的住院号
```

测试（使用真实医院页面快照 / 虚构示例数据，不需要网络凭证）：

```bash
node test/smoke.test.mjs    # 抓取解析逻辑
node test/render.test.mjs   # 前端渲染逻辑（含"尿沉渣白细胞不得混入趋势"回归）
node test/auth.test.mjs     # 访问控制
```

## 常见问题

- **刷新按钮多久点一次？** 血常规通常上午 8:30–9:30 审核发布，下午偶有特殊项目。建议上午十点左右点一次。
- **页面会被外人看到吗？** 配置 `ACCESS_PASSWORD` 后，全站需密码登录（Cookie 30 天有效，家人输一次即可）。需要更强保护可再叠加 Cloudflare Access（Zero Trust → Access → 添加应用）。
- **想自动定时刷新？** Pages Functions 不支持 Cron Trigger。可以再建一个独立的 Cloudflare Worker（Cron）每天 POST 一次你的 `/api/refresh`，或用 GitHub Actions 定时触发。若配置了 `ACCESS_PASSWORD`，请求需带 Cookie：`hc_auth=<密码的SHA-256十六进制>`（例如 `curl -X POST -H "Cookie: hc_auth=$(echo -n '你的密码' | sha256sum | cut -d' ' -f1)" https://你的域名/api/refresh`）。欢迎 PR 补充示例。
- **其他医院能用吗？** 抓取解析是针对该医院查询系统页面结构写的。若你所在医院使用相同系统（页面结构一致），改 `HOSPITAL_BASE` 即可；否则需改写 `functions/_lib/scraper.js` 的解析函数，欢迎提 Issue/PR。

## 隐私与免责

- 住院号、访问密码只存在于服务端环境变量，**不要**提交进仓库
- 患者的全部报告数据只存储在你自己账号的 D1 中，本项目本身不依赖任何第三方服务
- **AI 解读功能**：提示词由你的浏览器本地生成并复制到剪贴板，只有你自己主动粘贴并发送给 DeepSeek 等问答式 AI 时，检验数值才会离开本机——是否发送、发送给谁完全由你决定
- 医院页面数据仅供参考，时效以医院为准；参考范围由源页面数据智能还原，个别项目可能与化验单原件略有出入
- **本项目不构成医疗建议。任何治疗决策请遵主治医生医嘱。**

## 目录结构

```
├── public/            # 前端（无框架、无构建）
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── functions/
│   ├── _lib/scraper.js   # 医院页面抓取与解析（GBK、参考范围智能拆分）
│   └── api/
│       ├── refresh.js    # POST /api/refresh 增量抓取入库
│       ├── data.js       # GET  /api/data    全量读取
│       └── login.js      # 访问密码登录/登出
├── schema.sql         # D1 建表语句
└── test/
    ├── smoke.test.mjs    # 解析逻辑冒烟测试
    ├── render.test.mjs   # 前端渲染 + 指标过滤回归
    └── auth.test.mjs     # 访问控制测试
```

## License

MIT
