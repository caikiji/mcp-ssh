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

const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
const BACKUP_DIR_NAME = ".mcp-ssh";

function parseServers() {
  const raw = process.env.SSH_SERVICES || "";
  if (!raw) return {};

  const servers = {};
  const parts = raw.split(";").filter(Boolean);

  for (const part of parts) {
    const pipeIdx = part.indexOf("|");
    if (pipeIdx === -1) throw new Error(`Missing | separator in entry: ${part}`);

    const connStr = part.substring(0, pipeIdx);
    const credential = part.substring(pipeIdx + 1);

    const atIdx = connStr.indexOf("@");
    if (atIdx === -1) throw new Error(`Missing @ in connection string: ${connStr}`);

    const beforeAt = connStr.substring(0, atIdx);
    const afterAt = connStr.substring(atIdx + 1);

    let name, user;
    const colonBefore = beforeAt.indexOf(":");
    if (colonBefore !== -1) {
      name = beforeAt.substring(0, colonBefore);
      user = beforeAt.substring(colonBefore + 1);
    } else {
      user = beforeAt;
      name = null;
    }

    let host, port = 22;
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

    if (servers[name]) {
      let i = 2;
      while (servers[`${name}-${i}`]) i++;
      name = `${name}-${i}`;
    }

    servers[name] = { user, host, port, credential };
  }

  return servers;
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const config = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      readyTimeout: 15000,
    };

    const credPath = path.resolve(cfg.credential);
    if (fs.existsSync(credPath)) {
      try {
        config.privateKey = fs.readFileSync(credPath, "utf8");
      } catch {
        reject(new Error(`Failed to read key file: ${credPath}`));
        return;
      }
    } else {
      config.password = cfg.credential;
    }

    conn.on("ready", () => resolve(conn));
    conn.on("error", (err) => reject(err));
    conn.connect(config);
  });
}

function execOnConn(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) { reject(err); return; }
      let stdout = "", stderr = "";
      stream.on("close", (code, signal) => resolve({ stdout, stderr, code, signal }));
      stream.on("data", (data) => { stdout += data.toString(); });
      stream.stderr.on("data", (data) => { stderr += data.toString(); });
    });
  });
}

function sftpOpen(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
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
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatEntry(e) {
  if (!e || !e.attrs) return `  ?         ${e.filename}`;
  const isDir = e.attrs.isDirectory ? e.attrs.isDirectory() : !!(e.attrs.mode & 0o40000);
  const perm = isDir ? "d" : "-";
  const size = e.attrs.size || 0;
  return `${perm} ${formatBytes(size).padStart(8)} ${e.filename}`;
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
    return true;
  } catch (err) {
    return false;
  }
}

