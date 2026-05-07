<p align="center">
  <br/>
  <h1 align="center">🔌 @caikiji/mcp-ssh</h1>
  <p align="center">MCP server for SSH remote execution, file transfer, file editing<br/>with automatic backup/trash &amp; <code>~/.ssh/config</code> integration</p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@caikiji/mcp-ssh"><img src="https://img.shields.io/npm/v/@caikiji/mcp-ssh?style=flat-square&logo=npm" alt="npm version"/></a>
    <a href="https://www.npmjs.com/package/@caikiji/mcp-ssh"><img src="https://img.shields.io/npm/dm/@caikiji/mcp-ssh?style=flat-square" alt="npm downloads"/></a>
    <a href="https://github.com/caikiji/mcp-ssh"><img src="https://img.shields.io/github/stars/caikiji/mcp-ssh?style=flat-square&logo=github" alt="github stars"/></a>
    <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/文档-中文-blue?style=flat-square" alt="中文文档"/></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js" alt="node version"/>
    <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="license"/>
  </p>
  <p align="center">
    <b><a href="#installation">Installation</a></b>
    ·
    <b><a href="#configuration">Configuration</a></b>
    ·
    <b><a href="#tools">Tools</a></b>
    ·
    <b><a href="#backup--trash">Backup &amp; Trash</a></b>
    ·
    <b><a href="./README.zh-CN.md">中文文档</a></b>
  </p>
  <br/>
</p>

## ✨ Features

- **🔐 SSH via env** — register multiple servers with password or key auth in a single env var
- **📋 Config integration** — use or auto-import `~/.ssh/config` hosts (`$config`)
- **💻 Remote exec** — run commands with optional timeout, PTY, and sudo password support
- **📁 File transfer** — upload/download via SFTP
- **📝 File editing** — read, write, search/replace, line operations with automatic backup
- **🗑️ Trash protection** — deleted files go to `~/.mcp-ssh/trash/` (configurable threshold)
- **📊 Backup stats** — monitor disk usage of backups and trash across all servers
- **🐞 Debug mode** — `SSH_DEBUG=true` for connection/exec/SFTP diagnostics

## Installation

```bash
npm install -g @caikiji/mcp-ssh
```

## Configuration

### `SSH_SERVICES`

Register servers via environment variable. Separate multiple entries with `;`.

```
SSH_SERVICES="web:root@192.168.1.100:22|/path/to/id_rsa;db:deploy@db.internal|db_password"
```

**Format:** `[name:]user@host[:port]|credential`

| Part | Description |
|------|-------------|
| `name` | Optional display name (defaults to host). Duplicates get a numeric suffix. |
| `port` | Optional, defaults to `22`. |
| `credential` | File path → SSH key, otherwise treated as password. |

### Using `~/.ssh/config`

Reference any Host from `~/.ssh/config` by name (no `@` needed):

```bash
SSH_SERVICES="production|password;db:db-server|"
```

- Empty credential (`|` at end) → uses `IdentityFile` from config
- `[name:]config_host` → custom display name

### Auto-import all config hosts (`$config`)

Import every config host that has both **User** and **IdentityFile**:

```bash
SSH_SERVICES="$config"
# Mixed with regular entries:
SSH_SERVICES="$config;extra:root@other.host|password"
```

> Config changes take effect on the next tool call — **no MCP restart required**.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SSH_TIMEOUT` | `15000` | Connection timeout (ms) |
| `SSH_LARGE_FILE_MB` | `10` | Files larger than this (MB) skip backup/trash |
| `SSH_DEBUG` | — | Set to `true` for debug logging to stderr |

### MCP Client config

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

## Tools

### Server Management

| Tool | Arguments | Description |
|------|-----------|-------------|
| `list_servers` | — | List all configured servers with address and auth type |

### Command Execution

| Tool | Arguments | Description |
|------|-----------|-------------|
| `exec` | `server`, `command`, `[timeout]`, `[pty]`, `[sudo_password]` | Run any shell command. `timeout` limits execution (seconds). `pty: true` allocates a TTY for apt/tmux/etc. `sudo_password` runs via `sudo -S <cmd>` (password sent via stdin, no PTY needed). |

### File Transfer

| Tool | Arguments | Description |
|------|-----------|-------------|
| `scp_upload` | `server`, `local_path`, `remote_path` | Upload a local file via SFTP |
| `scp_download` | `server`, `remote_path`, `local_path` | Download a remote file via SFTP |

### File Operations

| Tool | Arguments | Description |
|------|-----------|-------------|
| `read_file` | `server`, `remote_path`, `[offset]`, `[limit]` | Read file with optional line range (offset 1-indexed). Returns friendly message if path is a directory. |
| `write_file` | `server`, `remote_path`, `content`, `[mode]` | Create/overwrite (`mode: "write"`, default) or append (`mode: "append"`) to a file. Auto-backup before overwrite. |
| `update_file` | `server`, `remote_path`, `search`+`replace`+`[replace_all]` **or** `line`+`content`+`[position]` | Edit existing file: search/replace (all or first), or line operations (replace, insert before/after, delete range). Backup before modification. |
| `rm` | `server`, `remote_path` | Remove file/dir with trash protection (≤10MB → trash) |
| `ls` | `server`, `remote_path` | List dir entries or get single file details (name, type, size, mtime, permissions) |

## Backup & Trash

```
~/.mcp-ssh/
├── backups/<server>/<path>.bak.1-3   ← auto-rotated before overwrite
└── trash/<server>/<path>.<timestamp>  ← small files (≤10MB) on delete
```

Check real usage via `exec`:
```
exec server, "du -sh ~/.mcp-ssh"
```

---

<p align="center">
  <a href="./README.zh-CN.md">📖 中文文档</a>
</p>
