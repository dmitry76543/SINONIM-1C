/**
 * 1С CSV (FTP) → AdvantShop `/api/1c/importproducts`
 *
 * Ожидаемые колонки в файле 1С (разделитель ; или ,):
 *   ArtNo;OfferArtNo;Amount;Price
 *   (имена можно переименовать через env)
 *
 * AdvantShop URL берётся со страницы:
 *   Настройки → API → вкладка «1C» → «Импорт товаров»
 *   http(s)://shop.../api/1c/importproducts?apikey=...
 *
 * Использование:
 *   node scripts/sync-ftp-to-advantshop.mjs
 *   node scripts/sync-ftp-to-advantshop.mjs --dry-run
 *   node scripts/sync-ftp-to-advantshop.mjs --file ./tmp/stocks.csv
 *
 * Env (в .env.local или окружении):
 *   ADVANTSHOP_BASE_URL=https://shop.synonym-jewelry.ru
 *   ADVANTSHOP_SERVER_API_KEY=...
 *   # либо полный URL:
 *   # ADVANTSHOP_1C_IMPORT_URL=https://shop.../api/1c/importproducts?apikey=...
 *
 *   FTP_HOST=ftp.example.ru
 *   FTP_USER=...
 *   FTP_PASSWORD=...
 *   FTP_REMOTE_PATH=/sinonim/stocks.csv
 *   FTP_SECURE=false
 *
 *   # опционально
 *   SYNC_CSV_DELIMITER=;
 *   SYNC_SRC_ARTNO=ArtNo
 *   SYNC_SRC_OFFER=OfferArtNo
 *   SYNC_SRC_AMOUNT=Amount
 *   SYNC_SRC_PRICE=Price
 *   # Выход для /api/1c/importproducts = CSV 1.0 MultiOffer (по умолчанию):
 *   #   ArtNo;MultiOffer
 *   #   802-02763;[802-02763-7:7::15635::2]
 *   # Ручной админ-импорт CSV 2.0 (Артикул;Артикул модификации;…) API НЕ понимает.
 *   # SYNC_OUT_FORMAT=multioffer|columns
 *   SYNC_SKIP_IF_UNCHANGED=true
 *   SYNC_WORK_DIR=./tmp/1c-sync
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

loadEnvFile(join(root, ".env.local"));
loadEnvFile(join(root, ".env"));

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const localFileArg = getArgValue("--file");

const config = {
  baseUrl: (process.env.ADVANTSHOP_BASE_URL || "").replace(/\/$/, ""),
  apiKey:
    process.env.ADVANTSHOP_SERVER_API_KEY ||
    process.env.ADVANTSHOP_API_KEY ||
    "",
  importUrl: process.env.ADVANTSHOP_1C_IMPORT_URL || "",
  ftp: {
    host: process.env.FTP_HOST || "",
    user: process.env.FTP_USER || "",
    password: process.env.FTP_PASSWORD || "",
    remotePath: process.env.FTP_REMOTE_PATH || "/stocks.csv",
    secure: String(process.env.FTP_SECURE || "false").toLowerCase() === "true",
    port: Number(process.env.FTP_PORT || 21),
  },
  delimiter: process.env.SYNC_CSV_DELIMITER || "",
  src: {
    artNo: process.env.SYNC_SRC_ARTNO || "ArtNo",
    offer: process.env.SYNC_SRC_OFFER || "OfferArtNo",
    amount: process.env.SYNC_SRC_AMOUNT || "Amount",
    price: process.env.SYNC_SRC_PRICE || "Price",
  },
  // multioffer = CSV 1.0 для API 1C; columns = плоские колонки (только админ CSV 2.0)
  outFormat: (process.env.SYNC_OUT_FORMAT || "multioffer").toLowerCase(),
  dst: {
    artNo: process.env.SYNC_DST_ARTNO || "ArtNo",
    offer: process.env.SYNC_DST_OFFER || "MultiOffer",
    amount: process.env.SYNC_DST_AMOUNT || "Amount",
    price: process.env.SYNC_DST_PRICE || "Price",
  },
  skipIfUnchanged:
    String(process.env.SYNC_SKIP_IF_UNCHANGED || "true").toLowerCase() !==
    "false",
  workDir: resolve(root, process.env.SYNC_WORK_DIR || "./tmp/1c-sync"),
};

main().catch((error) => {
  console.error("[sync] fatal:", error?.message || error);
  process.exit(1);
});

async function main() {
  mkdirSync(config.workDir, { recursive: true });

  const sourcePath = localFileArg
    ? resolve(localFileArg)
    : join(config.workDir, "from-ftp.csv");

  if (localFileArg) {
    if (!existsSync(sourcePath)) {
      throw new Error(`Local file not found: ${sourcePath}`);
    }
    console.log(`[sync] using local file: ${sourcePath}`);
  } else {
    assertFtpConfig();
    await downloadFromFtp(sourcePath);
  }

  const raw = readFileSync(sourcePath);
  const text = decodeCsvBuffer(raw);
  const hash = sha1(text);
  const hashPath = join(config.workDir, "last-hash.txt");

  if (config.skipIfUnchanged && existsSync(hashPath)) {
    const prev = readFileSync(hashPath, "utf8").trim();
    if (prev === hash) {
      console.log("[sync] file unchanged, skip import");
      return;
    }
  }

  const advantCsv = transformToAdvantShopCsv(text);
  const outPath = join(config.workDir, "advantshop-import.csv");
  writeFileSync(outPath, advantCsv, "utf8");
  console.log(`[sync] prepared AdvantShop CSV: ${outPath}`);
  console.log(`[sync] rows: ${countDataRows(advantCsv)}`);

  if (dryRun) {
    console.log("[sync] dry-run: upload skipped");
    console.log(advantCsv.split(/\r?\n/).slice(0, 6).join("\n"));
    return;
  }

  const importUrl = resolveImportUrl();
  console.log(`[sync] posting to: ${maskUrl(importUrl)}`);
  const responseText = await postCsvToAdvantShop(importUrl, advantCsv);
  writeFileSync(join(config.workDir, "last-response.txt"), responseText, "utf8");
  console.log("[sync] AdvantShop response:");
  console.log(responseText.slice(0, 2000) || "(empty)");

  writeFileSync(hashPath, hash, "utf8");
  console.log("[sync] done");
}

function assertFtpConfig() {
  const missing = [];
  if (!config.ftp.host) missing.push("FTP_HOST");
  if (!config.ftp.user) missing.push("FTP_USER");
  if (!config.ftp.password) missing.push("FTP_PASSWORD");
  if (missing.length) {
    throw new Error(
      `Missing FTP env: ${missing.join(", ")}. Or pass --file ./path.csv`,
    );
  }
}

async function downloadFromFtp(destPath) {
  let Client;
  try {
    ({ Client } = await import("basic-ftp"));
  } catch {
    throw new Error(
      'Package "basic-ftp" is required. Run: npm install basic-ftp',
    );
  }

  const client = new Client(60_000);
  client.ftp.verbose =
    String(process.env.FTP_VERBOSE || "").toLowerCase() === "true";

  try {
    console.log(
      `[sync] FTP connect ${config.ftp.host}:${config.ftp.port} → ${config.ftp.remotePath}`,
    );
    await client.access({
      host: config.ftp.host,
      port: config.ftp.port,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: config.ftp.secure,
    });
    await client.downloadTo(destPath, config.ftp.remotePath);
  } catch (error) {
    throw new Error(`FTP download failed: ${error?.message || error}`);
  } finally {
    client.close();
  }

  console.log(`[sync] downloaded → ${destPath}`);
}

function resolveImportUrl() {
  if (config.importUrl) return config.importUrl;
  if (!config.baseUrl) {
    throw new Error("Set ADVANTSHOP_1C_IMPORT_URL or ADVANTSHOP_BASE_URL");
  }
  if (!config.apiKey) {
    throw new Error("Set ADVANTSHOP_SERVER_API_KEY (or ADVANTSHOP_1C_IMPORT_URL with apikey)");
  }
  const url = new URL(`${config.baseUrl}/api/1c/importproducts`);
  url.searchParams.set("apikey", config.apiKey);
  return url.toString();
}

async function postCsvToAdvantShop(importUrl, csvText) {
  const mode = (process.env.SYNC_POST_MODE || "multipart").toLowerCase();

  /** @type {RequestInit} */
  let init;
  if (mode === "raw") {
    init = {
      method: "POST",
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
      },
      body: csvText,
    };
  } else {
    const form = new FormData();
    form.append(
      "file",
      new Blob([csvText], { type: "text/csv;charset=utf-8" }),
      "import.csv",
    );
    init = { method: "POST", body: form };
  }

  const response = await fetch(importUrl, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AdvantShop HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

function transformToAdvantShopCsv(sourceText) {
  const delimiter = config.delimiter || detectDelimiter(sourceText);
  const lines = sourceText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV is empty or has no data rows");
  }

  const header = parseCsvLine(lines[0], delimiter);
  const idx = {
    artNo: findColumnIndex(header, config.src.artNo),
    offer: findColumnIndex(header, config.src.offer),
    amount: findColumnIndex(header, config.src.amount),
    price: findColumnIndex(header, config.src.price),
  };

  for (const [key, value] of Object.entries(idx)) {
    if (value < 0) {
      throw new Error(
        `Column "${config.src[key]}" not found. Header: ${header.join(" | ")}`,
      );
    }
  }

  /** @type {{ artNo: string, offer: string, amount: string, price: string }[]} */
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line, delimiter);
    const artNo = (cols[idx.artNo] || "").trim();
    const offer = (cols[idx.offer] || "").trim() || artNo;
    const amount = normalizeNumber(cols[idx.amount]);
    const price = normalizeNumber(cols[idx.price]);
    if (!artNo) continue;
    rows.push({ artNo, offer, amount, price });
  }

  if (!rows.length) {
    throw new Error("No valid data rows after transform");
  }

  const csv =
    config.outFormat === "columns"
      ? buildColumnsCsv(rows)
      : buildMultiOfferCsv(rows);

  console.log(`[sync] out format: ${config.outFormat === "columns" ? "columns" : "multioffer (CSV 1.0)"}`);

  // UTF-8 BOM помогает Excel/некоторым парсерам Windows
  return `\uFEFF${csv}`;
}

