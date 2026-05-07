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
const fileLocks = new Map();
const lockGen = new Map();
async function withFileLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve();
  const gen = (lockGen.get(key) || 0) + 1;
  lockGen.set(key, gen);
  const next = prev.then(fn, fn);
  fileLocks.set(key, next.then(() => {}, () => {}));
  next.finally(() => {
    if (lockGen.get(key) === gen) {
      fileLocks.delete(key);
      lockGen.delete(key);
    }
  });
  return next;
}

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

    const credPath = path.resolve(cfg.credential.replace(/^~/, LOCAL_HOME()));
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
      debug(`connection error [${cfg.host}:${cfg.port}]: ${err.code || err.message}${isRetryable(err) ? "" : " (not transient, retrying anyway)"}`);
      if (attempt < 2) {
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
        try { conn.end(); } catch (e) { debug(`conn.end error on timeout: ${e.message}`); }
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
      stream.on("error", (e) => debug(`exec stream error: ${e.message}`));
      stream.stderr.on("error", (e) => debug(`exec stderr error: ${e.message}`));

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
      sftp.on("error", (e) => debug(`SFTP channel error: ${e.message}`));
      resolve(sftp);
    });
  });
}

function sftpMkdir(sftp, dirPath) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => {
      if (err && err.code === 12) resolve();
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
  const cleanPath = targetPath.replace(/\/+$/, "");
  const stat = await sftpStat(sftp, cleanPath);
  if (stat.isDirectory()) {
    let entries;
    try { entries = await sftpReaddir(sftp, cleanPath); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      await removeRecursive(sftp, cleanPath + "/" + entry.filename);
    }
    await sftpRmdir(sftp, cleanPath);
  } else {
    await sftpUnlink(sftp, cleanPath);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

async function classifyPathError(sftp, targetPath) {
  // Distinguish "parent dir missing" from "file itself missing"
  const parent = path.dirname(targetPath);
  try {
    await sftpStat(sftp, parent);
    return `No such file or directory: "${targetPath}"`;
  } catch {
    return `Parent directory does not exist: "${parent}" (while accessing "${targetPath}")`;
  }
}

function permString(mode, isDir) {
  const t = isDir ? 'd' : '-';
  const rwx = (n) => ((n & 4) ? 'r' : '-') + ((n & 2) ? 'w' : '-') + ((n & 1) ? 'x' : '-');
  return t + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
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
      description: "List configured servers with address and auth type. Use first to discover available servers.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "exec",
      description: "Run a shell command. NOT for reading files (use read_file) or editing (use update_file). Set sudo_password for sudo, pty for TTY.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          command: { type: "string", description: "Command to execute" },
          timeout: { type: "number", description: "Max execution time (seconds). Use for commands that may hang." },
          pty: { type: "boolean", description: "Allocate TTY. Set true for apt, tmux, etc." },
          sudo_password: { type: "string", description: "Sudo password. Sends via stdin (no PTY needed). Combine with pty:true if command needs TTY." },
        },
        required: ["server", "command"],
      },
    },
    {
      name: "scp_upload",
      description: "Upload a local file. File must exist locally. To download URL to server directly, use exec + curl.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          local_path: { type: "string", description: "Absolute path to the local file" },
          remote_path: { type: "string", description: "Absolute destination path on server" },
        },
        required: ["server", "local_path", "remote_path"],
      },
    },
    {
      name: "scp_download",
      description: "Download a remote file to local machine. For quick reads without saving, use read_file.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path of the remote file" },
          local_path: { type: "string", description: "Absolute path to save locally" },
        },
        required: ["server", "remote_path", "local_path"],
      },
    },
    {
      name: "read_file",
      description: "Read a remote file as text. Supports offset (1-indexed) and limit for partial reads. NOT for binary files (use scp_download).",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to the remote file" },
          offset: { type: "number", description: "Start line (1-indexed). Omit to read from beginning." },
          limit: { type: "number", description: "Max lines to return. Omit to read all." },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file. Auto-backup before overwrite (≤10MB). Set mode:append to add content to end. Backups: ~/.mcp-ssh/backups/<s>/<p>.bak.N. Check usage via exec du. NOT for editing (use update_file).",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to write to" },
          content: { type: "string", description: "Full file content" },
          mode: { type: "string", description: "write (default) or append. append adds content to end of file." },
        },
        required: ["server", "remote_path", "content"],
      },
    },
    {
      name: "rm",
      description: "Remove a file or directory. Small files (≤10MB) go to trash (recoverable): ~/.mcp-ssh/trash/<s>/<p>.<ts>. Larger files and directories are permanently deleted.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to remove" },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "stat",
      description: "Get file/dir metadata: type, size, permissions, mtime, uid/gid. To list dir contents, use exec ls.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to stat" },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "update_file",
      description: "Edit an existing file. Mode A: search+replace (replace_all:false for first-only). Mode B: line ops (replace, insert before/after, delete by number). Auto-backup. Backups: ~/.mcp-ssh/backups/<s>/<p>.bak.N. NOT for new files (use write_file).",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to the remote file" },
          search: { type: "string", description: "[A] Text to find. replace_all:true (default) replaces all, false replaces first." },
          replace: { type: "string", description: "[A] Replacement text. Empty string deletes matched text." },
          replace_all: { type: "boolean", description: "[A] true=replace all (default), false=replace first only." },
          line: { type: "number", description: "[B] Line number (1-indexed). Combine with content/position/end_line." },
          end_line: { type: "number", description: "[B] End line for range deletion (with line, no content)." },
          content: { type: "string", description: "[B] New content for line ops." },
          position: { type: "string", description: "[B] 'before' or 'after' line. Defaults to replacing the line." },
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
      if (!args.command || typeof args.command !== "string" || !args.command.trim()) {
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
      let text = await withSftp(async (conn, sftp) => {
        const stat = await sftpStat(sftp, args.remote_path).catch(() => null);
        if (stat?.isDirectory?.()) {
          return `IS_DIRECTORY: ${args.remote_path}\nTo list contents use: exec(server: "${args.server}", command: "ls ${args.remote_path.replace(/ /g, '\\ ')}")`;
        }
        const data = await sftpReadFile(sftp, args.remote_path);
        return data.toString("utf8");
      });
      if (text.startsWith("IS_DIRECTORY:")) text = text.slice(14);
      else if (args.offset !== undefined && args.offset !== null) {
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
      if (args.mode && !["write", "append"].includes(args.mode)) {
        return { isError: true, content: [{ type: "text", text: `'mode' must be "write" or "append", got "${args.mode}".` }] };
      }
      const result = await withFileLock(`${args.server}:${args.remote_path}`, async () => {
        return await withHomeAndSftp(async (conn, sftp, homeDir) => {
        let notes = [];
        let content = args.content;

        if (args.mode === "append") {
          try {
            const existing = await sftpReadFile(sftp, args.remote_path);
            content = existing.toString("utf8") + args.content;
            notes.push("Appended to file");
          } catch {
            // File does not exist, treat as write
            notes.push("File did not exist, created new");
          }
        }

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
        const parentDir = path.dirname(args.remote_path);
        if (parentDir !== "/") await ensureDirRecursive(sftp, parentDir);
        await sftpWriteFile(sftp, args.remote_path, content);
        return notes;
      });
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

    const result = await withFileLock(`${args.server}:${args.remote_path}`, async () => {
      return await withHomeAndSftp(async (conn, sftp, homeDir) => {
        let original;
        try { original = (await sftpReadFile(sftp, args.remote_path)).toString("utf8"); }
        catch (err) {
          if ((err?.message || "").match(/no such file|not found/i)) {
            throw new Error(await classifyPathError(sftp, args.remote_path));
          }
          throw err;
        }
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
          const hasTrailingNL = original.endsWith("\n");
          const src = hasTrailingNL ? original.slice(0, -1) : original;
          const fileLines = src.split("\n");
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
          if (hasTrailingNL) modified += "\n";
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
    });

    return { content: [{ type: "text", text: result.notes.join("; ") }] };
  }

  // ----- rm / sftp_rm -----
  if (name === "rm" || name === "sftp_rm") {
    const result = await withFileLock(`${args.server}:${args.remote_path}`, async () => {
      return await withHomeAndSftp(async (conn, sftp, homeDir) => {
        let notes = [];
        const isDir = await sftpStat(sftp, args.remote_path).then((s) => s.isDirectory()).catch(() => false);

        if (isDir) {
          notes.push("Directories are not backed up — deleting permanently");
          await removeRecursive(sftp, args.remote_path);
          notes.push(`Removed directory: ${args.remote_path}`);
          return notes;
        }

        let stat;
        try { stat = await sftpStat(sftp, args.remote_path); }
        catch (err) { return [await classifyPathError(sftp, args.remote_path)]; }
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
    });

    return { content: [{ type: "text", text: result.join("\n") }] };
  }

  if (name === "stat" || name === "sftp_stat") {
      const result = await withSftp(async (conn, sftp) => {
        const stat = await sftpStat(sftp, args.remote_path);
        const type = stat.isDirectory() ? "directory" : "file";
        const perms = (stat.mode ? permString(stat.mode, stat.isDirectory()) : "?");
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
  process.on("uncaughtException", (err) => {
    console.error("[mcp-ssh] UNCAUGHT:", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[mcp-ssh] UNHANDLED REJECTION:", err?.stack || err);
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
