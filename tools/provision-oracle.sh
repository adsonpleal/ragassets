#!/usr/bin/env bash
# Provision an Oracle Cloud Always Free ARM box to serve ragassets. Idempotent:
# run it again after a change, or on a fresh instance, and it converges.
#
# This script is the mitigation for the risk it cannot remove. Always Free has
# no SLA: Oracle reclaims instances whose CPU, network AND memory all sit under
# 20% for seven days, and it halved the A1 allowance in June 2026 with no
# announcement. The answer is not to argue with the heuristic — it is that
# nothing here is irreplaceable, so a reclaimed instance is an afternoon's
# rebuild rather than an excavation. Keep it that way: anything you do by hand
# on the box and do not put in here is a thing you will have to remember under
# pressure.
#
# It contains no credential of any kind. This repository is public. What it
# cannot do, it prints as a checklist at the end.
#
# Usage:  sudo -v && tools/provision-oracle.sh
set -euo pipefail

REPO="${REPO:-$HOME/ragassets}"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
GO_VERSION="${GO_VERSION:-1.26.0}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ "$(uname -m)" != "aarch64" ]; then
  echo "This targets the ARM (aarch64) Always Free shape; found $(uname -m)." >&2
  exit 1
fi

say "Base packages"
sudo apt-get update -qq
# No rclone. Nothing pushes to object storage any more; the assets are already
# on the disk the gateway reads.
sudo apt-get install -y -qq git tmux unzip curl ca-certificates \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

say "32-bit Lua, for the client's .lub bytecode"
# The client ships precompiled Lua 5.1 chunks whose header pins sizeof(size_t)=4,
# and lua_undump refuses anything wider — so a 64-bit interpreter cannot read them
# at all. What is needed is a 32-bit *interpreter*, not a 32-bit machine.
#
# Ampere Altra is AArch64-only and cannot execute AArch32 natively, so the armhf
# build runs through qemu-user-static's binfmt handler. Verified to produce a
# byte-identical tables.json to a 32-bit x86 lua on Windows.
#
# Without this, tools/rebake-resolver.sh cannot run here and a client update that
# adds job ids leaves /image returning 500 for them.
if ! command -v lua5.1 >/dev/null; then
  sudo dpkg --add-architecture armhf
  sudo apt-get update -qq
  sudo apt-get install -y -qq qemu-user-static lua5.1:armhf
fi
lua5.1 -e 'print("lua " .. _VERSION .. " ok")'

say "Node ${NODE_VERSION} (arm64)"
# The official tarball rather than a third-party apt repo: the extractor has zero
# npm dependencies, so trusting a package repo buys nothing that a pinned,
# checksum-verified tarball does not.
if ! /usr/local/bin/node --version 2>/dev/null | grep -q "v${NODE_VERSION}"; then
  tmp="$(mktemp -d)"
  ( cd "$tmp"
    base="https://nodejs.org/dist/v${NODE_VERSION}"
    curl -fsSLO "${base}/node-v${NODE_VERSION}-linux-arm64.tar.xz"
    curl -fsSLO "${base}/SHASUMS256.txt"
    grep " node-v${NODE_VERSION}-linux-arm64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
    sudo rm -rf "/usr/local/node-v${NODE_VERSION}"
    sudo tar -xJf "node-v${NODE_VERSION}-linux-arm64.tar.xz" -C /usr/local
    sudo ln -sfn "/usr/local/node-v${NODE_VERSION}-linux-arm64/bin/node" /usr/local/bin/node
    sudo ln -sfn "/usr/local/node-v${NODE_VERSION}-linux-arm64/bin/npm" /usr/local/bin/npm )
  rm -rf "$tmp"
fi
node --version

say "Go ${GO_VERSION} (arm64)"
# Match CI. go.mod's `go 1.22` is the minimum language version, not a toolchain
# pin, and the box should build what CI tested.
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION}"; then
  tmp="$(mktemp -d)"
  ( cd "$tmp"
    curl -fsSLO "https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz"
    sudo rm -rf /usr/local/go
    sudo tar -xzf "go${GO_VERSION}.linux-arm64.tar.gz" -C /usr/local
    sudo ln -sfn /usr/local/go/bin/go /usr/local/bin/go
    sudo ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt )
  rm -rf "$tmp"
