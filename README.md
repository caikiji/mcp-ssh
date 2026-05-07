# @caikiji/mcp-ssh

MCP server for SSH remote execution, file transfer, and file editing with automatic backup/trash management and `~/.ssh/config` integration.

## Installation

```bash
npm install -g @caikiji/mcp-ssh
```

## Configuration

### SSH_SERVICES

Register one or more servers via the `SSH_SERVICES` environment variable.  
Multiple servers are separated by `;`.

**Format:** `[name:]user@host[:port]|credential`

```
SSH_SERVICES="web:root@192.168.1.100:22|/path/to/id_rsa;db:deploy@db.internal|db_password"
```

- **name** — optional display name in tools (defaults to host). Duplicate names get an auto-increment suffix.
- **port** — optional, defaults to 22.
- **credential** — if it's an existing file path, used as SSH private key; otherwise treated as password.

### Using ~/.ssh/config

Refer to any Host defined in `~/.ssh/config` by name (no `@` needed).  
HostName, User, Port, and IdentityFile are read automatically.

```bash
SSH_SERVICES="production|password;db:db-server|"
```

- `|` with empty credential uses `IdentityFile` from the config entry.
- `[name:]config_host` — optional display name before the config Host name.

### Auto-import all config hosts

Set `$config` to import every `~/.ssh/config` Host that has both User and IdentityFile:

```bash
SSH_SERVICES="$config"
# Mixed with regular entries:
SSH_SERVICES="$config;extra:root@other.host|password"
```

Config changes take effect on the next tool call — no MCP restart needed.

### Optional environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SSH_TIMEOUT` | `15000` | Connection timeout in milliseconds |
| `SSH_LARGE_FILE_MB` | `10` | Files larger than this (MB) skip backup/trash |
| `SSH_DEBUG` | — | Set to `true` to enable debug logging to stderr |

### MCP Client Config

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
| `backup_status` | — | Show disk usage for backups and trash across all servers |

### Command Execution

| Tool | Arguments | Description |
|------|-----------|-------------|
| `exec` | `server`, `command`, `[timeout]`, `[pty]`, `[sudo_password]` | Run any shell command. `timeout` limits execution (seconds). `pty: true` allocates a TTY for apt/tmux/etc. `sudo_password` runs via `sudo -S` automatically (implicitly enables PTY). Not for file reading (use `read_file`) or editing (use `update_file`). |

### File Transfer

| Tool | Arguments | Description |
|------|-----------|-------------|
| `scp_upload` | `server`, `local_path`, `remote_path` | Upload a local file via SFTP |
| `scp_download` | `server`, `remote_path`, `local_path` | Download a remote file via SFTP. For quick reads, use `read_file` instead. |

### File Operations

| Tool | Arguments | Description |
|------|-----------|-------------|
| `read_file` | `server`, `remote_path`, `[offset]`, `[limit]` | Read file content with optional line range (offset 1-indexed). |
| `write_file` | `server`, `remote_path`, `content` | Create or overwrite a file with automatic rotational backup. |
| `update_file` | `server`, `remote_path`, `search`+`replace`+`[replace_all]` **or** `line`+`content`+`[position]` | Edit an existing file: search/replace (all or first via `replace_all: false`), or line operations (replace, insert before/after, delete range). Backup created before modification. |
| `sftp_rm` | `server`, `remote_path` | Remove file/directory with trash protection. Small files (≤10MB by default) move to `~/.mcp-ssh/trash/` instead of permanent deletion. |
| `sftp_stat` | `server`, `remote_path` | Get file/directory metadata: type, size, permissions, modification time, uid/gid. |

## Backup & Trash

- **write_file / update_file**: before modifying, the original is backed up with rotational retention (`.bak.1` ← `.bak.2` ← `.bak.3`) under `~/.mcp-ssh/backups/<server>/<path>`.
- **sftp_rm**: files ≤10MB (configurable via `SSH_LARGE_FILE_MB`) move to `~/.mcp-ssh/trash/<server>/<path>.<timestamp>` instead of permanent deletion.
- **Large file skip**: files exceeding the threshold skip backup/trash with a clear notification.
- **Graceful degradation**: if backup or trash fails, operations proceed with a warning.

Use `backup_status` to check disk usage at any time.
