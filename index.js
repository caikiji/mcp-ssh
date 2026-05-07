#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "ssh2";
import fs from "fs";
import path from "path";
import sshConfig from "ssh-config";

const LARGE_FILE_THRESHOLD = (parseInt(process.env.SSH_LARGE_FILE_MB || "10", 10) || 10) * 1024 * 1024;
const BACKUP_DIR_NAME = ".mcp-ssh";
const LARGE_MB = LARGE_FILE_THRESHOLD / (1024 * 1024);
const SSH_TIMEOUT = parseInt(process.env.SSH_TIMEOUT || "15000", 10);
const DEBUG = process.env.SSH_DEBUG === "true" || process.env.SSH_DEBUG === "1";
const debug = DEBUG ? (...args) => console.error("[mcp-ssh]", ...args) : () => {};
const LOCAL_HOME = () => process.env.HOME || "/root";

function parseServers() {
  const raw = process.env.SSH_SERVICES || "";
  if (!raw) return {};

  const servers = {};
  const parts = raw.split(";").filter(Boolean);

  let configCache;
  function getConfig() {
    if (configCache) return configCache;
    const configPath = path.join(LOCAL_HOME(), ".ssh", "config");
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      configCache = sshConfig.parse(raw);
      debug(`loaded ~/.ssh/config (${configCache.length} directives)`);
    } catch {
      debug(`no ~/.ssh/config found`);
      configCache = [];
    }
    return configCache;
  }

  for (const part of parts) {
    if (part === "$config") {
      // Auto-import all Host entries from ~/.ssh/config
      const cfg = getConfig();
      for (const entry of cfg) {
        if (entry.param !== "Host") continue;
        const hosts = entry.value.split(/\s+/).filter((h) => !h.includes("*") && !h.includes("?"));
        for (const configHost of hosts) {
          const val = (key) => { const n = entry.config?.find((d) => d.param === key); return n ? n.value : undefined; };
          const host = val("HostName");
          if (!host) continue;
          const user = val("User");
          if (!user) continue;
          const port = parseInt(val("Port") || "22", 10);
          const identityFile = val("IdentityFile");
          if (!identityFile) continue;
          const credential = path.resolve(identityFile.replace(/^~/, LOCAL_HOME()));
          let name = configHost;
          if (servers[name]) { let i = 2; while (servers[`${name}-${i}`]) i++; name = `${name}-${i}`; }
          debug(`auto-imported config host: ${name} (${user}@${host}:${port})`);
          servers[name] = { user, host, port, credential };
        }
      }
      continue;
    }

    const pipeIdx = part.indexOf("|");
    if (pipeIdx === -1) throw new Error(`Missing | separator in entry: ${part}`);

    const connStr = part.substring(0, pipeIdx);
    const credential = part.substring(pipeIdx + 1);

    let name, user, host, port = 22;

    const atIdx = connStr.indexOf("@");
    if (atIdx === -1) {
      // ~/.ssh/config host reference: [name:]config_host
      const colonIdx = connStr.indexOf(":");
      const configHost = colonIdx !== -1 ? connStr.substring(colonIdx + 1) : connStr;
      name = colonIdx !== -1 ? connStr.substring(0, colonIdx) : null;

      const cfg = getConfig().find((d) => d.param === "Host" && d.value.split(/\s+/).some((h) => h === configHost));
      if (!cfg) throw new Error(`SSH config host "${configHost}" not found in ~/.ssh/config`);

      const val = (key) => { const n = cfg.config?.find((d) => d.param === key); return n ? n.value : undefined; };

      host = val("HostName");
      user = val("User");
      const cfgPort = val("Port");
      if (cfgPort) port = parseInt(cfgPort, 10);
      name = name || configHost;

      if (!host) throw new Error(`HostName missing for config host "${configHost}"`);
      if (!user) throw new Error(`User missing for config host "${configHost}". Specify User in ~/.ssh/config.`);

      // If no credential provided, use IdentityFile from config
        if (!credential) {
          const identityFile = val("IdentityFile");
          if (identityFile) {
            const resolved = identityFile.replace(/^~/, LOCAL_HOME());
            const finalPath = path.resolve(resolved);
            name = name || configHost;
            if (servers[name]) { let i = 2; while (servers[`${name}-${i}`]) i++; name = `${name}-${i}`; }
            servers[name] = { user, host, port, credential: finalPath };
            debug(`config host "${configHost}" (IdentityFile) → ${name}`);
            continue;
          }
          throw new Error(`No credential and no IdentityFile for config host "${configHost}"`);
        }
    } else {
      const beforeAt = connStr.substring(0, atIdx);
      const afterAt = connStr.substring(atIdx + 1);

      const colonBefore = beforeAt.indexOf(":");
      if (colonBefore !== -1) {
        name = beforeAt.substring(0, colonBefore);
        user = beforeAt.substring(colonBefore + 1);
      } else {
        user = beforeAt;
        name = null;
      }

      const colonAfter = afterAt.indexOf(":");
      if (colonAfter !== -1) {
        host = afterAt.substring(0, colonAfter);
        port = parseInt(afterAt.substring(colonAfter + 1), 10);
      } else {
        host = afterAt;
      }

      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port in entry: ${part}`);
      }

      name = name || host;
    }

    if (servers[name]) {
      let i = 2;
      while (servers[`${name}-${i}`]) i++;
      name = `${name}-${i}`;
    }

    servers[name] = { user, host, port, credential };
  }

  return servers;
}

function isRetryable(err) {
  const c = err?.code || "";
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(c);
}

function classifyError(err, cfg) {
  const c = err?.code || "";
  const m = err?.message || String(err);
  const addr = `${cfg.user}@${cfg.host}:${cfg.port}`;
  if (c === "ECONNREFUSED" || m.includes("Connection refused"))
    return new Error(`${addr} — connection refused. Is the SSH port open and reachable?`);
  if (c === "ETIMEDOUT" || m.includes("timed out"))
    return new Error(`${addr} — connection timed out after ${SSH_TIMEOUT}ms. Check network/firewall.`);
  if (c === "ECONNRESET" || m.includes("Connection reset"))
    return new Error(`${addr} — connection reset by remote host.`);
  if (c === "EAI_AGAIN" || m.includes("getaddrinfo") || m.includes("ENOTFOUND"))
    return new Error(`${addr} — host not found (DNS resolution failed).`);
  if (m.includes("All configured authentication methods failed") || m.includes("Authentication failed"))
    return new Error(`${addr} — authentication failed. Check your password or SSH key.`);
  if (m.includes("No compatible signature") || m.includes("handshake"))
    return new Error(`${addr} — SSH handshake failed. The server may use an incompatible SSH version or algorithm.`);
  if (m.includes("Cannot read private key") || m.includes("bad permissions"))
    return new Error(`${addr} — SSH key error. Check key file format and permissions (should be 600).`);
  return new Error(`${addr} — ${m}`);
}

function connect(cfg, attempt = 1) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const config = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      readyTimeout: SSH_TIMEOUT,
      timeout: SSH_TIMEOUT,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };

    if (!cfg.credential) {
      reject(new Error(`No credential provided for ${cfg.user}@${cfg.host}. Set a password, key path, or configure IdentityFile in ~/.ssh/config.`));
      return;
    }

    const credPath = path.resolve(cfg.credential);
    if (fs.existsSync(credPath)) {
      try {
        config.privateKey = fs.readFileSync(credPath, "utf8");
      } catch {
        reject(new Error(`Failed to read key file: ${credPath}. Check file permissions.`));
        return;
      }
    } else {
      config.password = cfg.credential;
    }

    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const authType = fs.existsSync(path.resolve(cfg.credential)) ? "key" : "password";
    debug(`connecting to ${cfg.user}@${cfg.host}:${cfg.port} (${authType}), attempt ${attempt}`);

    conn.on("ready", () => {
      debug(`connected to ${cfg.host}:${cfg.port}`);
      finish(resolve, conn);
    });
    conn.on("error", (err) => {
      debug(`connection error [${cfg.host}:${cfg.port}]: ${err.code || err.message}`);
      if (attempt < 2 && isRetryable(err)) {
        debug(`retrying ${cfg.host}:${cfg.port} in 1s`);
        setTimeout(() => connect(cfg, attempt + 1).then(finish.bind(null, resolve), finish.bind(null, reject)), 1000);
      } else {
        finish(reject, classifyError(err, cfg));
      }
    });
    conn.connect(config);
  });
}

function execOnConn(conn, command, timeoutSec, opts = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    let started = Date.now();
    const cleanup = () => clearTimeout(timer);

    const trimmed = command.length > 200 ? command.substring(0, 200) + "..." : command;
    let label = `exec: ${trimmed}`;
    if (timeoutSec) label += ` (timeout: ${timeoutSec}s)`;
    if (opts.pty) label += " (pty)";
    if (opts.sudoPassword) label += " (sudo)";
    debug(label);

    if (timeoutSec && timeoutSec > 0) {
      timer = setTimeout(() => {
        conn.end();
        debug(`exec TIMEOUT after ${timeoutSec}s: ${trimmed}`);
        reject(new Error(`Command timed out after ${timeoutSec}s: ${command.length > 100 ? command.substring(0, 100) + '...' : command}`));
      }, timeoutSec * 1000);
    }

    let actualCommand = command;
    if (opts.sudoPassword) {
      actualCommand = `sudo -S ${command}`;
    }

    conn.exec(actualCommand, opts.pty ? { pty: true } : {}, (err, stream) => {
      if (err) { cleanup(); debug(`exec error: ${err.message}`); reject(err); return; }
      let stdout = "", stderr = "";

      if (opts.sudoPassword) {
        stream.stdin.write(opts.sudoPassword + "\n");
      }

      stream.on("close", (code, signal) => {
        cleanup();
        const elapsed = Date.now() - started;
        debug(`exec done (${elapsed}ms, exit: ${code}): ${trimmed}`);
        resolve({ stdout, stderr, code, signal });
      });
      stream.on("data", (data) => { stdout += data.toString(); });
      stream.stderr.on("data", (data) => { stderr += data.toString(); });
    });
  });
}

function sftpOpen(conn) {
  return new Promise((resolve, reject) => {
    debug("opening SFTP channel");
    conn.sftp((err, sftp) => {
      if (err) { debug(`SFTP open error: ${err.message}`); reject(err); return; }
      debug("SFTP channel opened");
      resolve(sftp);
    });
  });
}

function sftpMkdir(sftp, dirPath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => {
      if (err && err.code === 4) resolve();
      else if (err) reject(err);
      else resolve();
    });
  });
}

function sftpStat(sftp, filePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(filePath, (err, stat) => {
      if (err) reject(err);
      else resolve(stat);
    });
  });
}

function sftpReadFile(sftp, filePath) {
  return new Promise((resolve, reject) => {
    sftp.readFile(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function sftpWriteFile(sftp, filePath, data) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(filePath, data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpRename(sftp, from, to) {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpUnlink(sftp, filePath) {
  return new Promise((resolve, reject) => {
    sftp.unlink(filePath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpRmdir(sftp, dirPath) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(dirPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpReaddir(sftp, dirPath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dirPath, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });
}

async function ensureDirRecursive(sftp, dirPath) {
  const parts = dirPath.replace(/^\//, "").replace(/\/$/, "").split("/");
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    try { await sftpMkdir(sftp, current); } catch {}
  }
}

async function removeRecursive(sftp, targetPath) {
  const stat = await sftpStat(sftp, targetPath);
  if (stat.isDirectory()) {
    const entries = await sftpReaddir(sftp, targetPath);
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      await removeRecursive(sftp, targetPath + "/" + entry.filename);
    }
    await sftpRmdir(sftp, targetPath);
  } else {
    await sftpUnlink(sftp, targetPath);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}


function timestamp() {
  const d = new Date();
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${Y}${M}${D}_${h}${m}${s}`;
}

async function doBackupRotation(sftp, filePath, backupBase) {
  try {
    await ensureDirRecursive(sftp, path.dirname(backupBase));
    try { await sftpRename(sftp, backupBase + ".bak.2", backupBase + ".bak.3"); } catch {}
    try { await sftpRename(sftp, backupBase + ".bak.1", backupBase + ".bak.2"); } catch {}
    const data = await sftpReadFile(sftp, filePath);
    await sftpWriteFile(sftp, backupBase + ".bak.1", data);
    debug(`backup saved: ${backupBase}.bak.1`);
    return true;
  } catch (err) {
    debug(`backup failed: ${err.message}`);
    return false;
  }
}

async function doTrash(sftp, filePath, trashPath) {
  try {
    await ensureDirRecursive(sftp, path.dirname(trashPath));
    await sftpRename(sftp, filePath, trashPath);
    debug(`trashed: ${filePath} → ${trashPath}`);
    return true;
  } catch (err) {
    debug(`trash failed: ${err.message}`);
    return false;
  }
}

const mcpServer = new Server(
  { name: "mcp-ssh", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_servers",
      description: "List all configured SSH servers with address and auth type (key or password). Use this first to discover which servers are available before using other tools.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "exec",
      description: "Run any shell command on a remote server and return stdout, stderr, and exit code. Use for: running scripts, checking system status, starting/stopping services, package management, or any command-line operation. NOT for reading file contents (use read_file) or editing files (use update_file / write_file). For commands requiring sudo, set sudo_password (sends password via stdin, no PTY needed). For commands needing a TTY (apt, screen, etc.), set pty: true.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name as shown by list_servers" },
          command: { type: "string", description: "Shell command to execute (e.g. 'ls -la /etc', 'systemctl status nginx', 'df -h')" },
          timeout: { type: "number", description: "Maximum execution time in seconds. Use for commands that might hang (e.g. 'apt upgrade', long scripts)." },
          pty: { type: "boolean", description: "Allocate a pseudo-terminal (PTY). Set to true for commands that require a TTY (sudo without password, apt, tmux, etc.)." },
          sudo_password: { type: "string", description: "Password for sudo. When set, the command runs via 'sudo -S' and the password is sent securely via stdin (no PTY echo). Combine with pty: true if the command itself needs a TTY." },
        },
        required: ["server", "command"],
      },
    },
    {
      name: "scp_upload",
      description: "Upload a local file to a remote server via SFTP. The local file must exist on this machine. Use for: deploying configs, copying scripts, transferring assets. For downloading files from a URL directly to the remote server, use exec with curl/wget instead.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          local_path: { type: "string", description: "Absolute path to the local file to upload" },
          remote_path: { type: "string", description: "Absolute destination path on the remote server" },
        },
        required: ["server", "local_path", "remote_path"],
      },
    },
    {
      name: "scp_download",
      description: "Download a file from a remote server to the local machine via SFTP. For quickly reading a small file without creating a local copy, use read_file instead (it returns the content directly).",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path of the file on the remote server to download" },
          local_path: { type: "string", description: "Absolute path where to save the file locally" },
        },
        required: ["server", "remote_path", "local_path"],
      },
    },
    {
      name: "read_file",
      description: "Read a remote file and return its content as text. Supports optional offset (starting line, 1-indexed) and limit (max lines) for partial reads of large files. Best for viewing config files, logs, source code, and text output. For binary files (images, archives), use scp_download instead.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to the remote file to read" },
          offset: { type: "number", description: "Starting line number (1-indexed). Omit to read from the beginning." },
          limit: { type: "number", description: "Maximum number of lines to return. Omit to read all lines from offset to end." },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "write_file",
      description: "Create a new file or overwrite an existing remote file with the given content. If the file already exists and is smaller than 10MB (default, configurable via SSH_LARGE_FILE_MB), the original is automatically backed up (rotational: keeps last 3 versions under ~/.mcp-ssh/backups/<server>/). For editing an existing file (search/replace or line operations), use update_file instead to avoid rewriting the entire file.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path on the remote server to write to" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["server", "remote_path", "content"],
      },
    },
    {
      name: "sftp_rm",
      description: "Remove a file or directory from a remote server. Files smaller than 10MB (default, configurable via SSH_LARGE_FILE_MB) are moved to ~/.mcp-ssh/trash/<server>/<path>.<timestamp> instead of permanent deletion (can be restored manually). Larger files and directories are permanently deleted with a warning. The trash mechanism requires write permission on the remote home directory.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path of the file or directory to remove" },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "sftp_stat",
      description: "Get metadata for a remote file or directory: type (file/dir), size, permissions, modification time, uid/gid. Use this to check if a path exists, compare file sizes, or verify permissions before reading or editing. For listing directory contents, use exec with ls instead.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path of the file or directory to stat" },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "backup_status",
      description: "Show disk usage statistics for backups (~/.mcp-ssh/backups/) and trash (~/.mcp-ssh/trash/) across all configured servers. Reports file count and total size for each directory per server. Use this to monitor how much disk space the protection mechanism is using.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "update_file",
      description: "Edit an existing remote file in-place. Two mutually exclusive modes: (A) search+replace — replaces ALL occurrences of 'search' text with 'replace' text; (B) line operations — replace a specific line, insert before/after a line, or delete line(s) by number. Automatically creates a rotational backup before modification. For creating NEW files, use write_file instead. For reading files, use read_file.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to the remote file to edit" },
          search: { type: "string", description: "[Mode A] Text to find. When replace_all is true (default), ALL occurrences are replaced. When false, only the first match is replaced." },
          replace: { type: "string", description: "[Mode A] Replacement text. Omit or set empty string to delete matched text." },
          replace_all: { type: "boolean", description: "[Mode A] When true (default), replace all occurrences of search text. When false, replace only the first occurrence." },
          line: { type: "number", description: "[Mode B] Line number to act on (1-indexed). Combine with content/position/end_line." },
          end_line: { type: "number", description: "[Mode B] End line for range deletion (used with 'line', no 'content'). Deletes lines from 'line' to 'end_line' inclusive." },
          content: { type: "string", description: "[Mode B] New content for line replacement, or text to insert before/after a line." },
          position: { type: "string", description: "[Mode B] Insert position: 'before' or 'after' the specified line. Defaults to replacing the line." },
        },
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const servers = parseServers();

  if (name === "list_servers") {
    const names = Object.keys(servers);
    const details = names.map((n) => {
      const s = servers[n];
      const cred = fs.existsSync(path.resolve(s.credential)) ? "key" : "password";
      return `${n}: ${s.user}@${s.host}:${s.port} (${cred})`;
    });
    return {
      content: [{ type: "text", text: details.length ? details.join("\n") : "No servers configured. Set SSH_SERVICES environment variable." }],
    };
  }

  if (name === "backup_status") {
    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
      return { content: [{ type: "text", text: "No servers configured. Set SSH_SERVICES environment variable." }] };
    }

    const results = await Promise.all(serverNames.map(async (sName) => {
      const cfg = servers[sName];
      try {
        const conn = await connect(cfg);
        try {
          const cmd = [
            'STAT=~/.mcp-ssh',
            'for dir in backups trash; do',
            'p="$STAT/$dir"',
            'if [ -d "$p" ]; then',
            'files=$(find "$p" -type f 2>/dev/null | wc -l)',
            'size=$(du -sb "$p" 2>/dev/null | cut -f1)',
            'echo "${dir}_files=$files"',
            'echo "${dir}_size=$size"',
            'else',
            'echo "${dir}_files=0"',
            'echo "${dir}_size=0"',
            'fi',
            'done',
          ].join("\n");

          const result = await execOnConn(conn, cmd);
          if (result.code !== 0) return { server: sName, error: result.stderr || "exec failed" };

          const data = {};
          for (const line of result.stdout.trim().split("\n")) {
            const eq = line.indexOf("=");
            if (eq > 0) data[line.substring(0, eq)] = line.substring(eq + 1);
          }

          return {
            server: sName,
            backups: { files: parseInt(data.backups_files) || 0, size: parseInt(data.backups_size) || 0 },
            trash: { files: parseInt(data.trash_files) || 0, size: parseInt(data.trash_size) || 0 },
          };
        } finally { conn.end(); }
      } catch (err) {
        return { server: sName, error: err.message };
      }
    }));

    const lines = [];
    for (const r of results) {
      if (r.error) {
        lines.push(`${r.server}: connection failed — ${r.error}`);
      } else {
        const total = r.backups.size + r.trash.size;
        lines.push(`${r.server}:`);
        lines.push(`  backups  ${r.backups.files} file(s), ${formatBytes(r.backups.size)}`);
        lines.push(`  trash    ${r.trash.files} file(s), ${formatBytes(r.trash.size)}`);
        lines.push(`  total    ${formatBytes(total)}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (!args || !args.server) {
    return { isError: true, content: [{ type: "text", text: "Missing required argument: server" }] };
  }

  const sshCfg = servers[args.server];
  if (!sshCfg) {
    const available = Object.keys(servers).join(", ") || "(none)";
    return { isError: true, content: [{ type: "text", text: `Server "${args.server}" not found. Available: ${available}` }] };
  }

  async function withSftp(fn) {
    const conn = await connect(sshCfg);
    const sftp = await sftpOpen(conn);
    try {
      return await fn(conn, sftp);
    } finally {
      try { sftp.end(); } catch {}
      try { conn.end(); } catch {}
    }
  }

  async function withConn(fn) {
    const conn = await connect(sshCfg);
    try {
      return await fn(conn);
    } finally {
      try { conn.end(); } catch {}
    }
  }

  async function withHomeAndSftp(fn) {
    const conn = await connect(sshCfg);
    try {
      const homeResult = await execOnConn(conn, "echo $HOME", 10);
      const homeDir = homeResult.stdout.trim() || "/root";
      const sftp = await sftpOpen(conn);
      try {
        return await fn(conn, sftp, homeDir);
      } finally {
        try { sftp.end(); } catch {}
      }
    } finally {
      try { conn.end(); } catch {}
    }
  }

  const callDesc = args?.remote_path || args?.command || "";
  debug(`tool call: ${name} (server: ${args?.server || "—"}${callDesc ? ", " + callDesc.substring(0, 120) : ""})`);
  const toolStart = Date.now();

  try {
    if (name === "exec") {
      if (!args.command || typeof args.command !== "string") {
        return { isError: true, content: [{ type: "text", text: "Missing or invalid required argument: command must be a non-empty string." }] };
      }
      if (args.timeout !== undefined && args.timeout !== null && (!Number.isFinite(args.timeout) || args.timeout <= 0)) {
        return { isError: true, content: [{ type: "text", text: `'timeout' must be a positive number (seconds), got ${args.timeout}.` }] };
      }
      const timeout = args.timeout !== undefined && args.timeout !== null ? args.timeout : undefined;
      const execOpts = {};
      if (args.sudo_password) execOpts.sudoPassword = args.sudo_password;
      if (args.pty) execOpts.pty = true;
      const result = await withConn(async (conn) => {
        return await execOnConn(conn, args.command, timeout, execOpts);
      });
      const parts = [];
      if (result.stdout) parts.push({ type: "text", text: result.stdout });
      if (result.stderr) parts.push({ type: "text", text: `stderr:\n${result.stderr}` });
      parts.push({ type: "text", text: `exit code: ${result.code}` });
      return { content: parts };
    }

    if (name === "scp_upload") {
      const resolvedLocal = path.resolve(args.local_path);
      if (!fs.existsSync(resolvedLocal)) {
        return { isError: true, content: [{ type: "text", text: `Local file not found: ${resolvedLocal}` }] };
      }
      await withSftp(async (conn, sftp) => {
        await new Promise((resolve, reject) => {
          sftp.fastPut(resolvedLocal, args.remote_path, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
      return { content: [{ type: "text", text: `Uploaded ${resolvedLocal} \u2192 ${sshCfg.user}@${sshCfg.host}:${args.remote_path}` }] };
    }

    if (name === "scp_download") {
      const resolvedLocal = path.resolve(args.local_path);
      await withSftp(async (conn, sftp) => {
        await new Promise((resolve, reject) => {
          sftp.fastGet(args.remote_path, resolvedLocal, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      });
      return { content: [{ type: "text", text: `Downloaded ${sshCfg.user}@${sshCfg.host}:${args.remote_path} \u2192 ${resolvedLocal}` }] };
    }

    if (name === "read_file") {
      const data = await withSftp(async (conn, sftp) => {
        return await sftpReadFile(sftp, args.remote_path);
      });
      let text = data.toString("utf8");
      if (args.offset !== undefined && args.offset !== null) {
        const lines = text.split("\n");
        const start = Math.max(0, args.offset - 1);
        const end = args.limit ? start + args.limit : undefined;
        text = lines.slice(start, end).join("\n");
      } else if (args.limit !== undefined && args.limit !== null) {
        const lines = text.split("\n");
        text = lines.slice(0, args.limit).join("\n");
      }
      return { content: [{ type: "text", text: text }] };
    }

    if (name === "write_file") {
      const result = await withHomeAndSftp(async (conn, sftp, homeDir) => {
        let notes = [];
        try {
          const stat = await sftpStat(sftp, args.remote_path);
          if (stat.size > LARGE_FILE_THRESHOLD) {
            notes.push(`File is large (${formatBytes(stat.size)} > ${LARGE_MB}MB) — skipped backup`);
          } else {
            const backupBase = path.join(homeDir, BACKUP_DIR_NAME, "backups", args.server, args.remote_path.replace(/^\//, ""));
            const ok = await doBackupRotation(sftp, args.remote_path, backupBase);
            if (ok) notes.push(`Backup saved to ~/${BACKUP_DIR_NAME}/backups/${args.server}/...`);
            else notes.push("Backup attempted but failed — proceeding without backup");
          }
        } catch {
          // File does not exist, no backup needed
        }
        await sftpWriteFile(sftp, args.remote_path, args.content);
        return notes;
      });
      const msg = `Written to ${args.remote_path}` + (result.length ? ` (${result.join("; ")})` : "");
      return { content: [{ type: "text", text: msg }] };
    }

    // ----- update_file -----
    if (name === "update_file") {
      const hasSearch = args.search !== undefined && args.search !== null && args.search !== "";
      const hasLine = args.line !== undefined && args.line !== null;
      if (!hasSearch && !hasLine) {
        return { isError: true, content: [{ type: "text", text: "Provide 'search' (search/replace mode) or 'line' (line operation mode). See tool description for details." }] };
      }
      if (hasSearch && hasLine) {
        return { isError: true, content: [{ type: "text", text: "Provide either 'search' or 'line', not both. These modes are mutually exclusive." }] };
      }
      if (hasLine && (!Number.isInteger(args.line) || args.line < 1)) {
        return { isError: true, content: [{ type: "text", text: `'line' must be a positive integer, got ${args.line}.` }] };
      }
      if (args.end_line !== undefined && args.end_line !== null && (!Number.isInteger(args.end_line) || args.end_line < 1)) {
        return { isError: true, content: [{ type: "text", text: `'end_line' must be a positive integer, got ${args.end_line}.` }] };
      }
      if (hasLine && args.end_line && args.line > args.end_line) {
        return { isError: true, content: [{ type: "text", text: `'line' (${args.line}) must be <= 'end_line' (${args.end_line}).` }] };
      }
      if (args.position && !["before", "after"].includes(args.position)) {
        return { isError: true, content: [{ type: "text", text: `'position' must be 'before' or 'after', got "${args.position}".` }] };
      }

      const result = await withHomeAndSftp(async (conn, sftp, homeDir) => {
        const original = (await sftpReadFile(sftp, args.remote_path)).toString("utf8");
        let notes, modified;

        if (hasSearch) {
          const count = original.split(args.search).length - 1;
          if (count === 0) {
            return { notes: [`No matches for "${args.search}"`], skipped: true };
          }
          const replaceAll = args.replace_all !== false;
          modified = replaceAll
            ? original.replaceAll(args.search, args.replace ?? "")
            : original.replace(args.search, args.replace ?? "");
          if (modified === original) {
            return { notes: ["Search text equals replacement — no change needed"], skipped: true };
          }
          notes = [`Replaced ${replaceAll ? count : 1} occurrence(s) of "${args.search}"`];
        } else {
          const fileLines = original.split("\n");
          const n = args.line;
          const maxLine = args.position === "before" ? fileLines.length + 1 : fileLines.length;
          if (n < 1 || n > maxLine) {
            const hint = args.position === "before"
              ? ` (for insert before, line can be up to ${fileLines.length + 1} to append to end)`
              : "";
            return { notes: [`Line ${n} is out of range (file has ${fileLines.length} lines)${hint}`], skipped: true };
          }
          const hasContent = args.content !== undefined && args.content !== null;
          const position = args.position;

          if (hasContent && !args.end_line && !position) {
            fileLines[n - 1] = args.content;
            notes = [`Replaced line ${n}`];
          } else if (hasContent && position === "after") {
            fileLines.splice(n, 0, args.content);
            notes = [`Inserted after line ${n}`];
          } else if (hasContent && position === "before") {
            fileLines.splice(n - 1, 0, args.content);
            notes = [`Inserted before line ${n}`];
          } else if (!hasContent && args.end_line) {
            const removed = fileLines.splice(n - 1, args.end_line - n + 1);
            notes = [`Deleted lines ${n}\u2013${args.end_line} (${removed.length} line(s))`];
          } else if (!hasContent) {
            fileLines.splice(n - 1, 1);
            notes = [`Deleted line ${n}`];
          } else {
            return { notes: ["Invalid line operation parameters"], skipped: true };
          }
          modified = fileLines.join("\n");
        }

        try {
          const stat = await sftpStat(sftp, args.remote_path);
          if (stat.size > LARGE_FILE_THRESHOLD) {
            notes.push(`File is large (${formatBytes(stat.size)} > ${LARGE_MB}MB) — skipped backup`);
          } else {
            const backupBase = path.join(homeDir, BACKUP_DIR_NAME, "backups", args.server, args.remote_path.replace(/^\//, ""));
            const ok = await doBackupRotation(sftp, args.remote_path, backupBase);
            notes.push(ok
              ? `Backup saved to ~/${BACKUP_DIR_NAME}/backups/${args.server}/...`
              : "Backup attempted but failed — proceeding anyway");
          }
        } catch {
          notes.push("Could not stat file for backup — proceeding anyway");
        }

        await sftpWriteFile(sftp, args.remote_path, modified);
        return { notes, skipped: false };
      });

      return { content: [{ type: "text", text: result.notes.join("; ") }] };
    }

    // ----- sftp_rm -----
    if (name === "sftp_rm") {
      const result = await withHomeAndSftp(async (conn, sftp, homeDir) => {
        let notes = [];
        const isDir = await sftpStat(sftp, args.remote_path).then((s) => s.isDirectory()).catch(() => false);

        if (isDir) {
          notes.push("Directories are not backed up — deleting permanently");
          await removeRecursive(sftp, args.remote_path);
          notes.push(`Removed directory: ${args.remote_path}`);
          return notes;
        }

        const stat = await sftpStat(sftp, args.remote_path);
        if (stat.size > LARGE_FILE_THRESHOLD) {
          notes.push(`File is large (${formatBytes(stat.size)} > ${LARGE_MB}MB) — no backup, deleting permanently`);
          await sftpUnlink(sftp, args.remote_path);
          notes.push(`Deleted: ${args.remote_path}`);
          return notes;
        }

        const trashPath = path.join(homeDir, BACKUP_DIR_NAME, "trash", args.server, args.remote_path.replace(/^\//, "") + "." + timestamp());
        const ok = await doTrash(sftp, args.remote_path, trashPath);
        if (ok) {
          notes.push(`Moved to trash: ~/${BACKUP_DIR_NAME}/trash/${args.server}/${args.remote_path.replace(/^\//, "")}.${timestamp()}`);
        } else {
          notes.push("Trash move failed — deleting permanently");
          await removeRecursive(sftp, args.remote_path);
          notes.push(`Removed: ${args.remote_path}`);
        }
        return notes;
      });

      return { content: [{ type: "text", text: result.join("\n") }] };
    }

    if (name === "sftp_stat") {
      const result = await withSftp(async (conn, sftp) => {
        const stat = await sftpStat(sftp, args.remote_path);
        const type = stat.isDirectory() ? "directory" : "file";
        const perms = (stat.mode ? (stat.mode & 0o777).toString(8) : "?") + (stat.isDirectory() ? " (drwxr-xr-x)" : "");
        const mtime = new Date(stat.mtime * 1000).toISOString().replace("T", " ").substring(0, 19);
        return [
          `  ${sshCfg.host}:${args.remote_path}`,
          `  type:       ${type}`,
          `  size:       ${formatBytes(stat.size)} (${stat.size} bytes)`,
          `  mode:       ${perms}`,
          `  modified:   ${mtime}`,
          `  uid/gid:    ${stat.uid}/${stat.gid}`,
        ].join("\n");
      });
      return { content: [{ type: "text", text: result }] };
    }

    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  } catch (err) {
    debug(`tool error (${Date.now() - toolStart}ms): ${err.stack || err.message}`);
    return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
