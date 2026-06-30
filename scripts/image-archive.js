import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const defaultArchiveHost = "152.53.166.230";
const defaultArchiveUser = "root";
const defaultArchiveKey = ".secrets/image_archive_ed25519";
const defaultArchiveRoot = "/data/image-auto-collect/images";
const defaultPublicBase = "https://useaifor.me/prompt-images";

function archiveEnabled() {
  return process.env.ARCHIVE_IMAGES !== "0";
}

function localArchiveEnabled() {
  return String(process.env.IMAGE_ARCHIVE_MODE || "").toLowerCase() === "local";
}

function sourceGroup(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("twimg.com")) return "twitter";
    if (host === "43.167.208.107") return "seed";
    return host.replace(/[^a-z0-9.-]+/g, "-").replace(/\.+/g, "-");
  } catch {
    return "unknown";
  }
}

function extensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    if (match && ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(match[1])) {
      return match[1] === "jpeg" ? "jpg" : match[1];
    }
  } catch {
    // Keep the content-type probe as the source of truth below.
  }
  return "";
}

function publicUrlFor(remoteRelativePath) {
  const publicBase = process.env.IMAGE_PUBLIC_BASE || defaultPublicBase;
  return `${publicBase.replace(/\/$/, "")}/${remoteRelativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function sanitizeSegment(value, fallback = "unknown") {
  return String(value || fallback).replace(/^@/, "").replace(/[^A-Za-z0-9_-]+/g, "_") || fallback;
}

function sshArgs(command) {
  const host = process.env.IMAGE_ARCHIVE_HOST || defaultArchiveHost;
  const user = process.env.IMAGE_ARCHIVE_USER || defaultArchiveUser;
  const key = process.env.IMAGE_ARCHIVE_KEY || defaultArchiveKey;
  return [
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "ConnectTimeout=15",
    `${user}@${host}`,
    command
  ];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function runSsh(command, timeoutMs = 70000) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(command), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("IMAGE_ARCHIVE_TIMEOUT"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(err || `IMAGE_ARCHIVE_SSH_${code}`));
    });
  });
}

async function runSshWithInput(command, input, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(command), {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("IMAGE_ARCHIVE_TIMEOUT"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(err || `IMAGE_ARCHIVE_SSH_${code}`));
    });
    child.stdin.end(input);
  });
}

async function downloadFile(url, target, timeoutMs = 60000) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "-L",
        "-sS",
        "--fail",
        "--connect-timeout",
        "10",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "--retry",
        "2",
        "-A",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        "-H",
        "Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "-o",
        temp,
        url
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("IMAGE_ARCHIVE_TIMEOUT"));
    }, timeoutMs + 5000);
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `IMAGE_ARCHIVE_CURL_${code}`));
    });
  });
  const stat = await fs.stat(temp);
  if (stat.size < 256 || stat.size > 12582912) {
    await fs.rm(temp, { force: true });
    throw new Error(`IMAGE_ARCHIVE_SIZE_${stat.size}`);
  }
  await fs.rename(temp, target);
  await fs.chmod(target, 0o644).catch(() => {});
}

async function archiveImageRecordsLocal(jobs) {
  const result = new Map();
  for (const job of jobs) {
    try {
      await fs.access(job.remotePath);
    } catch {
      await downloadFile(job.url, job.remotePath);
    }
    result.set(job.url, publicUrlFor(job.relativePath));
  }
  return result;
}

async function detectExtension(url) {
  const fromUrl = extensionFromUrl(url);
  if (fromUrl) return fromUrl;

  const command = [
    "set -e",
    `content_type=$(curl -L -sS -I --connect-timeout 8 --max-time 20 ${shellQuote(url)} | awk -F': ' 'BEGIN{IGNORECASE=1}/^content-type:/{print $2}' | tail -1 | tr -d '\\r')`,
    "case \"$content_type\" in",
    "  image/jpeg*) echo jpg ;;",
    "  image/png*) echo png ;;",
    "  image/webp*) echo webp ;;",
    "  image/gif*) echo gif ;;",
    "  image/avif*) echo avif ;;",
    "  *) echo jpg ;;",
    "esac"
  ].join("; ");
  const ext = (await runSsh(command, 30000)).trim();
  return ext || "jpg";
}

export async function archiveImages(originalUrls, context = {}) {
  const urls = [...new Set((originalUrls || []).filter(Boolean))];
  if (!urls.length) return [];
  if (!archiveEnabled()) return urls;
  const records = await Promise.all(
    urls.map(async (url, index) => ({
      url,
      context: {
        ...context,
        index,
        caseId: context.caseId,
        tweetId: context.tweetId
      }
    }))
  );
  const archivedMap = await archiveImageRecords(records);
  return urls.map((url) => archivedMap.get(url)).filter(Boolean);
}

export async function archiveImageRecords(records) {
  const inputRecords = (records || []).filter((record) => record?.url);
  if (!inputRecords.length) return new Map();
  if (!archiveEnabled()) return new Map(inputRecords.map((record) => [record.url, record.url]));

  const archiveRoot = process.env.IMAGE_ARCHIVE_ROOT || defaultArchiveRoot;
  const allJobs = inputRecords.map((record, position) => {
    const originalUrl = record.url;
    const context = record.context || {};
    const hash = createHash("sha256").update(originalUrl).digest("hex").slice(0, 32);
    const ext = extensionFromUrl(originalUrl) || "jpg";
    const group = sanitizeSegment(context.group || sourceGroup(originalUrl), "unknown");
    const handle = sanitizeSegment(context.handle, "unknown");
    const tweetOrCase = sanitizeSegment(context.tweetId || context.caseId, "unknown");
    const index = Number.isFinite(Number(context.index)) ? Number(context.index) + 1 : position + 1;
    const filename = `${tweetOrCase}_${index}_${hash}.${ext}`;
    const relativePath = `${group}/${handle}/${filename}`;
    return {
      url: originalUrl,
      relativePath,
      remotePath: `${archiveRoot.replace(/\/$/, "")}/${relativePath}`
    };
  });

  if (localArchiveEnabled()) return archiveImageRecordsLocal(allJobs);

  const chunkSize = Number(process.env.IMAGE_ARCHIVE_BATCH_SIZE || 50);
  const result = new Map();

  for (let start = 0; start < allJobs.length; start += chunkSize) {
    const jobs = allJobs.slice(start, start + chunkSize);
    const manifestLines = jobs.map((job) => `${job.url}\t${job.remotePath}`).join("\n");
  const script = [
    "set -euo pipefail",
    "manifest=$(mktemp)",
    `cat > "$manifest" <<'IMAGE_MANIFEST'\n${manifestLines}\nIMAGE_MANIFEST`,
    "while IFS=$'\\t' read -r url target; do",
    "  [ -n \"$url\" ] || continue",
    "  tmp=$(mktemp)",
    "  mkdir -p \"$(dirname \"$target\")\"",
    "  if [ ! -s \"$target\" ]; then",
    "    if curl -L -sS --fail --connect-timeout 10 --max-time 45 --retry 2 -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' -H 'Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' -o \"$tmp\" \"$url\"; then",
    "      bytes=$(wc -c < \"$tmp\")",
    "      if [ \"$bytes\" -ge 256 ] && [ \"$bytes\" -le 12582912 ]; then",
    "        mv \"$tmp\" \"$target\"",
    "        chown www-data:www-data \"$target\"",
    "        chmod 644 \"$target\"",
    "        printf 'OK\\t%s\\t%s\\n' \"$url\" \"$target\"",
    "      else",
    "        rm -f \"$tmp\"",
    "        printf 'ERR\\t%s\\tSIZE_%s\\n' \"$url\" \"$bytes\" >&2",
    "      fi",
    "    else",
    "      rm -f \"$tmp\"",
    "      printf 'ERR\\t%s\\tCURL_FAILED\\n' \"$url\" >&2",
    "    fi",
    "  else",
    "    rm -f \"$tmp\"",
    "    printf 'OK\\t%s\\t%s\\n' \"$url\" \"$target\"",
    "  fi",
    "done < \"$manifest\"",
    "rm -f \"$manifest\""
  ].join("\n");

    const output = await runSsh(`bash -s <<'REMOTE_SCRIPT'\n${script}\nREMOTE_SCRIPT`, Math.max(120000, jobs.length * 60000));
  const okUrls = new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter(([status]) => status === "OK")
      .map(([, url]) => url)
  );

  for (const job of jobs) {
    if (okUrls.has(job.url)) result.set(job.url, publicUrlFor(job.relativePath));
  }
  }
  return result;
}
