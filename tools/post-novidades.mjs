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
//   node tools/post-novidades.mjs --report patch-report.json [--dry-run]
//
// Exit codes: 0 = posted, dry-run, or not configured (no token). 1 = a token was
// given and Discord rejected the request, which is real misconfiguration and
// worth surfacing.
import { readFileSync } from "node:fs";

const PROJECT_NAME = "Assets RO LATAM";
const SITE_URL = "https://assets.latam-tools.com.br";
// #novidades, shared by every LATAM tool.
const DEFAULT_CHANNEL_ID = "1524025278471471295";
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
  if (!args.report) throw new Error("--report <patch-report.json> is required");

  const report = JSON.parse(readFileSync(args.report, "utf8"));
  const embed = buildEmbed(report);
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
  console.error("posted to #novidades.");
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
