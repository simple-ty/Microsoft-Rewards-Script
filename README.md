<div align="center">

# Microsoft Rewards Script

[![Version](https://img.shields.io/badge/version-3.1.6.4-blue.svg)](./package.json)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-green.svg)](./package.json)

**🐳 纯 Docker 容器化 · 微软奖励自动化脚本**

基于 TypeScript · Playwright · Cheerio，国内优化版

</div>

---

## ✨ 功能

- 自动完成每日集、促销活动、打卡、签到、阅读赚取
- 桌面 + 移动端搜索（模拟 Edge 浏览器）
- 中国热搜词源（百度/头条/抖音/微博/知乎），无需代理
- 会话持久化，首次登录后自动复用
- PushPlus 微信推送（HTML 卡片样式）
- 内置 cron 定时调度 + 随机延迟

---

## 🚀 部署

### 1. 准备账号

```bash
cp env.example .env
```

编辑 `.env`，填写你的微软账号：

```dotenv
ACCOUNT_1_EMAIL=you@example.com
ACCOUNT_1_PASSWORD=your_password
ACCOUNT_1_GEO_LOCALE=cn
ACCOUNT_1_LANG_CODE=zh
```

多账号按 `ACCOUNT_2_*`、`ACCOUNT_3_*` 递增。

### 2. 配置调度和推送

编辑 `compose.yaml` 中需要调整的环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CRON_SCHEDULE` | 每日执行时间 | `0 7 * * *`（早 7 点） |
| `TZ` | 时区 | `Asia/Shanghai` |
| `RUN_ON_START` | 容器启动时立即跑一次 | `true` |
| `CONFIG_PUSHPLUS_TOKEN` | PushPlus token | 空（不推送） |
| `CONFIG_PUSHPLUS_TEMPLATE` | 推送模板 | `html` |

### 3. 启动

```bash
docker compose up -d --build
```

首次运行需要**手动完成网页登录**（自动打开的浏览器不可见，你需要查看日志获取登录提示）。登录后 cookie 保存在 `./sessions/` 目录，后续自动复用。

---

## 📂 数据持久化

| 目录 | 内容 |
|------|------|
| `/volume1/docker/rewards-script/config/` | 运行时配置（自动生成，可通过 `CONFIG_*` 环境变量覆盖） |
| `/volume1/docker/rewards-script/sessions/` | 登录会话（cookie） |
| `/volume1/docker/rewards-script/logs/` | 运行日志（按日期命名） |

重建容器不会丢失这些数据。

---

## 🔔 PushPlus 推送

在 `compose.yaml` 中取消注释并填写 token：

```yaml
CONFIG_PUSHPLUS_ENABLED: 'true'
CONFIG_PUSHPLUS_TOKEN: '你的token'
```

Token 从 [pushplus.plus](https://www.pushplus.plus/) 获取。推送效果为 HTML 卡片样式，包含今日获取积分、当前积分、各账号明细等信息。

---

## 🛠 常用命令

```bash
docker compose up -d --build   # 构建并启动
docker compose logs -f          # 查看日志
docker compose restart          # 重启
docker compose down             # 停止
```

---

## ⚙️ 完整配置参考

以下所有 `CONFIG_*` 环境变量均可在 `compose.yaml` 中设置：

<details>
<summary><b>任务开关</b></summary>

| 变量 | 默认值 |
|------|--------|
| `CONFIG_WORKER_DAILY_SET` | `true` |
| `CONFIG_WORKER_CLAIM_BONUS_POINTS` | `true` |
| `CONFIG_WORKER_SPECIAL_PROMOTIONS` | `true` |
| `CONFIG_WORKER_MORE_PROMOTIONS` | `true` |
| `CONFIG_WORKER_PUNCH_CARDS` | `true` |
| `CONFIG_WORKER_APP_PROMOTIONS` | `true` |
| `CONFIG_WORKER_DESKTOP_SEARCH` | `true` |
| `CONFIG_WORKER_MOBILE_SEARCH` | `true` |
| `CONFIG_WORKER_DAILY_CHECKIN` | `true` |
| `CONFIG_WORKER_READ_TO_EARN` | `true` |

</details>

<details>
<summary><b>搜索行为</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CONFIG_QUERY_ENGINES` | `china,local` | 查询源（china=中国热搜 / local=本地词兜底） |
| `CONFIG_CHINA_API_APPKEY` | 空 | gmya.net appkey，解除免费档限流 |
| `CONFIG_SEARCH_DELAY_MIN` | `30sec` | 搜索最小间隔 |
| `CONFIG_SEARCH_DELAY_MAX` | `1min` | 搜索最大间隔 |
| `CONFIG_SEARCH_PARALLEL` | `false` | 桌面/移动端搜索并行 |
| `CONFIG_SEARCH_SCROLL_RANDOM` | `true` | 随机滚动结果页 |
| `CONFIG_SEARCH_CLICK_RANDOM` | `true` | 随机点击结果链接 |

</details>

<details>
<summary><b>其他</b></summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CONFIG_CLUSTERS` | `1` | 并发数 |
| `CONFIG_DEBUG_LOGS` | `false` | 调试日志 |
| `CONFIG_ERROR_DIAGNOSTICS` | `false` | 错误时截图诊断 |
| `CONFIG_ENSURE_STREAK_PROTECTION` | `true` | 连击保护 |
| `CONFIG_GLOBAL_TIMEOUT` | `30sec` | 全局超时 |
| `MIN_SLEEP_MINUTES` | `5` | 执行前最小随机延迟 |
| `MAX_SLEEP_MINUTES` | `50` | 执行前最大随机延迟 |
| `STUCK_PROCESS_TIMEOUT_HOURS` | `8` | 卡住进程超时小时数 |

</details>

---

## ❓ 常见问题

<details>
<summary><b>改了 compose.yaml 为什么不生效？</b></summary>

改完代码或配置后必须加 `--build` 重建镜像：

```bash
docker compose up -d --build
```

</details>

<details>
<summary><b>容器一直重启 / 没有按 cron 时间执行？</b></summary>

运行诊断脚本排查：

```bash
bash diagnose-cron.sh
```

</details>

<details>
<summary><b>搜索词被限流（403）？</b></summary>

到 [gmya.net](https://gmya.net) 申请 appkey，在 `compose.yaml` 中设置：

```yaml
CONFIG_CHINA_API_APPKEY: '你的appkey'
```

</details>

---

## 📜 致谢

本项目 fork 自 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script)，针对国内环境做了深度本地化：

- 中国热搜查询源（无需代理）
- PushPlus 微信推送
- 日志中文化
- 纯 Docker 部署设计

| | |
|---|---|
| 上游仓库 | [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) |
| License | GPL-3.0-or-later |

---

## ⚠️ 免责声明

使用自动化脚本可能导致 Microsoft Rewards 账户被暂停或封禁。本项目仅供学习交流，使用者自行承担风险。
