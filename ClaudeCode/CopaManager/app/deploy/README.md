# Deploy — Oracle Cloud Free Tier (ARM Ampere A1)

Guia para colocar o Copa Manager no ar numa VM **ARM Ampere A1** (Always Free)
com **Caddy** (HTTPS automático) na frente e **systemd** mantendo o Node de pé.

Arquivos deste diretório:

| Arquivo | Vai para | Papel |
| --- | --- | --- |
| `copamanager.service` | `/etc/systemd/system/` | Serviço que roda o Node e reinicia sozinho |
| `copamanager.env.example` | `/etc/copamanager.env` | Variáveis de ambiente (porta, HTTPS, proxy) |
| `Caddyfile` | `/etc/caddy/Caddyfile` | Reverse proxy + certificado HTTPS automático |

> **Já tinha a instalação antiga como "pelada-epica" no ar?** Pule direto para
> [Migração: pelada-epica → copamanager](#migração-pelada-epica--copamanager)
> no fim deste guia.

---

## 1. Criar a instância

No console da Oracle: **Compute → Instances → Create instance**.

- **Shape**: `VM.Standard.A1.Flex` (ARM Ampere, Always Free). Peça **2 OCPUs / 6–12 GB
  de RAM** — sobra para este app. Se der `Out of host capacity`, tente outro
  *Availability Domain* ou repita mais tarde (é a disputa pelo hardware grátis).
- **Image**: Canonical **Ubuntu 22.04/24.04** (aarch64).
- **SSH**: adicione sua chave pública. Guarde a chave privada.

Anote o **IP público** ao final.

## 2. Abrir as portas 80 e 443 — nos DOIS lugares (pegadinha da Oracle)

O tráfego só passa se as portas estiverem abertas **na rede da Oracle E no
firewall da VM**. Esquecer o segundo é o erro nº 1 de quem usa Oracle.

**a) Security List da VCN** (console web): abra a subnet da instância →
**Security Lists** → **Add Ingress Rules**, duas regras:

- Source `0.0.0.0/0`, IP Protocol `TCP`, Destination Port `80`
- Source `0.0.0.0/0`, IP Protocol `TCP`, Destination Port `443`

**b) Firewall da própria VM** (por SSH): as imagens Ubuntu da Oracle vêm com
regras `iptables` que barram tudo, menos SSH. Abra 80/443 **antes** da regra de
REJECT e persista:

```bash
ssh ubuntu@SEU_IP
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
# Confira que os ACCEPT estão ACIMA do REJECT final:
sudo iptables -L INPUT --line-numbers
```

Se o REJECT não estiver na posição esperada, ajuste o número após `-I INPUT`.

## 3. Instalar Node 24 e Caddy

```bash
# Node 24 (obrigatório: node:sqlite exige 22.5+; usamos 24 LTS)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy (repositório oficial)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

node --version   # confirme v24.x
```

## 4. Enviar a aplicação

Crie o usuário de serviço e coloque **o conteúdo da pasta `app/`** em
`/opt/copamanager` (via `git clone` ou `scp`). O `data/` e o `uploads/` moram
aqui e **precisam sobreviver a cada atualização** — nunca apague o diretório.

```bash
sudo useradd --system --home /opt/copamanager --shell /usr/sbin/nologin copamanager
sudo mkdir -p /opt/copamanager
# exemplo com git (ajuste para o seu repositório):
sudo git clone SEU_REPO /tmp/cm && sudo cp -r /tmp/cm/ClaudeCode/CopaManager/app/. /opt/copamanager/
cd /opt/copamanager
sudo npm install --omit=dev          # instala só o Express
# data/ e uploads/ não vêm no repositório (são gitignored) e o serviço exige
# que existam — o sandbox do systemd só libera escrita nesses dois caminhos.
sudo mkdir -p /opt/copamanager/data /opt/copamanager/uploads
sudo chown -R copamanager:copamanager /opt/copamanager
```

## 5. Configurar ambiente, serviço e proxy

