#!/usr/bin/env sh
# Production entrypoint. Deliberately NO `set -e`: a migrate/seed hiccup, a slow/unready
# Postgres, or a gateway failure must never crash the container or block serving. Container
# liveness is tied only to Laravel on :8080; the Node gateway is a detached best-effort child.
cd /app || exit 1

# 1. Ensure a .env exists.
[ -f .env ] || cp .env.production .env

# 1b. Sync the injected runtime env (Postgres, URLs, name) INTO .env. `php artisan serve` runs under a
#     php.ini whose variables_order may exclude 'E', so $_ENV is empty and Dotenv falls back to the
#     .env defaults (DB_CONNECTION=sqlite) — making WEB requests hit an empty sqlite while the CLI uses
#     the real Postgres. Writing the real values into .env makes both agree.
for V in DB_CONNECTION DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD APP_URL ASSET_URL APP_NAME APP_ENV; do
    eval "VAL=\${$V}"
    [ -n "$VAL" ] || continue
    if grep -q "^$V=" .env; then
        grep -v "^$V=" .env > .env.tmp && mv .env.tmp .env
    fi
    printf '%s=%s\n' "$V" "$VAL" >> .env
done

# 2. Ensure a REAL base64 APP_KEY lives in .env (an empty APP_KEY makes config:cache bake app.key=''
#    → 500 on every authenticated route). Try artisan first; if it didn't persist one (it has silently
#    failed at boot), write one directly with /dev/urandom so this is bulletproof and never depends on
#    a working bootstrap.
if ! grep -q '^APP_KEY=base64:' .env 2>/dev/null; then
    php artisan key:generate --force 2>&1 | tail -1 || true
fi
if ! grep -q '^APP_KEY=base64:' .env 2>/dev/null; then
    NEWKEY="base64:$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
    grep -v '^APP_KEY=' .env > .env.tmp 2>/dev/null && mv .env.tmp .env
    printf 'APP_KEY=%s\n' "$NEWKEY" >> .env
    echo "[entrypoint] APP_KEY written via /dev/urandom fallback"
fi
export APP_KEY="$(grep '^APP_KEY=base64:' .env | head -1 | cut -d '=' -f2-)"

# 3. Ensure the SQLite database file and its directory exist (default path).
DB_DATABASE="${DB_DATABASE:-/app/database/database.sqlite}"
export DB_DATABASE
DB_DIR="$(dirname "$DB_DATABASE")"
mkdir -p "$DB_DIR" 2>/dev/null || true
[ -f "$DB_DATABASE" ] || touch "$DB_DATABASE" 2>/dev/null || true

# Make runtime dirs writable (best effort). storage/wa holds the single WhatsApp session
# creds — persist /app/storage (or /app/storage/wa) as a volume to survive redeploys.
mkdir -p storage/framework/cache storage/framework/sessions \
         storage/framework/views storage/logs storage/wa bootstrap/cache 2>/dev/null || true
mkdir -p /app/storage/wa 2>/dev/null || true
chmod -R ug+rwX storage bootstrap/cache "$DB_DIR" 2>/dev/null || true

# 4. Start the embedded Baileys gateway in the BACKGROUND before serving. It binds
#    127.0.0.1:3001 and talks to Laravel over localhost. It has its own Baileys reconnect
#    logic, so it is NOT auto-respawned here; if it dies, the WhatsApp link can be re-scanned
#    at /conectar. Never let it block or crash the container.
(
    cd /app/gateway && PORT=3001 \
      PANEL_WEBHOOK_URL=http://127.0.0.1:8080/api/wa/inbound \
      GATEWAY_TOKEN="$GATEWAY_TOKEN" \
      AUTH_DIR=/app/storage/wa \
      node src/index.js >> /app/storage/logs/gateway.log 2>&1
) &

# 5. Migrate + seed in the BACKGROUND, best-effort with a retry loop, so a
#    slow/unready database never blocks or crashes serving.
(
    i=1
    while [ "$i" -le 40 ]; do
        if php artisan migrate --force 2>&1; then
            php artisan db:seed --force 2>&1 || true
            echo "[entrypoint] migrate/seed completed on attempt $i"
            break
        fi
        echo "[entrypoint] migrate attempt $i failed; retrying in 3s..."
        i=$((i + 1))
        sleep 3
    done
) &

# 6. CACHE the config so WEB requests read a single stable baked config. `php artisan serve` does NOT
#    reliably resolve .env/$_ENV per request under its SAPI, so an un-cached web request silently fell
#    back to the .env sqlite default (empty → "no such table: users") while the CLI used Postgres.
#    This runs AFTER the env-sync (1b) and the APP_KEY export (2), so the cache bakes the real Postgres
#    creds + a real APP_KEY (caching with an empty exported key is what used to 500 every route).
#    If the baked key is somehow empty, regenerate + re-cache — NEVER config:clear (an un-cached web
#    request mis-resolves .env → sqlite → 500, which is exactly the bug we're avoiding).
php artisan config:cache 2>&1 | tail -1
if [ "$(php artisan tinker --execute='echo strlen(config("app.key"));' 2>/dev/null | tail -1)" = "0" ]; then
    echo "[entrypoint] baked APP_KEY empty — regenerating + re-caching"
    php artisan key:generate --force 2>&1 | tail -1
    export APP_KEY="$(grep '^APP_KEY=base64:' .env | head -1 | cut -d '=' -f2-)"
    php artisan config:cache 2>&1 | tail -1
fi

# 7. Serve under an auto-respawn loop: if a request ever crashes the dev server, it restarts
#    immediately, so the app is never permanently down (no `set -e`, so the loop always continues).
while true; do
    php artisan serve --host 0.0.0.0 --port 8080
    echo "[entrypoint] server exited (code $?); restarting in 1s..."
    sleep 1
done