/** Плоские колонки (как ручной CSV 2.0) — /api/1c/importproducts их обычно не понимает. */
function buildColumnsCsv(rows) {
  const outHeader = [
    config.dst.artNo,
    config.dst.offer,
    config.dst.amount,
    config.dst.price,
  ];
  const outRows = [outHeader.join(";")];
  for (const row of rows) {
    outRows.push(
      [
        escapeCsv(row.artNo),
        escapeCsv(row.offer),
        escapeCsv(row.amount),
        escapeCsv(row.price),
      ].join(";"),
    );
  }
  return `${outRows.join("\r\n")}\r\n`;
}

/**
 * CSV 1.0 для API 1C: ArtNo + MultiOffer
 * MultiOffer = [offer:size:color:price:purchaseprice:amount],…
 * @see https://www.advantshop.net/help/pages/import-csv
 */
function buildMultiOfferCsv(rows) {
  /** @type {Map<string, string[]>} */
  const byArt = new Map();

  for (const row of rows) {
    const size = extractSizeFromOffer(row.artNo, row.offer);
    const cell = `[${row.offer}:${size}::${row.price}::${row.amount}]`;
    const list = byArt.get(row.artNo) || [];
    list.push(cell);
    byArt.set(row.artNo, list);
  }

  const outRows = ["ArtNo;MultiOffer"];
  for (const [artNo, offers] of byArt) {
    outRows.push(`${escapeCsv(artNo)};${escapeCsv(offers.join(","))}`);
  }
  return `${outRows.join("\r\n")}\r\n`;
}

