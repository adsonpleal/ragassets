#!/usr/bin/env node
// Announce an asset update in the #novidades Discord channel.
//
// Same mechanism as the four sibling projects: a raw fetch against the Discord
// bot REST API rather than a webhook, so the post carries the identity of the
// bot the community already knows instead of an anonymous integration.
//
// Where this DIFFERS from the siblings: there, a human bumps a version and the
// body is hand-written changelog prose. Here nothing is written by hand — the
// body is counts computed from what the patch actually delivered, because this
// fires from the update pipeline rather than from a release.
//
// Usage:
//   node tools/post-novidades.mjs --summary summary.json [--report patch-report.json] [--dry-run]
//
// --summary is what tools/patch-summary.mjs produces: semantic counts (items,
// maps, costumes) derived from a before/after diff of the rebuilt stores. Without
// it this falls back to raw file counts from --report, which is all the pipeline
// could say before the derived stores were rebuilt on every patch.
//
// Exit codes: 0 = posted, dry-run, or not configured (no token). 1 = a token was
// given and Discord rejected the request, which is real misconfiguration and
// worth surfacing.
import { readFileSync, existsSync } from "node:fs";

import { labelFor } from "./patch-summary.mjs";

const PROJECT_NAME = "Assets RO LATAM";
const SITE_URL = "https://assets.latam-tools.com.br";
// The ragassets update channel. Override with DISCORD_CHANNEL_ID — the older
// shared #novidades (1524025278471471295) is still where the sibling projects
// announce their releases, and this pipeline fires far more often than a release
// does, so it posts somewhere of its own.
const DEFAULT_CHANNEL_ID = "1546989659442249748";
// Teal — distinct from the four already in the channel: latam-market green
// (0x22c55e), latam-ro-calc amber (0xf59e0b), ragreplaystats pink (0xff6f8d)
// and latamvisuais blue (0x3f6cd1).
const EMBED_COLOR = 0x14b8a6;
const DISCORD_DESC_LIMIT = 4096;

// Which prefixes are worth naming, and what to call them for readers who do not
// think in directory names.
const LABELS = [
  ["data/sprite", (n) => `${n} sprite${n === 1 ? "" : "s"}`],
  ["data/texture/effect", (n) => `${n} textura${n === 1 ? "" : "s"} de efeito`],
  ["data/palette", (n) => `${n} paleta${n === 1 ? "" : "s"}`],
  ["data/imf", (n) => `${n} arquivo${n === 1 ? "" : "s"} de camada`],
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report") out.report = argv[++i];
    else if (argv[i] === "--summary") out.summary = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
  }
  return out;
}

// countByPrefix walks the report's file list rather than its byPrefix summary,
// because that summary buckets by the first two path segments and the labels
// here need deeper prefixes (data/texture/effect, not data/texture).
function countByPrefix(files) {
  const counts = new Map();
  for (const f of files) {
    for (const [prefix] of LABELS) {
      if (f.startsWith(prefix + "/")) {
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

// Order matters: this is the reading order in the embed, most interesting first.
// Items lead because they are what people actually notice; raw file counts trail
// because they are context, not news.
const SUMMARY_ORDER = ["items", "classes", "jobs", "skills", "maps", "bgm", "effects"];

const FILE_LABELS = {
  sprites: (n) => `${n} sprite${n === 1 ? "" : "s"}`,
  effectTextures: (n) => `${n} textura${n === 1 ? "" : "s"} de efeito`,
  palettes: (n) => `${n} paleta${n === 1 ? "" : "s"}`,
  imf: (n) => `${n} arquivo${n === 1 ? "" : "s"} de camada`,
};

function buildEmbedFromSummary(summary) {
  const novos = [];
  const alterados = [];
  for (const key of SUMMARY_ORDER) {
    const a = summary.added?.[key];
    const c = summary.changed?.[key];
    if (a) novos.push(`${a} ${labelFor(key, a)}`);
    if (c) alterados.push(`${c} ${labelFor(key, c)}`);
  }
  const arquivos = Object.entries(summary.files ?? {})
    .filter(([k]) => FILE_LABELS[k])
    .map(([k, n]) => FILE_LABELS[k](n));

  // Nothing a reader would notice. Sprites alone still count as news — a redrawn
  // costume changes no table but is visible in-game.
  if (!novos.length && !alterados.length && !arquivos.length) return null;

  const lines = [];
  if (novos.length) lines.push(`**Novidades:** ${novos.join(" · ")}`);
  if (alterados.length) lines.push(`**Atualizados:** ${alterados.join(" · ")}`);
  if (arquivos.length) lines.push(`**Arquivos:** ${arquivos.join(" · ")}`);
  if (summary.skipped) {
    lines.push(`\n${summary.skipped} patch(es) ignorado(s) pelo patcher oficial`);
  }

  const s = summary.seq;
  const range = !s
    ? `patch #${summary.maxSeq ?? "?"}`
    : s.from === s.to
      ? `patch #${s.from}`
      : `patches #${s.from}–#${s.to}`;

  let description = lines.join("\n");
  if (description.length > DISCORD_DESC_LIMIT) {
    description = description.slice(0, DISCORD_DESC_LIMIT - 1) + "…";
  }
  const date = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return {
    title: `${PROJECT_NAME} — ${range}`,
    url: SITE_URL,
    description,
    color: EMBED_COLOR,
    footer: { text: `Publicado em ${date} • ${SITE_URL.replace(/^https:\/\//, "")}` },
    timestamp: new Date().toISOString(),
  };
}

function buildEmbed(report) {
  const counts = countByPrefix(report.files ?? []);
  const parts = [];
  for (const [prefix, label] of LABELS) {
    const n = counts.get(prefix);
    if (n) parts.push(label(n));
  }
  if (!parts.length) return null; // nothing user-visible changed

  const seqs = report.applied ?? [];
  const range =
    seqs.length > 1
      ? `patches #${Math.min(...seqs)}–#${Math.max(...seqs)}`
      : `patch #${seqs[0] ?? report.maxSeq}`;

  const date = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  let description = `• ${parts.join(" · ")}`;
  if (report.skipped?.length) {
    description += `\n\n• ${report.skipped.length} patch(es) ignorado(s) pelo patcher oficial`;
  }
  if (description.length > DISCORD_DESC_LIMIT) {
    description = description.slice(0, DISCORD_DESC_LIMIT - 1) + "…";
  }

  return {
    title: `${PROJECT_NAME} — ${range}`,
    url: SITE_URL,
    description,
    color: EMBED_COLOR,
    footer: { text: `Publicado em ${date} • ${SITE_URL.replace(/^https:\/\//, "")}` },
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.report && !args.summary) {
    throw new Error("--summary <summary.json> or --report <patch-report.json> is required");
  }

  let embed = null;
  if (args.summary && existsSync(args.summary)) {
    embed = buildEmbedFromSummary(JSON.parse(readFileSync(args.summary, "utf8")));
  } else if (args.report) {
    // Falls back to raw file counts. Reached when the summary is missing because
    // no store was rebuilt, which is the common sprite-only patch.
    embed = buildEmbed(JSON.parse(readFileSync(args.report, "utf8")));
  }
  if (!embed) {
    console.error("nothing user-visible in this patch run — not posting.");
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ embeds: [embed] }, null, 2));
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID || DEFAULT_CHANNEL_ID;
  if (!token) {
    console.error("DISCORD_BOT_TOKEN unset — post skipped.");
    return;
  }

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    console.error(`Discord rejected the post: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  console.error(`posted to channel ${channelId}.`);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
