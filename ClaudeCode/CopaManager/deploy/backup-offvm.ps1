# Copa Manager - copia off-VM do backup do banco.
# Gera um backup fresco na VM (VACUUM INTO) e puxa o arquivo mais novo para uma
# pasta do OneDrive (que o proprio OneDrive replica para a nuvem da Microsoft,
# um provedor diferente da Oracle). Roda via Agendador de Tarefas do Windows.
# O backup diario NA VM continua sendo o principal; esta e a copia de seguranca.

$ErrorActionPreference = 'Stop'

$RAIZ = 'E:\OneDrive\Desktop\AI\ClaudeCode\CopaManager'
$KEY  = Join-Path $RAIZ 'ssh-key-2026-07-10 (1).key'
$VM   = 'ubuntu@163.176.150.136'
$DEST = 'E:\OneDrive\Backups\CopaManager'
$RETER = 30  # quantos backups manter localmente

New-Item -ItemType Directory -Force -Path $DEST | Out-Null
$LOG = Join-Path $DEST '_backup-offvm.log'
# UTF-8 explicito: o Agendador (nao-interativo) grava em UTF-16 por padrao,
# o que misturava a codificacao do log entre execucoes.
function Registrar($m) { Add-Content -Path $LOG -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" -Encoding utf8 }

try {
  if (-not (Test-Path $KEY)) { throw "Chave SSH nao encontrada: $KEY" }

  # 1) gera um backup fresco na VM e devolve o caminho do arquivo mais novo
  $novo = (ssh -i $KEY -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new $VM `
    'cd /opt/copamanager && sudo -u copamanager npm run backup >/dev/null 2>&1; ls -1t data/backups/*.db | head -1').Trim()
  if (-not $novo) { throw 'Nenhum backup encontrado na VM.' }
  $nome = Split-Path $novo -Leaf
  $alvo = Join-Path $DEST $nome

  # 2) puxa para o OneDrive (o usuario ubuntu le os backups direto)
  scp -i $KEY -o ConnectTimeout=25 "${VM}:/opt/copamanager/$novo" $alvo
  if (-not (Test-Path $alvo) -or (Get-Item $alvo).Length -eq 0) { throw "scp falhou: $nome nao chegou." }
  $kb = [math]::Round((Get-Item $alvo).Length / 1KB, 1)

  # 3) retencao local: mantem apenas os N backups mais recentes
  Get-ChildItem (Join-Path $DEST 'copamanager-*.db') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip $RETER | Remove-Item -Force -ErrorAction SilentlyContinue

  Registrar "OK    $nome  ($kb KB)"
  Write-Output "OK: $nome ($kb KB) -> $DEST"
} catch {
  Registrar "ERRO  $($_.Exception.Message)"
  Write-Error $_.Exception.Message
  exit 1
}
