#!/bin/sh
# Routing transactions. Config bytes never pass through a shell variable.
set -eu
umask 077
VERSION=3
PATH="/opt/bin:/opt/sbin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
PROFILE=${XK_ROUTING_PROFILE:-/opt/etc/xk-switcher-routing.conf}
[ ! -f "$PROFILE" ] || . "$PROFILE"
ROOT=${XK_ROUTING_ROOT:-/opt/var/lib/xk-switcher/routing}
CONFIGS=${XK_ROUTING_CONFIGS:-/opt/etc/xray/configs}
ASSETS=${XK_ROUTING_ASSETS:-/opt/etc/xray/dat}
CFG="$CONFIGS/05_routing.json"
BUNDLE_FILES="04_outbounds.json 05_routing.json 99_xk_devices_tail.json"
BUNDLE=0
XRAY=${XK_ROUTING_XRAY:-xray}
XKEEN=${XK_ROUTING_XKEEN:-xkeen}
SELF=${XK_ROUTING_SELF:-/opt/bin/xk-routing}
DEADLINE=${XK_ROUTING_DEADLINE:-90}
CHECKS=${XK_ROUTING_CHECKS:-15}
LOCK="$ROOT/lock"
FSYNC=${XK_ROUTING_FSYNC:-fsync}
DURABILITY=global
command -v "$FSYNC" >/dev/null 2>&1 && DURABILITY=fsync
hash() { sha256sum "$1" | cut -d ' ' -f 1; }
is_id() { printf '%s' "$1" | LC_ALL=C grep -Eq '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'; }
is_hash() { printf '%s' "$1" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$'; }
fail() { echo "$1" >&2; exit 1; }
# Metadata is atomically visible, but durability is batched at explicit barriers.
# Installing flushes the complete backup/manifest before any live-file change;
# terminal phases are durable before the operation lock can be released.
write() { printf '%s\n' "$2" > "$1.new.$$" || return 1; mv "$1.new.$$" "$1"; }
flush_operation() {
    # No directory is flushed until every file it publishes has been flushed.
    # Only this operation's journal, backups and replacement files are included;
    # unrelated router/storage writes never enter the durability boundary.
    set --
    for item in version bundle candidate.sha256 before.sha256 environment confirmed.environment candidate.jsonc before.jsonc before.state installed.sha256 changed.files ack external.jsonc phase timings.log; do
        file="$OP/$item"
        [ ! -f "$file" ] || set -- "$@" "$file"
    done
    for directory in "$OP/before" "$OP/candidate" "$OP/external"; do
        for name in $BUNDLE_FILES; do
            [ ! -f "$directory/$name" ] || set -- "$@" "$directory/$name"
        done
    done
    for file in "$LOCK/owner" "$LOCK/boot_id" "$ROOT/original.jsonc"; do
        [ ! -f "$file" ] || set -- "$@" "$file"
    done
    if [ -n "${install_stage:-}" ] && [ -d "$install_stage" ]; then
        for name in $BUNDLE_FILES; do
            [ ! -f "$install_stage/$name" ] || set -- "$@" "$install_stage/$name"
        done
    fi
    if [ -n "${single_temp:-}" ] && [ -f "$single_temp" ]; then set -- "$@" "$single_temp"; fi
    if [ "${barrier:-}" = installed-data ]; then
        if [ "$BUNDLE" = 1 ]; then
            changed=$BUNDLE_FILES
            [ ! -f "$OP/changed.files" ] || changed=$(cat "$OP/changed.files")
            for name in $changed; do
                [ ! -f "$CONFIGS/$name" ] || set -- "$@" "$CONFIGS/$name"
            done
        else set -- "$@" "$CFG"; fi
    fi
    [ "$#" -eq 0 ] || "$FSYNC" "$@" || return 1
    set --
    for directory in "$OP/before" "$OP/candidate" "$OP/external"; do
        [ ! -d "$directory" ] || set -- "$@" "$directory"
    done
    if [ -n "${install_stage:-}" ] && [ -d "$install_stage" ]; then set -- "$@" "$install_stage"; fi
    if [ -n "${install_stage:-}${single_temp:-}" ] || [ "${barrier:-}" = installed-data ]; then set -- "$@" "$CONFIGS"; fi
    for directory in "$OP" "$ROOT/operations" "$LOCK" "$ROOT"; do
        [ ! -d "$directory" ] || set -- "$@" "$directory"
    done
    "$FSYNC" "$@"
}
durable() {
    barrier=$1
    printf '%s barrier:%s:begin\n' "$(date +%s)" "$barrier" >> "$OP/timings.log"
    if [ "$DURABILITY" = fsync ]; then flush_operation || return 1
    else sync || return 1; fi
    printf '%s barrier:%s:end\n' "$(date +%s)" "$barrier" >> "$OP/timings.log"
}
phase() {
    # Make recovery copies durable before publishing installation intent, even
    # if a directory fsync later makes that phase rename persistent early.
    if [ "$DURABILITY" = fsync ]; then
        case "$1" in installing|rolling_back) durable preparation-data || return 1;; esac
    fi
    write "$OP/phase" "$1" || return 1
    printf '%s %s\n' "$(date +%s)" "$1" >> "$OP/timings.log"
    case "$1" in installing|rolling_back|committed|rolled_back|rejected|recovery_failed|boot_restored) durable "$1" || return 1;; esac
    # This runtime marker is written only after the terminal barrier returns.
    # It need not itself survive a reboot: boot recovery reads the durable phase.
    case "$1" in committed|rolled_back|rejected) write "$OP/terminal.durable" "$1";; esac
}
terminal_barrier() {
    [ "$(cat "$OP/terminal.durable" 2>/dev/null || true)" = "$1" ] || durable "$1"
}
trace() {
    [ -n "${OP:-}" ] && [ -d "$OP" ] || return 0
    printf '%s %s\n' "$(date +%s)" "$1" >> "$OP/timings.log"
}
run_xkeen() {
    trace "xkeen:$1:begin" || return 1
    xkeen_result=0
    # The helper already owns an independent supervised session. XKeen's own
    # noninteractive detach would escape its deadline and release control early.
    XKEEN_FOREGROUND=1 "$XKEEN" "$@" || xkeen_result=$?
    trace "xkeen:$1:end:$xkeen_result" || return 1
    return "$xkeen_result"
}
health() {
    status=$(run_xkeen -status 2>/dev/null) || { echo unknown; return; }
    case "$status" in *"не запущ"*|*"остановлен"*|*"not running"*|*"inactive"*|*"stopped"*) echo stopped;;
      *"запущ"*|*"running"*|*"active"*|*"started"*) echo running;; *) echo unknown;; esac
}
environment() {
    # Include actual bytes of all config dependencies, assets, and helper profile.
    { for file in "$CONFIGS"/*.json "$ASSETS"/*.dat; do
        [ -f "$file" ] || continue
        [ "$file" != "$CFG" ] || continue
        if [ "$BUNDLE" = 1 ]; then case "${file##*/}" in 04_outbounds.json|99_xk_devices_tail.json) continue;; esac; fi
        sha256sum "$file"
      done
      "$XRAY" version
      [ ! -f "$PROFILE" ] || sha256sum "$PROFILE"
    } | sha256sum | cut -d ' ' -f 1
}
acquire() {
    if [ ! -d "$ROOT" ]; then
        # Persist newly created ancestors child-first through the first
        # pre-existing directory before any transaction can acquire its lock.
        directory=$ROOT
        set -- "$1" "$directory"
        while [ ! -d "$directory" ]; do
            parent=${directory%/*}
            [ -n "$parent" ] || parent=/
            [ "$parent" != "$directory" ] || fail 'Invalid routing root'
            directory=$parent
            set -- "$@" "$directory"
        done
        owner=$1; shift
        mkdir -p "$ROOT"
        if [ "$DURABILITY" = fsync ]; then "$FSYNC" "$@" || return 1
        else sync || return 1; fi
        set -- "$owner"
    fi
    mkdir "$LOCK" 2>/dev/null || fail 'Router operation already in progress; recovery may be required'
    write "$LOCK/owner" "$1" || { release; return 1; }
    if [ -r /proc/sys/kernel/random/boot_id ]; then
        cp /proc/sys/kernel/random/boot_id "$LOCK/boot_id" || { release; return 1; }
    fi
}
release() { rm -f "$LOCK/owner" "$LOCK/boot_id" "$LOCK"/owner.new.*; rmdir "$LOCK"; }
persist_lock() {
    # The lock must survive a crash BEFORE an accepted operation can be
    # published. Otherwise an accepted record could outlive its missing lock.
    if [ "$DURABILITY" = fsync ]; then
        set -- "$LOCK/owner"
        [ ! -f "$LOCK/boot_id" ] || set -- "$@" "$LOCK/boot_id"
        "$FSYNC" "$@" || return 1
        "$FSYNC" "$LOCK" "$ROOT" || return 1
    else sync || return 1; fi
}
bundle_hash() {
    directory=$1
    for name in $BUNDLE_FILES; do
        [ ! -L "$directory/$name" ] && { [ ! -e "$directory/$name" ] || [ -f "$directory/$name" ]; } || return 1
    done
    { for name in $BUNDLE_FILES; do
        if [ -f "$directory/$name" ] && [ ! -L "$directory/$name" ]; then
            printf '%s:%s\n' "$name" "$(hash "$directory/$name")"
        elif [ ! -e "$directory/$name" ] && [ ! -L "$directory/$name" ]; then
            printf '%s:absent\n' "$name"
        else return 1; fi
      done
    } | sha256sum | cut -d ' ' -f 1
}
current_hash() { if [ "$BUNDLE" = 1 ]; then bundle_hash "$CONFIGS"; else hash "$CFG"; fi; }
# Never extract paths from an archive. Only read the three literal filenames.
unpack_bundle() {
    archive=$1; destination=$2
    [ "$(wc -c < "$archive")" -le 4194304 ] || return 1
    listing=$(tar -tf "$archive") || return 1
    case "$listing" in
      "$(printf '04_outbounds.json\n05_routing.json')"|"$(printf '04_outbounds.json\n05_routing.json\n99_xk_devices_tail.json')") :;;
      *) return 1;;
    esac
    mkdir -p "$destination"
    # A missing overlay is an explicit deletion in the desired complete snapshot.
    rm -f "$destination/99_xk_devices_tail.json"
    for name in $listing; do
        tar -xOf "$archive" "$name" > "$destination/$name" || return 1
        [ -s "$destination/$name" ] && [ "$(wc -c < "$destination/$name")" -le 4194304 ] || return 1
    done
}
validate_file() {
    stage=$(mktemp -d "$ROOT/stage.XXXXXX") || return 1
    for file in "$CONFIGS"/*.json; do
        [ -f "$file" ] || continue
        [ ! -L "$file" ] || { rm -rf "$stage"; return 1; }
        cp -p "$file" "$stage/" || { rm -rf "$stage"; return 1; }
    done
    if [ "$BUNDLE" = 1 ]; then
        unpack_bundle "$1" "$stage" || { rm -rf "$stage"; return 1; }
    else cp "$1" "$stage/05_routing.json" || { rm -rf "$stage"; return 1; }; fi
    result=0
    XRAY_LOCATION_ASSET="$ASSETS" XRAY_LOCATION_CONFDIR="$stage" "$XRAY" run -test -confdir "$stage" > "$stage/result" 2>&1 || result=$?
    [ "$result" -eq 0 ] || cat "$stage/result" >&2
    rm -rf "$stage"
    return "$result"
}
# Version 3 records preserve a complete before/candidate pair and a derived,
# versioned write set. Older operations retain their original recovery semantics.
changed_files() {
    for name in $BUNDLE_FILES; do
        before=absent; after=absent
        [ ! -f "$1/$name" ] || before=$(hash "$1/$name")
        [ ! -f "$2/$name" ] || after=$(hash "$2/$name")
        [ "$before" = "$after" ] || printf '%s\n' "$name"
    done
}
install_bundle() {
    directory=$1
    install_phase=${2:-rolling_back}
    names=$BUNDLE_FILES
    if [ "$(cat "$OP/version" 2>/dev/null || true)" = 3 ]; then
        [ -f "$OP/changed.files" ] || return 1
        names=$(cat "$OP/changed.files")
        [ "$names" = "$(changed_files "$OP/before" "$OP/candidate")" ] || return 1
    fi
    # Prepare all new bytes before publishing installation intent. One barrier
    # covers those bytes together with the complete backup and changed-file set.
    # Live replacements remain bounded and recovery permits any before/after mix.
    install_stage=$(mktemp -d "$CONFIGS/.xk-routing.XXXXXX")
    for name in $names; do
        if [ -f "$directory/$name" ]; then
            temp="$install_stage/$name"
            [ ! -f "$CONFIGS/$name" ] || cp -p "$CONFIGS/$name" "$temp"
            cat "$directory/$name" > "$temp"
            [ "$(hash "$temp")" = "$(hash "$directory/$name")" ] || { rm -rf "$install_stage"; return 1; }
        else
            [ "$name" = 99_xk_devices_tail.json ] || { rm -rf "$install_stage"; return 1; }
        fi
    done
    phase "$install_phase" || return 1
    # Recheck after staging/sync, which can be slow on a loaded router, including
    # an unchanged snapshot whose only requested effect is restarting XKeen.
    check_bundle_recovery || { rm -rf "$install_stage"; return 1; }
    if [ -n "$names" ]; then
        for name in $names; do
            if [ -f "$install_stage/$name" ]; then mv "$install_stage/$name" "$CONFIGS/$name"
            else rm -f "$CONFIGS/$name"; fi
        done
        durable installed-data || return 1
    fi
    rmdir "$install_stage"
}
check_bundle_recovery() {
    [ "$(bundle_hash "$OP/before")" = "$(cat "$OP/before.sha256")" ] || return 1
    [ "$(bundle_hash "$OP/candidate")" = "$(cat "$OP/installed.sha256")" ] || return 1
    if [ "$(cat "$OP/version" 2>/dev/null || true)" = 3 ]; then
        [ -f "$OP/changed.files" ] || return 1
        [ "$(cat "$OP/changed.files")" = "$(changed_files "$OP/before" "$OP/candidate")" ] || return 1
        [ "$(environment)" = "$(cat "$OP/environment")" ] || return 1
    fi
    for name in $BUNDLE_FILES; do
        [ ! -L "$CONFIGS/$name" ] || return 1
        live=absent; before=absent; candidate=absent
        [ ! -f "$CONFIGS/$name" ] || live=$(hash "$CONFIGS/$name")
        [ ! -f "$OP/before/$name" ] || before=$(hash "$OP/before/$name")
        [ ! -f "$OP/candidate/$name" ] || candidate=$(hash "$OP/candidate/$name")
        if [ "$live" != "$before" ] && [ "$live" != "$candidate" ]; then
            mkdir -p "$OP/external"
            [ ! -e "$CONFIGS/$name" ] || cp -p "$CONFIGS/$name" "$OP/external/$name"
            return 1
        fi
    done
}
install_file() {
    source_file=$1
    temp=$(mktemp "$CONFIGS/.xk-routing.XXXXXX")
    single_temp=$temp
    cp -p "$CFG" "$temp"
    cat "$source_file" > "$temp"
    [ "$(hash "$temp")" = "$(hash "$source_file")" ] || { rm -f "$temp"; return 1; }
    durable candidate-data || return 1
    mv "$temp" "$CFG"
    durable installed-data || return 1
    single_temp=
}
verify() {
    count=0
    trace verify:begin
    while [ "$count" -lt "$CHECKS" ]; do
        verified_health=$(health)
        trace "verify:health:$verified_health"
        if [ "$verified_health" = running ] && [ "$(current_hash)" = "$1" ]; then trace verify:ok; return 0; fi
        count=$((count + 1)); sleep 1
    done
    trace verify:failed
    return 1
}
restore() {
    before_hash=$(cat "$OP/before.sha256")
    if [ "$BUNDLE" = 1 ]; then
        check_bundle_recovery || { phase recovery_failed; return 1; }
        install_bundle "$OP/before" || { phase recovery_failed; return 1; }
    else
        live_hash=$(hash "$CFG")
        candidate_hash=$(cat "$OP/candidate.sha256")
        if [ "$live_hash" != "$before_hash" ] && [ "$live_hash" != "$candidate_hash" ]; then
            cp -p "$CFG" "$OP/external.jsonc"
            phase recovery_failed
            return 1
        fi
        [ "$(hash "$OP/before.jsonc")" = "$before_hash" ] || { phase recovery_failed; return 1; }
        phase rolling_back || return 1
        install_file "$OP/before.jsonc" || { phase recovery_failed; return 1; }
    fi
    if [ "$(cat "$OP/before.state")" = stopped ]; then
        run_xkeen -stop || { phase recovery_failed; return 1; }
        [ "$(health)" = stopped ] || { phase recovery_failed; return 1; }
    else
        run_xkeen -restart || { phase recovery_failed; return 1; }
        verify "$before_hash" || { phase recovery_failed; return 1; }
    fi
    phase rolled_back
}
worker() {
    trap 'exit 1' TERM INT
    trap 'worker_exit' EXIT
    [ "$(current_hash)" = "$(cat "$OP/before.sha256")" ] || { phase rejected; return; }
    [ "$(environment)" = "$(cat "$OP/environment")" ] || { phase rejected; return; }
    cp -p "$CFG" "$OP/before.jsonc"
    if [ "$BUNDLE" = 1 ]; then
        mkdir -p "$OP/before"
        for name in $BUNDLE_FILES; do
            [ ! -L "$CONFIGS/$name" ] || { phase rejected; return; }
            [ ! -f "$CONFIGS/$name" ] || cp -p "$CONFIGS/$name" "$OP/before/$name"
        done
        [ "$(bundle_hash "$OP/before")" = "$(cat "$OP/before.sha256")" ] || { phase rejected; return; }
        unpack_bundle "$OP/candidate.jsonc" "$OP/candidate" || { phase rejected; return; }
        write "$OP/installed.sha256" "$(bundle_hash "$OP/candidate")"
        changed_files "$OP/before" "$OP/candidate" > "$OP/changed.files"
    else
        [ "$(hash "$OP/before.jsonc")" = "$(cat "$OP/before.sha256")" ] || { phase rejected; return; }
        cp "$OP/candidate.sha256" "$OP/installed.sha256"
    fi
    [ "$(hash "$OP/candidate.jsonc")" = "$(cat "$OP/candidate.sha256")" ] || { phase rejected; return; }
    health > "$OP/before.state"
    [ "$(cat "$OP/before.state")" != unknown ] || { phase rejected; return; }
    if [ ! -e "$ROOT/original.jsonc" ]; then
        cp -p "$OP/before.jsonc" "$ROOT/original.new"
        [ "$(hash "$ROOT/original.new")" = "$(hash "$OP/before.jsonc")" ] || { phase rejected; return; }
        mv "$ROOT/original.new" "$ROOT/original.jsonc"
    fi
    phase prepared
    validate_file "$OP/candidate.jsonc" || { phase rejected; return; }
    [ "$(environment)" = "$(cat "$OP/environment")" ] || { phase rejected; return; }
    [ "$(current_hash)" = "$(cat "$OP/before.sha256")" ] || { phase rejected; return; }
    if [ "$BUNDLE" = 1 ]; then install_bundle "$OP/candidate" installing
    else phase installing; install_file "$OP/candidate.jsonc"; fi
    phase installed
    run_xkeen -restart
    phase verifying
    verify "$(cat "$OP/installed.sha256")"
    phase committed
}
worker_exit() {
    trap - EXIT TERM INT
    p=$(cat "$OP/phase")
    case "$p" in committed|rejected|rolled_back|recovery_failed) return;;
      accepted|prepared) phase rejected;; *) restore || true;; esac
}
supervise() {
    # A separate session survives SSH disconnect. The supervisor owns recovery if
    # the worker is killed. setsid lets it terminate the entire command group first.
    spawn_session worker "$OP/log" "$OP/worker.pid"
    child=$(cat "$OP/worker.pid")
    elapsed=0
    while kill -0 "$child" 2>/dev/null && [ "$elapsed" -lt "$DEADLINE" ]; do
        sleep 1; elapsed=$((elapsed + 1))
    done
    if kill -0 "$child" 2>/dev/null; then
        kill -KILL -"$child" 2>/dev/null || true
    fi
    wait "$child" 2>/dev/null || true
    p=$(cat "$OP/phase")
    case "$p" in
      committed|rejected|rolled_back)
        # The deadline may have killed a worker inside its final sync. Do not
        # release the lock until the terminal record really crossed a barrier.
        terminal_barrier "$p" || return 1
        release;;
      recovery_failed) :;;
      accepted|prepared) phase rejected; release;;
      *)
        # Recovery itself is bounded; a hung restart cannot release the lock.
        spawn_session recovery "$OP/recovery.log" "$OP/recovery.pid"
        recovery_pid=$(cat "$OP/recovery.pid"); elapsed=0
        while kill -0 "$recovery_pid" 2>/dev/null && [ "$elapsed" -lt "$DEADLINE" ]; do sleep 1; elapsed=$((elapsed+1)); done
        if kill -0 "$recovery_pid" 2>/dev/null; then kill -KILL -"$recovery_pid" 2>/dev/null || true; fi
        wait "$recovery_pid" 2>/dev/null || true
        if [ "$(cat "$OP/phase")" = rolled_back ]; then terminal_barrier rolled_back || return 1; release; else phase recovery_failed; fi
        ;;
    esac
}
spawn_session() {
    if command -v setsid >/dev/null 2>&1; then
        setsid "$SELF" "$1" "$ID" > "$2" 2>&1 &
        write "$3" "$!"
    else
        # Entware ships daemonize (glibc daemon(3): one fork, then setsid).
        daemonize -p "$3" -o "$2" -e "$2" "$SELF" "$1" "$ID"
        attempts=0
        while [ ! -s "$3" ] && [ "$attempts" -lt 10 ]; do sleep 1; attempts=$((attempts+1)); done
        [ -s "$3" ] || fail 'Unable to start independent session'
    fi
}
check_confirmation() {
    [ "$(cat "$LOCK/owner" 2>/dev/null)" = "$ID" ] || fail 'Operation does not own the recovery lock'
    case "$(cat "$OP/phase")" in recovery_failed|rolled_back) :;; *) fail 'Operation is not awaiting recovery confirmation';; esac
    [ -f "$OP/supervisor.pid" ] && [ -f "$OP/worker.pid" ] || fail 'Incomplete operation process records'
    for role in supervisor worker recovery; do
        [ -f "$OP/$role.pid" ] || continue
        confirmation_pid=$(cat "$OP/$role.pid")
        case "$confirmation_pid" in ''|*[!0-9]*) fail 'Invalid operation process record';; esac
        [ "$confirmation_pid" -gt 1 ] || fail 'Invalid operation process record'
        if kill -0 "$confirmation_pid" 2>/dev/null; then fail 'An operation process may still be running'; fi
        case "$role" in worker|recovery)
            if kill -0 -"$confirmation_pid" 2>/dev/null; then fail 'An operation process group may still be running'; fi;;
        esac
    done
    [ "$(bundle_hash "$OP/before")" = "$confirmation_before" ] || fail 'Recovery copy is corrupt'
    [ "$(current_hash)" = "$confirmation_before" ] || fail 'Live configuration is not the exact recovery copy'
    [ "$(environment)" = "$confirmation_environment" ] || fail 'Environment changed; inspect it before confirming recovery'
}
command=${1:-capabilities}
case "$command" in
  capabilities)
    ready=true
    for util in sha256sum mktemp nohup sync tar; do command -v "$util" >/dev/null 2>&1 || ready=false; done
    command -v setsid >/dev/null 2>&1 || command -v daemonize >/dev/null 2>&1 || ready=false
    [ -f "$CFG" ] && [ ! -L "$CFG" ] && [ -d "$ASSETS" ] || ready=false
    { [ -x /opt/etc/init.d/S04xk-routing ] && [ -x /opt/etc/init.d/S06xk-routing ]; } || [ "${XK_ROUTING_TEST:-0}" = 1 ] || ready=false
    printf '{"version":%s,"ready":%s,"bundle":true,"selective":true,"durability":"%s","reason":"Requires helper v3, daemonize/setsid and S04/S06xk-routing startup recovery"}\n' "$VERSION" "$ready" "$DURABILITY";;
  read) cat "$CFG";;
  read-dependencies)
    set --
    for file in "$CONFIGS"/*.json; do
        [ -f "$file" ] || continue
        case "${file##*/}" in 04_outbounds.json|05_routing.json|99_xk_devices_tail.json) continue;; esac
        [ ! -L "$file" ] || fail 'Configuration symlinks are not supported'
        set -- "$@" "${file##*/}"
    done
    if [ "$#" = 0 ]; then
        COPYFILE_DISABLE=1 tar -cf - -T /dev/null
    else COPYFILE_DISABLE=1 tar -cf - -C "$CONFIGS" "$@"; fi;;
  read-bundle)
    set --
    for name in $BUNDLE_FILES; do
        [ ! -L "$CONFIGS/$name" ] || fail 'Configuration symlinks are not supported'
        [ ! -f "$CONFIGS/$name" ] || set -- "$@" "$name"
    done
    COPYFILE_DISABLE=1 tar -cf - -C "$CONFIGS" "$@";;
  environment|bundle-environment)
    [ "$command" != bundle-environment ] || BUNDLE=1
    environment;;
  health) health;;
  confirm-rollback)
    # Operator-only reconciliation of an ALREADY restored v3 bundle. No live
    # config is written and XKeen is not restarted. The explicitly reviewed
    # current environment may differ after an independent geodata update; the
    # old manifest remains immutable and validation uses current dependencies.
    ID=${2:-}; confirmation_environment=${3:-}
    is_id "$ID" && is_hash "$confirmation_environment" || fail 'Invalid arguments'
    OP="$ROOT/operations/$ID"
    [ "$(cat "$OP/version")" = 3 ] && [ "$(cat "$OP/bundle")" = 1 ] || fail 'Confirmation requires a helper v3 bundle'
    BUNDLE=1
    confirmation_before=$(cat "$OP/before.sha256")
    is_hash "$confirmation_before" || fail 'Invalid recovery fingerprint'
    confirmation_state=$(cat "$OP/before.state")
    case "$confirmation_state" in running|stopped) :;; *) fail 'Unknown previous XKeen state';; esac
    mkdir "$OP/confirmation.lock" 2>/dev/null || fail 'Recovery confirmation is already in progress'
    trap 'exit 1' HUP INT TERM
    trap 'rmdir "$OP/confirmation.lock"' EXIT
    check_confirmation
    trace confirmation:validate:begin
    (BUNDLE=0; validate_file "$CFG") || fail 'Current Xray configuration failed validation'
    trace confirmation:validate:ok
    [ "$(health)" = "$confirmation_state" ] || fail 'Previous XKeen state has not been restored'
    check_confirmation
    write "$OP/confirmed.environment" "$confirmation_environment"
    durable confirmation-data
    # Durability can be slow; repeat all comparisons immediately before finish.
    [ "$(health)" = "$confirmation_state" ] || fail 'XKeen state changed during confirmation'
    check_confirmation
    phase rolled_back
    release;;
  validate|validate-bundle)
    [ "$command" != validate-bundle ] || BUNDLE=1
    acquire validate
    trap 'exit 1' HUP INT TERM
    trap 'rm -f "$ROOT/check.$$"; release' EXIT
    cat > "$ROOT/check.$$"
    validate_file "$ROOT/check.$$";;
  start|start-bundle)
    [ "$command" != start-bundle ] || BUNDLE=1
    ID=${2:-}; expected=${3:-}; candidate=${4:-}; env_hash=${5:-}
    is_id "$ID" && is_hash "$expected" && is_hash "$candidate" && is_hash "$env_hash" || fail 'Invalid arguments'
    OP="$ROOT/operations/$ID"
    if [ -d "$OP" ]; then
        [ "$(cat "$OP/bundle" 2>/dev/null || echo 0)" = "$BUNDLE" ] && [ "$(cat "$OP/candidate.sha256")" = "$candidate" ] && [ "$(cat "$OP/before.sha256")" = "$expected" ] && [ "$(cat "$OP/environment")" = "$env_hash" ] || fail 'Operation id conflict'
        cat >/dev/null
        cat "$OP/phase" 2>/dev/null || echo preparing
        exit 0
    fi
    # Once mkdir succeeds, a disconnect must not leave an unowned acceptance
    # lock before cleanup has been installed. The protected window contains no
    # payload read or config mutation; normal cancellation resumes immediately.
    trap '' HUP INT TERM
    acquire "$ID"
    # Never publish an accepted operation with a missing or partial candidate.
    # Status reports preparing from the lock while this private record is built.
    published="$OP"
    trap 'if [ -d "$published" ]; then OP="$published"; phase rejected; else rm -rf "$OP"; fi; release' EXIT
    persist_lock
    mkdir -p "$ROOT/operations"
    OP=$(mktemp -d "$ROOT/operations/.accepting-$ID.XXXXXX")
    trap 'exit 1' HUP INT TERM
    write "$OP/version" "$VERSION"
    write "$OP/bundle" "$BUNDLE"
    write "$OP/candidate.sha256" "$candidate"
    write "$OP/before.sha256" "$expected"
    write "$OP/environment" "$env_hash"
    phase accepted
    cat > "$OP/candidate.jsonc"
    limit=1048576; [ "$BUNDLE" != 1 ] || limit=4194304
    [ "$(wc -c < "$OP/candidate.jsonc")" -le "$limit" ] || fail 'Candidate too large'
    [ "$(hash "$OP/candidate.jsonc")" = "$candidate" ] || fail 'Candidate hash mismatch'
    mv "$OP" "$published"
    OP="$published"
    # Publication is the acceptance barrier for metadata and candidate contents.
    durable acceptance
    # The supervisor inherits ignored HUP: disconnecting SSH cannot revoke an
    # accepted transaction or race an EXIT cleanup against its live worker.
    trap '' HUP INT TERM
    trap - EXIT
    nohup "$SELF" supervise "$ID" </dev/null > "$OP/supervisor.log" 2>&1 &
    write "$OP/supervisor.pid" "$!"
    echo accepted;;
  supervise|worker|recovery|status)
    ID=${2:-}; is_id "$ID" || fail 'Invalid operation id'
    OP="$ROOT/operations/$ID"
    [ ! -f "$OP/bundle" ] || BUNDLE=$(cat "$OP/bundle")
    if [ "$command" = status ] && [ ! -f "$OP/phase" ]; then
        if [ -d "$OP" ] || [ "$(cat "$LOCK/owner" 2>/dev/null || true)" = "$ID" ]; then
            printf '{"phase":"preparing","before_state":"unknown"}\n'
        else printf '{"phase":"not_found"}\n'; fi
        exit 0
    fi
    [ -f "$OP/phase" ] || fail 'Operation not found'
    case "$command" in
      supervise) supervise;; worker) worker;; recovery) restore;;
      status)
        state=unknown
        [ ! -f "$OP/before.state" ] || state=$(cat "$OP/before.state")
        p=$(cat "$OP/phase")
        # Completion is observable only after its durability barrier and lock
        # release. Slow sync must not invite a second, conflicting transaction.
        case "$p" in committed|rejected|rolled_back)
            owner=$(cat "$LOCK/owner" 2>/dev/null || true)
            if [ -d "$LOCK" ] && { [ "$owner" = "$ID" ] || [ -z "$owner" ]; }; then p=finishing; fi;;
        esac
        printf '{"phase":"%s","before_state":"%s"}\n' "$p" "$state";;
    esac;;
  boot)
    if [ -L "$LOCK" ]; then
        [ -x /opt/bin/xk-update ] || fail 'Update recovery helper unavailable; lock preserved'
        exec /opt/bin/xk-update boot
    fi
    # Called before S05xkeen. No restart here: the normal init sequence starts it.
    [ -d "$LOCK" ] || exit 0
    if [ -r "$LOCK/boot_id" ] && [ "$(cat "$LOCK/boot_id")" = "$(cat /proc/sys/kernel/random/boot_id)" ]; then
        fail 'Recovery requires a new boot; an operation may still be running'
    fi
    ID=$(cat "$LOCK/owner" 2>/dev/null || true)
    is_id "$ID" || { release; exit 0; }
    OP="$ROOT/operations/$ID"
    [ ! -f "$OP/bundle" ] || BUNDLE=$(cat "$OP/bundle")
    # A crash during acceptance cannot have modified live config. Only the
    # published installing barrier permits installation, including v1/v2 records.
    if [ ! -f "$OP/phase" ]; then
        mkdir -p "$OP"; phase rejected
        rm -rf "$ROOT/operations/.accepting-$ID."*
        release; exit 0
    fi
    p=$(cat "$OP/phase")
    case "$p" in committed|rejected|rolled_back) release; exit 0;; accepted|prepared) phase rejected; release; exit 0;; esac
    if [ "$BUNDLE" = 1 ]; then
        check_bundle_recovery || { phase recovery_failed; fail 'Bundle changed or recovery copy is corrupt'; }
        install_bundle "$OP/before"
        phase boot_restored
        exit 0
    fi
    [ -f "$OP/before.jsonc" ] || fail 'Missing recovery copy'
    before=$(cat "$OP/before.sha256"); candidate=$(cat "$OP/candidate.sha256"); live=$(hash "$CFG")
    [ "$(hash "$OP/before.jsonc")" = "$before" ] || fail 'Corrupt recovery copy'
    if [ "$live" != "$before" ] && [ "$live" != "$candidate" ]; then phase recovery_failed; fail 'External config change'; fi
    install_file "$OP/before.jsonc"
    phase boot_restored;;
  boot-finish)
    [ ! -L "$LOCK" ] || exit 0
    # After S05xkeen: confirm startup, or restore the previously stopped state.
    [ -d "$LOCK" ] || exit 0
    ID=$(cat "$LOCK/owner"); is_id "$ID" || exit 0
    OP="$ROOT/operations/$ID"
    [ ! -f "$OP/bundle" ] || BUNDLE=$(cat "$OP/bundle")
    [ "$(cat "$OP/phase")" = boot_restored ] || exit 0
    before=$(cat "$OP/before.sha256")
    [ "$(current_hash)" = "$before" ] || { phase recovery_failed; fail 'Recovery file changed'; }
    if [ "$(cat "$OP/before.state")" = stopped ]; then
        run_xkeen -stop || { phase recovery_failed; exit 1; }
        [ "$(health)" = stopped ] || { phase recovery_failed; exit 1; }
    else
        verify "$before" || { phase recovery_failed; exit 1; }
    fi
    phase rolled_back; release;;
  ack)
    ID=${2:-}; is_id "$ID" || fail 'Invalid operation id'
    OP="$ROOT/operations/$ID"
    [ ! -f "$OP/bundle" ] || BUNDLE=$(cat "$OP/bundle")
    case "$(cat "$OP/phase")" in committed|rolled_back|rejected) :;; *) fail 'Operation is not complete';; esac
    write "$OP/ack" confirmed
    durable acknowledgment
    # The server has confirmed the outcome and owns long-term history. Keep ten
    # recent router copies plus the pinned original; never prune unacknowledged work.
    kept=0
    for ack in $(ls -t "$ROOT"/operations/*/ack); do
        kept=$((kept+1)); [ "$kept" -gt 10 ] || continue
        old=${ack%/ack}
        rm -rf "$old/before" "$old/candidate"
        rm -f "$old/before.jsonc" "$old/candidate.jsonc" "$old/log" "$old/recovery.log" "$old/supervisor.log"
    done;;
  control)
    action=${2:-}
    case "$action" in start|stop|restart) :;; *) fail 'Invalid action';; esac
    acquire control
    trap 'release' EXIT
    run_xkeen "-$action";;
  outbound)
    acquire outbound
    trap 'release' EXIT
    out="$CONFIGS/04_outbounds.json"
    tmp=$(mktemp "$CONFIGS/.xk-outbound.XXXXXX")
    cat > "$tmp"
    mv "$tmp" "$out"
    run_xkeen -restart;;
  *) fail 'Unknown command';;
esac