fi
go version

say "Caddy"
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy
fi
caddy version

say "Firewall"
# Oracle's Ubuntu images ship netfilter rules with a REJECT at the end of INPUT,
# independently of the VCN security list. Both have to be opened. Forgetting the
# local half is the classic "the port is open but nothing connects" afternoon,
# because the cloud console shows the rule you did add and says nothing about
# the one you did not.
#
# Insert before the REJECT rather than appending, or the packet is rejected
# before it reaches the ACCEPT.
reject_line="$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')"
for port in 80 443; do
  if sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    echo "  tcp/$port already accepted"
  elif [ -n "$reject_line" ]; then
    sudo iptables -I INPUT "$reject_line" -p tcp --dport "$port" -j ACCEPT
    echo "  tcp/$port accepted (inserted at $reject_line)"
  else
    sudo iptables -A INPUT -p tcp --dport "$port" -j ACCEPT
    echo "  tcp/$port accepted (appended; no REJECT rule found)"
  fi
done
sudo netfilter-persistent save

say "Directories"
# mirror/ is the merged client: the full data.grf plus every patch since. It is
# deliberately NOT resources/, which means "the derived stores" and nothing else.
# Collapsing the two would point --grf at a tree containing the 21k-file maps
# output it is about to rewrite.
mkdir -p "$REPO"/{mirror/data,resources,System,BGM}
sudo mkdir -p /etc/ragassets && sudo chmod 700 /etc/ragassets

say "Units"
sudo install -m 0644 "$REPO"/deploy/ragassets-gateway.service /etc/systemd/system/
sudo install -m 0644 "$REPO"/deploy/ragassets-patch.service /etc/systemd/system/
sudo install -m 0644 "$REPO"/deploy/ragassets-patch.timer /etc/systemd/system/
sudo visudo -cf "$REPO"/deploy/ragassets.sudoers
sudo install -m 0440 "$REPO"/deploy/ragassets.sudoers /etc/sudoers.d/ragassets
sudo mkdir -p /etc/caddy/conf.d
sudo install -m 0644 "$REPO"/caddy/ragassets.caddy /etc/caddy/conf.d/
sudo systemctl daemon-reload

cat <<'CHECKLIST'

Provisioned. What this script cannot do, in the order it is needed:

  1. Upload the client. data.grf (~4.3 GB), System/ and BGM/ from the Windows
     install, into $REPO. The GRF goes beside the mirror, not inside it.

  2. Measure, then extract. The estimate below beats guessing at disk:
       node extract-grf.mjs --list data.grf \
         | awk -F'\t' '{s+=$2} END {printf "%.1f GB, %d entries\n", s/1e9, NR}'
     Then, under tmux, the full extraction into mirror/ and each derived store.
     Time every mode: those numbers decide whether the box can carry the
     fortnightly rebuild alone.

  3. Build the gateway. The old x86 binary will not run here.
       cd $REPO/gateway && go build -ldflags='-s -w' -o ragassets-gateway .
     Then run tools/rebake-resolver.sh. It regenerates the baked id -> sprite
     tables from the mirror and rebuilds only if they changed. A difference there
     is a live bug in production, not an artefact of the move.

  4. Enable the gateway ONLY once mirror/data exists — it exits otherwise.
       sudo systemctl enable --now ragassets-gateway

  5. Cloudflare Origin certificate into /etc/caddy/cf-origin.{pem,key}, owned
     root:caddy, mode 0640. Zone SSL mode: Full (strict).

  6. /etc/ragassets/patch.env, root:root 0600, if you want the Discord post and
     the cache purge: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, CF_ZONE_ID,
     CF_PURGE_TOKEN. Never in the repo — it is public.

  7. Seed the poll BEFORE enabling the timer, or the first cycle asks for the
     whole archive history and is refused at MAX_PATCHES:
       cd $REPO && node tools/patch-cycle.mjs --seed
       sudo systemctl start ragassets-patch.service    # one cycle, by hand
       sudo systemctl enable --now ragassets-patch.timer

  8. VCN security list, in the Oracle console: tcp/22 from your address only,
     tcp/80 and tcp/443 from anywhere. The iptables half is already done.

CHECKLIST