async function doTrash(sftp, filePath, trashPath) {
  try {
    await ensureDirRecursive(sftp, path.dirname(trashPath));
    await sftpRename(sftp, filePath, trashPath);
    return true;
  } catch (err) {
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
      description: "List all configured SSH servers with connection info and auth type",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "exec",
      description: "Execute a shell command on a remote server and return the output",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name as configured in SSH_SERVICES" },
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["server", "command"],
      },
    },
    {
      name: "scp_upload",
      description: "Upload a local file to a remote server via SFTP",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          local_path: { type: "string", description: "Absolute path to the local file" },
          remote_path: { type: "string", description: "Absolute destination path on the remote server" },
        },
        required: ["server", "local_path", "remote_path"],
      },
    },
    {
      name: "scp_download",
      description: "Download a file from a remote server to the local machine via SFTP",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path on the remote server" },
          local_path: { type: "string", description: "Absolute path where to save the file locally" },
        },
        required: ["server", "remote_path", "local_path"],
      },
    },
    {
      name: "read_file",
      description: "Read the contents of a remote file and return as text. Supports optional line offset/limit for partial reads.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to the remote file" },
          offset: { type: "number", description: "Starting line number (1-indexed). Defaults to 1." },
          limit: { type: "number", description: "Maximum number of lines to return. Omit to read all lines from offset." },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a remote file. Creates automatic rotational backup (last 3 versions) for files under 100MB when the file already exists. Backups stored at ~/.mcp-ssh/backups/<server>/<path>.bak.N",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path on the remote server" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["server", "remote_path", "content"],
      },
    },
    {
      name: "sftp_list",
      description: "List files and directories in a remote path",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path of the remote directory" },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "sftp_mkdir",
      description: "Create a directory on the remote server (works like mkdir -p)",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path of the directory to create" },
        },
        required: ["server", "remote_path"],
      },
    },
    {
      name: "sftp_rm",
      description: "Remove a file or directory on the remote server. Small files (<100MB) are moved to ~/.mcp-ssh/trash/<server>/<path>.<timestamp> instead of permanent deletion. Large files and directories are deleted directly with a warning.",
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
      name: "backup_status",
      description: "Show disk usage statistics for backups (~/.mcp-ssh/backups) and trash (~/.mcp-ssh/trash) across all configured servers",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "update_file",
      description: "Edit a remote file with search/replace or line-based operations. Backup is automatically created before modification.",
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name" },
          remote_path: { type: "string", description: "Absolute path to the remote file" },
          search: { type: "string", description: "Text to search for (search/replace mode)" },
          replace: { type: "string", description: "Replacement text (search/replace mode)" },
          line: { type: "number", description: "Line number to act on (line mode, 1-indexed)" },
          end_line: { type: "number", description: "End line number for range deletion" },
          content: { type: "string", description: "New content for the line (line mode)" },
          position: { type: "string", description: "Insert position: 'before' or 'after' the specified line" },
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
      const homeResult = await execOnConn(conn, "echo $HOME");
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

  try {
    if (name === "exec") {
      const result = await withConn(async (conn) => {
        return await execOnConn(conn, args.command);
      });
      const parts = [];
      if (result.stdout) parts.push({ type: "text", text: result.stdout });
      if (result.stderr) parts.push({ type: "text", text: `stderr:\n${result.stderr}` });
      if (result.code !== 0) parts.push({ type: "text", text: `exit code: ${result.code}` });
      return { content: parts.length ? parts : [{ type: "text", text: "(no output)" }] };
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
            notes.push(`File is large (${formatBytes(stat.size)} > 100MB) — skipped backup`);
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

    if (name === "sftp_list") {
      const entries = await withSftp(async (conn, sftp) => {
        return await sftpReaddir(sftp, args.remote_path);
      });
      const lines = entries
        .filter((e) => e.filename !== "." && e.filename !== "..")
        .map(formatEntry);
      const header = `${sshCfg.user}@${sshCfg.host}:${args.remote_path}`;
      return { content: [{ type: "text", text: header + "\n" + (lines.length ? lines.join("\n") : "(empty directory)") }] };
    }

    if (name === "sftp_mkdir") {
      await withSftp(async (conn, sftp) => {
        await ensureDirRecursive(sftp, args.remote_path);
      });
      return { content: [{ type: "text", text: `Created directory ${args.remote_path}` }] };
    }

    if (name === "update_file") {
      const hasSearch = args.search !== undefined && args.search !== null && args.search !== "";
      const hasLine = args.line !== undefined && args.line !== null;
      if (!hasSearch && !hasLine) {
        return { isError: true, content: [{ type: "text", text: "Provide 'search' (search/replace mode) or 'line' (line operation mode)" }] };
      }
      if (hasSearch && hasLine) {
        return { isError: true, content: [{ type: "text", text: "Provide either 'search' or 'line', not both" }] };
      }

      const result = await withHomeAndSftp(async (conn, sftp, homeDir) => {
        const original = (await sftpReadFile(sftp, args.remote_path)).toString("utf8");
        let notes, modified;

        if (hasSearch) {
          const count = original.split(args.search).length - 1;
          if (count === 0) {
            return { notes: [`No matches for "${args.search}"`], skipped: true };
          }
          modified = original.replaceAll(args.search, args.replace ?? "");
          if (modified === original) {
            return { notes: ["Search text equals replacement — no change needed"], skipped: true };
          }
          notes = [`Replaced ${count} occurrence(s) of "${args.search}"`];
        } else {
          const fileLines = original.split("\n");
          const n = args.line;
          if (n < 1 || n > fileLines.length) {
            return { notes: [`Line ${n} is out of range (file has ${fileLines.length} lines)`], skipped: true };
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
            notes.push(`File is large (${formatBytes(stat.size)} > 100MB) — skipped backup`);
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
          notes.push(`File is large (${formatBytes(stat.size)} > 100MB) — no backup, deleting permanently`);
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

    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  } catch (err) {
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
