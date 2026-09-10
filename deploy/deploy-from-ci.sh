#!/usr/bin/env bash
#
# The only thing .github/workflows/deploy.yml's SSH key is allowed to run.
#
# Install it OUTSIDE the checkout and point authorized_keys at that copy:
#
#   sudo install -m 0755 deploy/deploy-from-ci.sh /usr/local/bin/ragassets-deploy
#
# Outside, not in place, for a specific reason: this script resets the working
# tree it lives in. bash reads a script incrementally as it executes, so running
# the copy inside ~/ragassets means `git reset --hard` can swap the file out from
# under the interpreter mid-run, and the failure is a syntax error on a line
# nobody wrote. It also means a deploy is never running the version it is about
# to install. Reinstall this by hand after changing it, the same way the systemd
# units are copied into /etc/systemd/system.
#
# Then, in /home/ubuntu/.ssh/authorized_keys, ON ONE LINE:
#
#   command="/usr/local/bin/ragassets-deploy",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 AAAA... ragassets-ci
#
# The forced command is what makes the key safe to hold in a public repository's
# secrets. Whatever the client asks for lands in SSH_ORIGINAL_COMMAND and is
# read as data, never executed, so the key cannot open a shell, forward a port,
# or run any other command. It deploys a commit that is already on origin/main,
# and that is the whole privilege. Do not add an unrestricted copy of this key.
#
# It needs no sudo rights beyond the one line already in deploy/ragassets.sudoers
# (`systemctl restart ragassets-gateway.service`, no wildcards).
set -euo pipefail

REPO=/home/ubuntu/ragassets
UNIT=ragassets-gateway.service
BIN=ragassets-gateway
LOCK=/run/lock/ragassets-patch.lock

# A forced command runs a non-login shell with a minimal environment. go and
# node are symlinked into /usr/local/bin by tools/provision-oracle.sh, but
# relying on the inherited PATH to contain it is how this breaks once.
export PATH=/usr/local/bin:/usr/local/go/bin:/usr/bin:/bin
export HOME=/home/ubuntu

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] FAILED: %s\n' "$*" >&2; exit 1; }

# ---- what the client asked for, treated as data ----------------------------

read -r -a argv <<<"${SSH_ORIGINAL_COMMAND:-}"
[ "${argv[0]:-}" = "deploy" ] || die "expected 'deploy <sha>', got '${SSH_ORIGINAL_COMMAND:-}'"
sha="${argv[1]:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "not a full commit sha: '$sha'"

cd "$REPO" || die "no checkout at $REPO"

# ---- refuse to discard work that is only here ------------------------------
#
# The reset below is --hard. If someone edited a file on the box to chase
# something down, silently throwing it away is the wrong answer, and the right
# one is to say so and stop. Untracked files are ignored on purpose: the cycle
# leaves patch-report.json and _patchdl behind, and both are disposable.
dirty="$(git status --porcelain --untracked-files=no)"
[ -z "$dirty" ] || die "the working tree has uncommitted changes:
$dirty
Commit them, or discard them with 'git checkout -- .', then deploy again."

# ---- verify the commit is really ours --------------------------------------
#
# This is the check that makes the forced command's promise true. Without it the
# key could deploy any object that exists in the repository — a commit pushed to
# a throwaway branch, or fetched from a fork — and "it can only deploy main"
# would be a comment rather than a rule.
log "fetching origin"
git fetch --quiet origin main

git cat-file -e "${sha}^{commit}" 2>/dev/null || die "commit $sha is not in this repository"
git merge-base --is-ancestor "$sha" origin/main \
  || die "commit $sha is not an ancestor of origin/main — refusing to deploy it"

previous="$(git rev-parse HEAD)"
if [ "$previous" = "$sha" ]; then
  log "already at $sha; rebuilding and restarting anyway"
fi

