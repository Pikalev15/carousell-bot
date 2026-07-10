param(
  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$User = "",
  [string]$RemoteDir = "~/carousell-bot",
  [string]$Repo = "https://github.com/Pikalev15/carousell-bot.git",
  [string]$Branch = "main",
  [int]$Port = 3000,
  [string]$DashboardToken = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw "ssh was not found on this PC. Install OpenSSH Client or run from a shell that has ssh."
}

$tokenWasProvided = -not [string]::IsNullOrWhiteSpace($DashboardToken)
if (-not $tokenWasProvided) {
  $DashboardToken = [Convert]::ToBase64String([Guid]::NewGuid().ToByteArray()).TrimEnd("=")
}

$target = if ([string]::IsNullOrWhiteSpace($User)) { $HostName } else { "$User@$HostName" }

function Quote-BashArg([string]$Value) {
  return "'" + ($Value -replace "'", "'\''") + "'"
}

$remoteScript = @'
set -euo pipefail

REMOTE_DIR="$1"
REPO="$2"
BRANCH="$3"
HOST_PORT="$4"
DASHBOARD_TOKEN_VALUE="$5"
TOKEN_WAS_PROVIDED="$6"

case "$REMOTE_DIR" in
  "~")
    REMOTE_DIR="$HOME"
    ;;
  "~/"*)
    REMOTE_DIR="$HOME/${REMOTE_DIR#~/}"
    ;;
esac

if ! command -v git >/dev/null 2>&1; then
  echo "git is required on the NAS." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required on the NAS." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Docker Compose is required on the NAS." >&2
  exit 1
fi

PARENT_DIR="$(dirname "$REMOTE_DIR")"
mkdir -p "$PARENT_DIR"

if [ ! -d "$REMOTE_DIR/.git" ]; then
  rm -rf "$REMOTE_DIR"
  git clone --branch "$BRANCH" "$REPO" "$REMOTE_DIR"
else
  cd "$REMOTE_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
fi

cd "$REMOTE_DIR"
mkdir -p data logs
PUID_VALUE="$(id -u)"
PGID_VALUE="$(id -g)"
chmod -R u+rwX,g+rwX data logs 2>/dev/null || true

if [ ! -f .env ]; then
  cat > .env <<EOF
CAROUSELL_BOT_PORT=$HOST_PORT
DASHBOARD_TOKEN=$DASHBOARD_TOKEN_VALUE
TZ=Asia/Singapore
PUID=$PUID_VALUE
PGID=$PGID_VALUE
EOF
  chmod 600 .env
else
  update_env_var() {
    key="$1"
    value="$2"
    if grep -q "^${key}=" .env; then
      awk -v key="$key" -v value="$value" 'BEGIN { FS = OFS = "=" } $1 == key { $0 = key "=" value } { print }' .env > .env.tmp
      mv .env.tmp .env
    else
      printf '%s=%s\n' "$key" "$value" >> .env
    fi
  }

  update_env_var "CAROUSELL_BOT_PORT" "$HOST_PORT"
  update_env_var "TZ" "Asia/Singapore"
  update_env_var "PUID" "$PUID_VALUE"
  update_env_var "PGID" "$PGID_VALUE"
  if [ "$TOKEN_WAS_PROVIDED" = "1" ] || ! grep -q "^DASHBOARD_TOKEN=" .env; then
    update_env_var "DASHBOARD_TOKEN" "$DASHBOARD_TOKEN_VALUE"
  fi
  chmod 600 .env
fi

EFFECTIVE_DASHBOARD_TOKEN="$(awk -F= '$1 == "DASHBOARD_TOKEN" { value = substr($0, length($1) + 2) } END { print value }' .env)"

$COMPOSE up -d --build
$COMPOSE ps

echo ""
echo "Carousell Bot is deployed."
echo "Open: http://$(hostname -I 2>/dev/null | awk '{print $1}'):$HOST_PORT"
echo "Dashboard token: $EFFECTIVE_DASHBOARD_TOKEN"
'@

$args = @($RemoteDir, $Repo, $Branch, [string]$Port, $DashboardToken, $(if ($tokenWasProvided) { "1" } else { "0" })) | ForEach-Object { Quote-BashArg $_ }
$remoteCommand = "bash -s -- $($args -join ' ')"

Write-Host "Deploying Carousell Bot to ${target}:$RemoteDir on branch $Branch..."
$remoteScript | ssh $target $remoteCommand
