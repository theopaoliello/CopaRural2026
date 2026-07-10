# Deploy — Oracle Cloud Free Tier (ARM Ampere A1)

Guia para colocar o Pelada Épica no ar numa VM **ARM Ampere A1** (Always Free)
com **Caddy** (HTTPS automático) na frente e **systemd** mantendo o Node de pé.

Arquivos deste diretório:

| Arquivo | Vai para | Papel |
| --- | --- | --- |
| `pelada-epica.service` | `/etc/systemd/system/` | Serviço que roda o Node e reinicia sozinho |
| `pelada-epica.env.example` | `/etc/pelada-epica.env` | Variáveis de ambiente (porta, HTTPS, proxy) |
| `Caddyfile` | `/etc/caddy/Caddyfile` | Reverse proxy + certificado HTTPS automático |

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
`/opt/pelada-epica` (via `git clone` ou `scp`). O `data/` e o `uploads/` moram
aqui e **precisam sobreviver a cada atualização** — nunca apague o diretório.

```bash
sudo useradd --system --home /opt/pelada-epica --shell /usr/sbin/nologin pelada
sudo mkdir -p /opt/pelada-epica
# exemplo com git (ajuste para o seu repositório):
sudo git clone SEU_REPO /tmp/pe && sudo cp -r /tmp/pe/ClaudeCode/PeladaÉpica/app/. /opt/pelada-epica/
cd /opt/pelada-epica
sudo npm install --omit=dev          # instala só o Express
# data/ e uploads/ não vêm no repositório (são gitignored) e o serviço exige
# que existam — o sandbox do systemd só libera escrita nesses dois caminhos.
sudo mkdir -p /opt/pelada-epica/data /opt/pelada-epica/uploads
sudo chown -R pelada:pelada /opt/pelada-epica
```

## 5. Configurar ambiente, serviço e proxy

```bash
# Variáveis de ambiente
sudo cp /opt/pelada-epica/deploy/pelada-epica.env.example /etc/pelada-epica.env
# (revise /etc/pelada-epica.env — os padrões já servem para produção com HTTPS)

# Serviço systemd
sudo cp /opt/pelada-epica/deploy/pelada-epica.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pelada-epica
sudo systemctl status pelada-epica          # deve estar "active (running)"

# Caddy — edite o domínio no Caddyfile antes de copiar
sudo cp /opt/pelada-epica/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile               # troque peladaepica.com.br pelo seu domínio
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

## 6. Apontar o domínio

No seu registrador (ex.: Registro.br), crie um registro **A** apontando o
domínio para o **IP público** da VM. Quando o DNS propagar, o Caddy emite o
certificado HTTPS automaticamente no primeiro acesso. Teste:

```bash
curl -I https://SEU_DOMINIO        # espera 200 e o header Strict-Transport-Security
```

## 7. Criar o usuário master

```bash
# Registre sua conta pela tela do site (/), depois promova-a a master:
cd /opt/pelada-epica && sudo -u pelada npm run master -- seu-email@exemplo.com
```

## 8. Backup automático do banco

Agende o backup diário (mantém as 14 cópias mais recentes em `data/backups/`):

```bash
sudo crontab -u pelada -e
# adicione a linha:
0 4 * * * cd /opt/pelada-epica && /usr/bin/node scripts/backup-db.js >> /opt/pelada-epica/data/backup.log 2>&1
```

> Vale copiar `data/backups/` para fora da VM de tempos em tempos (Object Storage
> da Oracle, ou `scp` para outra máquina): backup só na mesma VM não protege
> contra perda da instância.

---

## Atualizar a aplicação depois

```bash
cd /opt/pelada-epica
sudo -u pelada git pull                 # ou reenvie os arquivos (NÃO toque em data/ e uploads/)
sudo npm install --omit=dev             # se dependências mudaram
sudo systemctl restart pelada-epica
```

## Diagnóstico

```bash
sudo systemctl status pelada-epica         # estado do serviço
sudo journalctl -u pelada-epica -f         # logs do Node ao vivo
sudo journalctl -u caddy -f                # logs do Caddy (inclui emissão do certificado)
```

Site fora do ar? Confira, nesta ordem: (1) `systemctl status` dos dois serviços;
(2) as portas 80/443 abertas **nos dois lugares** do passo 2; (3) o registro A do
DNS apontando para o IP certo.