# ---- serialise against the patch cycle -------------------------------------
#
# apply-patches.mjs spawns extract-grf.mjs by a relative path, several times per
# cycle. A `git reset` between two of those spawns is a run that used two
# different extractors, which is the kind of bug that is found months later in
# the output rather than in a log. The cycle takes this same lock, so holding it
# here is the whole fix.
#
# -w, not -n: a cycle that is merely polling holds the lock for about a second.
# A cycle that is rebuilding maps holds it for hours, and waiting that long is
# worse than failing — the deploy is re-runnable, so it says so and stops.
# A patch cycle that fires while a deploy holds the lock fails its flock -n and
# the timer simply retries in ten minutes; that is the intended direction.
exec 9>"$LOCK"
flock -w 600 9 || die "a patch cycle has held the lock for 10 minutes (likely a maps rebuild).
Re-run this deploy when 'systemctl is-active ragassets-patch' is inactive."

# ---- check out, build, install ---------------------------------------------

log "checking out $sha"
git checkout --quiet main
git reset --hard --quiet "$sha"

# ---- say so if the systemd units drifted -----------------------------------
#
# This deploy ships code, NOT units, deliberately. Installing a unit means being
# able to rewrite ExecStart, which would turn this key from "can deploy" into
# "can run anything as root" and undo the entire point of the forced command. So
# it looks and reports, and a human does the install. Without this the failure is
# silent in the worst way: systemd prints "unit file changed on disk" into the
# restart output, the deploy goes green, and the box keeps running the old unit.
for u in ragassets-gateway.service ragassets-patch.service ragassets-patch.timer; do
  if ! diff -q "$REPO/deploy/$u" "/etc/systemd/system/$u" >/dev/null 2>&1; then
    log "WARNING: deploy/$u differs from the installed copy, which is what is running."
    log "         If the change is real, on the box:"
    log "         sudo install -m 0644 ~/ragassets/deploy/$u /etc/systemd/system/$u && sudo systemctl daemon-reload"
  fi
done

# Build beside the running binary, then rename over it. The rename is atomic, so
# a failed or interrupted build can never leave a truncated file where systemd
# expects an executable — the old one stays in place and keeps serving.
log "building (aarch64, on the box)"
cd "$REPO/gateway"
go build -ldflags='-s -w' -o "${BIN}.new" . || die "go build failed; nothing was changed"

# Kept for the rollback below. Copied rather than moved so that the currently
# running process, which holds its own inode, is never the thing being renamed.
cp -f "$BIN" "${BIN}.prev" 2>/dev/null || log "no previous binary to keep"
mv -f "${BIN}.new" "$BIN"

log "restarting $UNIT"
sudo systemctl restart "$UNIT"

# ---- prove it serves, or put the old binary back ---------------------------
#
# The gateway parses its stores at boot and log.Fatalf's if the mirror is not
# where it expects, so "the unit is active" is not the same as "it answers".
# Restart=always then turns a crash-loop into a unit that looks alive between
# attempts. Ask it for real bytes instead.
healthy() {
  local code
  for _ in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 localhost:8080/healthz || true)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}

if healthy; then
  log "healthz ok"
else
  log "healthz never came up — rolling back to the previous binary"
  if [ -f "${BIN}.prev" ]; then
    mv -f "${BIN}.prev" "$BIN"
    sudo systemctl restart "$UNIT"
    if healthy; then
      log "rolled back to $previous and it is serving"
    else
      log "the rollback is ALSO not serving — this needs a human now"
    fi
  else
    log "no previous binary to roll back to"
  fi
  die "deployed $sha did not answer /healthz; the checkout is at $sha but the binary is the old one"
fi

# One render and one icon, because a gateway that answers /healthz and 500s on
# every sprite is the failure this is actually guarding against. The icon path
# is /icons/item/501.png — there is no /icon route.
curl -sf --max-time 20 "localhost:8080/image?job=1002&action=0" -o /tmp/deploy-render.png \
  || die "a render failed after deploy"
[ "$(wc -c < /tmp/deploy-render.png)" -gt 500 ] || die "the render came back suspiciously small"
curl -sfI --max-time 10 localhost:8080/icons/item/501.png >/dev/null \
  || die "the icon route failed after deploy"
rm -f /tmp/deploy-render.png

log "deployed $sha (was $previous)"
