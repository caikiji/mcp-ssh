# @caikiji/mcp-ssh

MCP 服务器，支持 SSH 远程执行、文件传输、文件编辑，以及自动备份和回收站管理。集成 `~/.ssh/config`。

## 安装

```bash
npm install -g @caikiji/mcp-ssh
```

## 配置

### SSH_SERVICES

通过 `SSH_SERVICES` 环境变量注册一个或多个服务器。多个服务器用 `;` 分隔。

**格式：** `[名称:]用户@主机[:端口]|凭据`

```
SSH_SERVICES="web:root@192.168.1.100:22|/path/to/id_rsa;db:deploy@db.internal|db_password"
```

- **名称** — 可选，工具中显示的名字（默认使用主机名）。重名自动加数字后缀。
- **端口** — 可选，默认 22。
- **凭据** — 如果是一个已存在的文件路径，当作 SSH 私钥使用；否则当作密码。

### 使用 ~/.ssh/config

直接引用 `~/.ssh/config` 中定义的 Host 名称（不需要 `@`）。  
HostName、User、Port、IdentityFile 自动读取。

```bash
SSH_SERVICES="production|password;db:db-server|"
```

- `|` 后面不填凭据时，将使用 config 中的 IdentityFile。
- `[名称:]config_host` — 可在 config Host 名前加自定义显示名。

### 自动导入所有 config 主机

设置 `$config` 即可自动导入 `~/.ssh/config` 中所有同时包含 User 和 IdentityFile 的 Host：

```bash
SSH_SERVICES="$config"
# 也可与普通条目混用：
SSH_SERVICES="$config;extra:root@other.host|password"
```

修改 config 文件后，下一次工具调用自动生效，**无需重启 MCP**。

### 可选环境变量

| 变量 | 默认值 | 说明 |
|----------|---------|------|
| `SSH_TIMEOUT` | `15000` | 连接超时（毫秒） |
| `SSH_LARGE_FILE_MB` | `10` | 超过此大小（MB）的文件跳过备份/回收站 |
| `SSH_DEBUG` | — | 设为 `true` 开启调试日志（输出到 stderr，仅终端可见） |

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
| `backup_status` | — | 查看所有服务器的备份和回收站磁盘占用 |

### 命令执行

| 工具 | 参数 | 说明 |
|------|------|------|
| `exec` | `server`, `command`, `[timeout]`, `[pty]`, `[sudo_password]` | 执行任意 shell 命令。`timeout` 限制执行时间（秒）。`pty: true` 分配虚拟终端（用于 apt/tmux 等）。`sudo_password` 自动通过 `sudo -S` 执行（隐式启用 PTY）。读文件请用 `read_file`，编辑文件请用 `update_file`。 |

### 文件传输

| 工具 | 参数 | 说明 |
|------|------|------|
| `scp_upload` | `server`, `local_path`, `remote_path` | 上传本地文件到远程服务器 |
| `scp_download` | `server`, `remote_path`, `local_path` | 从远程服务器下载文件。快速查看文件内容建议用 `read_file`。 |

### 文件操作

| 工具 | 参数 | 说明 |
|------|------|------|
| `read_file` | `server`, `remote_path`, `[offset]`, `[limit]` | 读取远程文件内容，支持按行范围读取（offset 从 1 开始） |
| `write_file` | `server`, `remote_path`, `content` | 创建或覆盖文件，自动轮转备份 |
| `update_file` | `server`, `remote_path`, `search`+`replace`+`[replace_all]` **或** `line`+`content`+`[position]` | 编辑已有文件：搜索替换（全部或首次，通过 `replace_all: false` 控制），或行操作（替换、插入前后、删除范围）。修改前自动备份。 |
| `sftp_rm` | `server`, `remote_path` | 删除文件/目录，小文件（默认 ≤10MB）移入回收站而非永久删除 |
| `sftp_stat` | `server`, `remote_path` | 查看文件/目录元数据：类型、大小、权限、修改时间、uid/gid |

## 备份 & 回收站

- **write_file / update_file**：修改前自动轮转备份（`.bak.1` ← `.bak.2` ← `.bak.3`），存储于 `~/.mcp-ssh/backups/<服务器>/<路径>`
- **sftp_rm**：≤10MB 的文件（可通过 `SSH_LARGE_FILE_MB` 配置）移入 `~/.mcp-ssh/trash/` 而非永久删除
- **大文件跳过**：超过阈值的文件跳过备份/回收站，并明确提示
- **优雅降级**：备份或回收站操作失败时，主操作仍继续执行并给出警告

随时使用 `backup_status` 查看磁盘占用。