/** 802-02763 + 802-02763-7 → "7"; если оффер = артикул → "" */
function extractSizeFromOffer(artNo, offer) {
  const prefix = `${artNo}-`;
  if (offer.startsWith(prefix) && offer.length > prefix.length) {
    return offer.slice(prefix.length);
  }
  return "";
}

function findColumnIndex(header, name) {
  const target = normalizeHeader(name);
  return header.findIndex((cell) => normalizeHeader(cell) === target);
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
  const semis = (first.match(/;/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  return semis >= commas ? ";" : ",";
}

function parseCsvLine(line, delimiter) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  result.push(current);
  return result;
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[;"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function normalizeNumber(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(",", ".");
}

function countDataRows(csv) {
  return Math.max(0, csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).length - 1);
}

function decodeCsvBuffer(buf) {
  // Пробуем utf8, иначе windows-1251 через TextDecoder если доступен
  const asUtf8 = buf.toString("utf8");
  if (!asUtf8.includes("�")) return asUtf8;
  try {
    return new TextDecoder("windows-1251").decode(buf);
  } catch {
    return asUtf8;
  }
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("apikey")) {
      u.searchParams.set("apikey", "***");
    }
    return u.toString();
  } catch {
    return url.replace(/apikey=[^&]+/i, "apikey=***");
  }
}

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return "";
  return process.argv[idx + 1] || "";
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
