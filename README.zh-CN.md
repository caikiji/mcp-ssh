<p align="center">
  <br/>
  <h1 align="center">🔌 @caikiji/mcp-ssh</h1>
  <p align="center">MCP SSH 服务器 — 远程执行、文件传输、文件编辑<br/>自动备份 &amp; 回收站 &amp; <code>~/.ssh/config</code> 集成</p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@caikiji/mcp-ssh"><img src="https://img.shields.io/npm/v/@caikiji/mcp-ssh?style=flat-square&logo=npm" alt="npm version"/></a>
    <a href="https://www.npmjs.com/package/@caikiji/mcp-ssh"><img src="https://img.shields.io/npm/dm/@caikiji/mcp-ssh?style=flat-square" alt="npm downloads"/></a>
    <a href="https://github.com/caikiji/mcp-ssh"><img src="https://img.shields.io/github/stars/caikiji/mcp-ssh?style=flat-square&logo=github" alt="github stars"/></a>
    <a href="./README.md"><img src="https://img.shields.io/badge/English%20docs-blue?style=flat-square" alt="english docs"/></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js" alt="node version"/>
    <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license"/>
  </p>
  <p align="center">
    <b><a href="#安装">安装</a></b>
    ·
    <b><a href="#配置">配置</a></b>
    ·
    <b><a href="#工具">工具</a></b>
    ·
    <b><a href="#备份--回收站">备份 &amp; 回收站</a></b>
    ·
    <b><a href="./README.md">English</a></b>
  </p>
  <br/>
</p>

## ✨ 特性

- **🔐 SSH 凭据管理** — 单个环境变量注册多台服务器，支持密码和密钥
- **📋 Config 集成** — 直接引用或自动导入 `~/.ssh/config`（`$config`）
- **💻 远程执行** — 支持超时、虚拟终端（PTY）、sudo 密码自动输入
- **📁 文件传输** — 通过 SFTP 上传/下载
- **📝 文件编辑** — 读取、写入、搜索替换、行操作，修改前自动备份
- **🗑️ 回收站保护** — 删除的文件移入 `~/.mcp-ssh/trash/`（阈值可配置）
- **📊 备份统计** — 随时查看所有服务器的备份和回收站磁盘占用
- **🐞 调试模式** — `SSH_DEBUG=true` 查看连接/执行/SFTP 诊断日志

## 安装

```bash
npm install -g @caikiji/mcp-ssh
```

## 配置

### `SSH_SERVICES`

通过环境变量注册服务器，多个条目用 `;` 分隔。

```
SSH_SERVICES="web:root@192.168.1.100:22|/path/to/id_rsa;db:deploy@db.internal|db_password"
```

**格式：** `[名称:]用户@主机[:端口]|凭据`

| 部分 | 说明 |
|------|------|
| `名称` | 可选，工具中显示的名称（默认用主机名）。重名自动加数字后缀。 |
| `端口` | 可选，默认 `22`。 |
| `凭据` | 文件路径 → SSH 私钥，否则当作密码。 |

### 使用 `~/.ssh/config`

直接引用 config 中定义的 Host（不需要 `@`）：

```bash
SSH_SERVICES="production|password;db:db-server|"
```

- `|` 后面不填凭据 → 使用 config 中的 IdentityFile
- `[名称:]config_host` → 自定义显示名

### 自动导入所有 config 主机（`$config`）

自动导入 `~/.ssh/config` 中所有同时包含 **User** 和 **IdentityFile** 的 Host：

```bash
SSH_SERVICES="$config"
# 也可与普通条目混用：
SSH_SERVICES="$config;extra:root@other.host|password"
```

> 修改 config 后下一次工具调用自动生效，**无需重启 MCP**。

### 环境变量

| 变量 | 默认值 | 说明 |
|----------|---------|------|
| `SSH_TIMEOUT` | `15000` | 连接超时（毫秒） |
| `SSH_LARGE_FILE_MB` | `10` | 超过此大小（MB）的文件跳过备份/回收站 |
| `SSH_DEBUG` | — | 设为 `true` 开启调试日志（输出到 stderr） |

### MCP 客户端配置

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@caikiji/mcp-ssh"],
      "env": {
        "SSH_SERVICES": "$config;web:root@192.168.1.100|/path/to/key"
      }
    }
  }
}
```

## 工具

### 服务器管理

| 工具 | 参数 | 说明 |
|------|------|------|
| `list_servers` | — | 列出所有已配置的服务器地址和认证方式 |

### 命令执行

| 工具 | 参数 | 说明 |
|------|------|------|
| `exec` | `server`, `command`, `[timeout]`, `[pty]`, `[sudo_password]` | 执行任意 shell 命令。`timeout` 限制执行时间（秒）。`pty: true` 分配虚拟终端。`sudo_password` 通过 `sudo -S` 执行（密码走 stdin 管道，无需 PTY）。 |

### 文件传输

| 工具 | 参数 | 说明 |
|------|------|------|
| `upload` | `server`, `local_path`, `remote_path` | 上传本地文件到远程服务器 |
| `download` | `server`, `remote_path`, `local_path` | 从远程服务器下载文件 |

### 文件操作

| 工具 | 参数 | 说明 |
|------|------|------|
| `read` | `server`, `remote_path`, `[offset]`, `[limit]` | 读取文件，支持按行范围（offset 从 1 开始）。若路径是目录则给出友好提示。 |
| `write` | `server`, `remote_path`, `content`, `[mode]` | 覆盖写入（`mode: "write"`，默认）或追加（`mode: "append"`）。自动备份。 |
| `update` | `server`, `remote_path`, `search`+`replace`+`[replace_all]` **或** `line`+`content`+`[position]` | 编辑已有文件：搜索替换（全部或首次），或行操作（替换、插入前后、删除范围）。修改前自动备份。 |
| `rm` | `server`, `remote_path` | 删除文件/目录。小文件（默认 ≤10MB）移入回收站而非永久删除 |
| `ls` | `server`, `remote_path` | 列出目录条目或获取文件详情（名称、类型、大小、修改时间、权限） |

## 备份 & 回收站

```
~/.mcp-ssh/
├── backups/<服务器>/<路径>.bak.1   ← 最新（保留 3 个版本）
├── backups/<服务器>/<路径>.bak.2
├── backups/<服务器>/<路径>.bak.3   ← 最旧
└── trash/<服务器>/<路径>.<时间戳>
```

## 备份 & 回收站

```
~/.mcp-ssh/
├── backups/<服务器>/<路径>.bak.1-3   ← 写入前自动轮转备份
└── trash/<服务器>/<路径>.<时间戳>    ← 删除小文件（≤10MB）进回收站
```

通过 `exec` 查看实际用量：
```
exec server, "du -sh ~/.mcp-ssh"
```

---

<p align="center">
  <a href="./README.md">📖 English docs</a>
</p>
