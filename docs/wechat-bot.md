# WeChat Bot 集成教程

通过 WeChat Bot，你可以直接在微信中控制 Claude Code / Codex 会话，，无需打开浏览器。

即可随时随地通过微信发送消息、创建会话、管理会权限、切换模型。

以及批准或拒绝工具操作。

---

## 配置

### 1. 进入设置页面

打开 Companion Web UI，导航到 **Integrations** 页面，点击 **WeChat Bot** 卡片的齿轮图标，或或直接访问 `#/integrations/wechat`。

### 2. 启动 Bot

1. 点击 **Start** 按钮启动 WeChat Bot
2. 页面会显示 "Starting..." 并出现一个二维码
2. 用微信扫描二维码并确认登录
3. 登录成功后状态自动变为 **Running**

> 频道提示： Bot 凭据会 `~/.companion/wechat-bot/` 目录持久化，首次登录后无需再次扫码。

### 3. 配置选项

| 选项 | 说明 | 默认值 |
|------|------|------|
| **Enable WeChat Bot** | 服务器启动时自动启动 Bot | 关 |
| **Auto-approve safe tools** | 自动批准 Read、 Glob、 Grep 等只读操作 | 开启 |
| **Forward dangerous permissions** | Bash (rm)、 Write、 Edit 瓍转发微信等待批准 | 开启 |
| **Allowed Users** | 微信用户 ID 白名单，逗号分隔），留空允许所有人） | 空 |
| **Default Permission Mode** | 新建会话的权限模式 | `acceptEdits` |
| **Default Working Directory** | /new 和 /dir 命令的基础目录 | 空 |

### 4. 服务器自动启动

勾选 **Enable WeChat Bot** 后，每次服务器重启启会自动启动 Bot，无需手动操作。

---

## 使用

### 基本对话

直接发送任何文本消息即可与当前的 Claude Code 会话进行多轮对话：

```
你: 你好，请帮我写一个 Python 脚本
Bot: 你好！我很乐意帮你编写 Python 脚本。请告诉我你需要这个脚本做什么？

你: 写一个读取当前目录下所有 .txt 文件并统计行数的脚本
Bot: [返回脚本内容]
```

### 命令

所有命令以 `/` 开头，不区分大小写：

| 命令 | 说明 | 示例 |
|-------|------|------|
| `/new [folder]` | 创建新会话，可指定默认目录下的子文件夹 | `/new test` |
| `/sessions` | 列出你的所有会话 | `/sessions` |
| `/switch <n>` | 切换到第 n 个会话 | `/switch 2` |
| `/kill` | 终止当前会话 | `/kill` |
| `/model <name>` | 切换模型 | `/model claude-sonnet-4-6` |
| `/mode <mode>` | 切换权限模式 | `/mode bypassPermissions` |
| `/allow` | 批准当前权限请求 | `/allow` |
| `/deny` | 拒绝当前权限请求 | `/deny` |
| `/interrupt` | 中断当前操作 | `/interrupt` |
| `/status` | 查看当前会话状态 | `/status` |
| `/dir [path]` | 列出默认目录下的文件夹，加 `-r` 递归 | `/dir` 或 `/dir -r src` |
| `/help` | 查看所有命令 | `/help` |

### 默认目录与文件夹操作

在设置页配置 **Default Working Directory**（如 `/home/user/projects`）后：

**创建会话时指定文件夹:**
```
你: /new my-app
Bot: Session created: abc12345...
      Model: default
      CWD: /home/user/projects/my-app
```

如果 `my-app` 文件夹不存在，会自动创建。

**浏览目录结构:**
```
你: /dir
Bot: Contents of default directory:
     📁 project-a/
     📁 project-b/
     📄 readme.md

你: /dir project-a
Bot: Contents of project-a:
     📁 src/
     📁 tests/
     📄 package.json

你: /dir -r project-a
Bot: Contents of project-a:
     📁 src/
       📁 components/
         📄 App.tsx
       📄 index.ts
     📁 tests/
       📄 app.test.ts
     📄 package.json
```

### 权限处理

当 Claude Code 需要执行操作时，Companion 会根据设置自动处理：

**自动批准（推荐开启）:**
- `Read` — 读取文件
- `Glob` — 搜索文件
- `Grep` — 搜索内容
- `WebSearch` — 琜索网页

**需要批准（推荐开启 "Forward dangerous permissions"）:**
- `Bash`（含 rm、 chmod、dd 等危险命令）
- `Write` — 写入文件
- `Edit` — 编辑文件
- 其他未知工具

收到权限请求时，微信会显示工具名称和操作内容，回复 `/allow` 或 `/deny`：

```
[Bash] rm -rf /tmp/old_logs
Approve? /allow or /deny
```

### 可用权限模式

| 模式 | 说明 |
|------|------|
| `acceptEdits` | 默认，自动批准文件编辑 |
| `bypassPermissions` | 跳过所有权限检查 |
| `plan` | 只读模式，需要确认才执行 |
| `default` | 使用 Claude Code 默认行为 |

---

## 常见问题

### Q: 登录过期怎么办？

Bot 会自动尝试恢复登录。如果凭据失效，需要重新扫码：停止 Bot → 启动 Bot → 扫码登录。

### Q: 如何限制谁能使用 Bot？

在设置页的 **Allowed Users** 中填写微信用户 ID（逗号分隔）。留空表示允许所有人。

### Q: 消息没有回复？

1. 发送 `/status` 检查会话状态
2. 发送 `/sessions` 知道是否有会话
3. 如果没有会话，发送 `/new` 创建一个

### Q: 如何查看微信用户 ID？

启动 Bot 后，发送任意消息，后端日志中会显示用户 ID。也可以在设置页的 **Active Sessions** 列表中查看（截断显示）。
