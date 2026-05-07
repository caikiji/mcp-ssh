# @caikiji/mcp-ssh

MCP server for SSH remote execution, file transfer, and file editing with automatic backup/trash management.

## Installation

```bash
npm install -g @caikiji/mcp-ssh
```

## Configuration

Set the `SSH_SERVICES` environment variable to register one or more servers:

```
SSH_SERVICES="web:root@192.168.1.100:22|/path/to/id_rsa;db:deploy@db.internal|db_password;dev@dev.box:2222|~/dev_key"
```

Format: `[name:]user@host[:port]|credential`

- **name** — optional, defaults to host. Duplicate names get an auto-increment suffix.
- **port** — optional, defaults to 22.
- **credential** — if it's an existing file path, used as SSH private key; otherwise treated as password.

Separate multiple servers with `;`.

Optional settings:

- **`SSH_TIMEOUT`** — connection timeout in milliseconds (default: `15000`). Increase for slow networks, decrease for quick failure detection.
- **`SSH_LARGE_FILE_MB`** — files larger than this (MB) skip backup/trash (default: `10`).

### MCP Client Config

Add to your MCP client config (e.g. Claude Code, Codex, OpenCode):

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "@caikiji/mcp-ssh"],
      "env": {
        "SSH_SERVICES": "web:root@192.168.1.100|/path/to/key;db:deploy@db.internal|mypassword"
      }
    }
  }
}
```

## Tools

### Server Management

| Tool | Description |
|------|-------------|
| `list_servers` | List all configured servers with address and auth type |
| `backup_status` | Show disk usage for backups and trash across all servers |

### Command Execution

| Tool | Arguments | Description |
|------|-----------|-------------|
| `exec` | `server`, `command`, `[timeout]` | Run a shell command and get stdout/stderr/exit code. `timeout` limits execution time in seconds (use for long-running or risky commands). Use for scripts, service management, package operations. Not for file reading (use `read_file`) or file editing (use `update_file`). |

### File Transfer

| Tool | Arguments | Description |
|------|-----------|-------------|
| `scp_upload` | `server`, `local_path`, `remote_path` | Upload a local file via SFTP |
| `scp_download` | `server`, `remote_path`, `local_path` | Download a remote file via SFTP. For quick reads without saving locally, use `read_file` instead. |

### File Operations

| Tool | Arguments | Description |
|------|-----------|-------------|
| `read_file` | `server`, `remote_path`, `[offset]`, `[limit]` | Read file content with optional line range (offset is 1-indexed). Best for configs, logs, source code. |
| `write_file` | `server`, `remote_path`, `content` | Create or overwrite a file with automatic backup. For editing existing files (search/replace, line ops), use `update_file` instead. |
| `update_file` | `server`, `remote_path`, `search`+`replace`+`[replace_all]` **or** `line`+`content`+`[position]` | Edit an existing file: search/replace all or first occurrence (`replace_all: false` for single), or line operations (replace, insert before/after, delete range). Backup created before modification. |
| `sftp_rm` | `server`, `remote_path` | Remove file/directory with trash protection. Small files (<100MB) move to `~/.mcp-ssh/trash/`. Large files and directories delete permanently with warning. |
| `sftp_stat` | `server`, `remote_path` | Get file/directory metadata: type, size, permissions, modification time, uid/gid. |

## Backup & Trash

Files are automatically protected:

- **write_file / update_file**: before modifying, the original file is backed up with rotational retention (`.bak.1` ← `.bak.2` ← `.bak.3`) under `~/.mcp-ssh/backups/<server>/<path>`.
- **sftp_rm**: small files (≤10MB by default, configurable via `SSH_LARGE_FILE_MB`) are moved to `~/.mcp-ssh/trash/<server>/<path>.<timestamp>` instead of permanent deletion.
- **Large file skip**: files exceeding the threshold skip backup/trash with a clear notification.
- **Graceful degradation**: if backup or trash fails, operations proceed with a warning.

Use `backup_status` to check disk usage at any time.