```bash
# Variáveis de ambiente
sudo cp /opt/copamanager/deploy/copamanager.env.example /etc/copamanager.env
# (revise /etc/copamanager.env — os padrões já servem para produção com HTTPS)

# Serviço systemd
sudo cp /opt/copamanager/deploy/copamanager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now copamanager
sudo systemctl status copamanager          # deve estar "active (running)"

# Caddy — o Caddyfile já vem com copamanager.com.br; ajuste se o domínio for outro
sudo cp /opt/copamanager/deploy/Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

## 6. Apontar o domínio

No seu registrador (ex.: Registro.br), crie um registro **A** apontando o
domínio para o **IP público** da VM. Quando o DNS propagar, o Caddy emite o
certificado HTTPS automaticamente no primeiro acesso. Teste:

```bash
curl -I https://copamanager.com.br     # espera 200 e o header Strict-Transport-Security
```

## 7. Criar o usuário master

```bash
# Registre sua conta pela tela do site (/), depois promova-a a master:
cd /opt/copamanager && sudo -u copamanager npm run master -- seu-email@exemplo.com
```

## 8. Backup automático do banco

Agende o backup diário (mantém as 14 cópias mais recentes em `data/backups/`):

```bash
sudo crontab -u copamanager -e
# adicione a linha:
0 4 * * * cd /opt/copamanager && /usr/bin/node scripts/backup-db.js >> /opt/copamanager/data/backup.log 2>&1
```

> Vale copiar `data/backups/` para fora da VM de tempos em tempos (Object Storage
> da Oracle, ou `scp` para outra máquina): backup só na mesma VM não protege
> contra perda da instância.

---

## Atualizar a aplicação depois

```bash
cd /opt/copamanager
sudo -u copamanager git pull            # ou reenvie os arquivos (NÃO toque em data/ e uploads/)
sudo npm install --omit=dev             # se dependências mudaram
sudo systemctl restart copamanager
```

## Migração: pelada-epica → copamanager

Roteiro para uma VM que já rodava a instalação antiga (serviço `pelada-epica`,
usuário `pelada`, banco `data/pelada.db`). **Sem perda de dados** — na dúvida,
tire um backup antes (`cd /opt/pelada-epica && sudo -u pelada npm run backup`).

```bash
# 0. Backup de segurança
cd /opt/pelada-epica && sudo -u pelada npm run backup

# 1. Pare o serviço antigo
sudo systemctl stop pelada-epica

# 2. Renomeie usuário, grupo e diretório
sudo usermod -l copamanager pelada
sudo groupmod -n copamanager pelada
sudo mv /opt/pelada-epica /opt/copamanager
sudo usermod -d /opt/copamanager copamanager

# 3. Renomeie o banco (os -wal/-shm só existem se o processo caiu sem fechar)
cd /opt/copamanager/data
sudo mv pelada.db copamanager.db
sudo mv pelada.db-wal copamanager.db-wal 2>/dev/null || true
sudo mv pelada.db-shm copamanager.db-shm 2>/dev/null || true

# 4. Atualize o código para a versão renomeada
cd /opt/copamanager
sudo -u copamanager git pull            # ou reenvie os arquivos
# Atenção: no repositório a pasta mudou de ClaudeCode/PeladaÉpica para
# ClaudeCode/CopaManager — se você faz deploy por cp/scp, ajuste a origem.

# 5. Troque o serviço systemd e o arquivo de ambiente
sudo mv /etc/pelada-epica.env /etc/copamanager.env
sudo systemctl disable pelada-epica
sudo rm /etc/systemd/system/pelada-epica.service
sudo cp deploy/copamanager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now copamanager
sudo systemctl status copamanager       # deve estar "active (running)"

# 6. Cron do backup: o rename do usuário NÃO renomeia o crontab — mova e ajuste
sudo mv /var/spool/cron/crontabs/pelada /var/spool/cron/crontabs/copamanager 2>/dev/null || true
sudo crontab -u copamanager -e          # troque /opt/pelada-epica por /opt/copamanager na linha

# 7. (Opcional) Log do Caddy com o nome novo
sudo nano /etc/caddy/Caddyfile          # output file /var/log/caddy/copamanager.log
sudo systemctl reload caddy

# 8. Confira o site no ar
curl -I https://copamanager.com.br      # espera 200
```

Os backups antigos (`data/backups/pelada-*.db`) continuam válidos — o script
novo só grava e rotaciona os `copamanager-*.db`; apague os antigos quando não
precisar mais deles.

## Diagnóstico

```bash
sudo systemctl status copamanager          # estado do serviço
sudo journalctl -u copamanager -f          # logs do Node ao vivo
sudo journalctl -u caddy -f                # logs do Caddy (inclui emissão do certificado)
```

Site fora do ar? Confira, nesta ordem: (1) `systemctl status` dos dois serviços;
(2) as portas 80/443 abertas **nos dois lugares** do passo 2; (3) o registro A do
DNS apontando para o IP certo.
