# LeadPilot — WhatsApp Service (Baileys)

Gateway Node.js que conecta um número de WhatsApp ao LeadPilot via [Baileys](https://github.com/WhiskeySockets/Baileys), sem precisar da API oficial do Meta.

Ele:

1. Gera o QR Code de pareamento e publica em **Lovable Cloud** (tabela `whatsapp_sessions`) — o frontend do LeadPilot exibe o QR em tempo real via Realtime.
2. Recebe mensagens do WhatsApp, repassa o histórico para a Edge Function `chat-agent` (que chama a OpenAI) e devolve a resposta para o lead.
3. Aplica o **horário de atendimento** configurado em `agent_configs` — fora dele, responde com a mensagem padrão.
4. Cria/atualiza o lead, salva mensagens em `conversations` e atualiza qualificação automaticamente.

---

## 📁 Estrutura

```
whatsapp-service/
├── index.js              # Entry: Baileys socket + servidor Express
├── qr-handler.js         # Publica QR/status em whatsapp_sessions
├── message-handler.js    # Carrega lead/conversa, chama chat-agent, persiste tudo
├── scheduler.js          # Lê agent_configs e valida horário de atendimento
├── package.json
├── .env.example
└── README.md
```

---

## 🛠 Pré-requisitos

- Node.js **>= 20**
- Acesso ao projeto Lovable Cloud (Supabase) — você precisa da **`service_role` key**, NÃO da anon key
- O `WORKSPACE_ID` do workspace que este gateway vai atender (UUID da tabela `workspaces`)

> 💡 Como obter a `service_role` key e o `WORKSPACE_ID`: no LeadPilot, abra **Configurações → Workspace** para copiar o ID. A `service_role` está em **Lovable Cloud → API Keys** (acesse pelo botão "View Backend" do Lovable).

---

## 🚀 Instalação

```bash
cd whatsapp-service
cp .env.example .env
# edite .env com suas credenciais
npm install
npm start
```

Na primeira execução, o serviço vai:

1. Criar a pasta `./auth/` com as credenciais persistentes da sessão WhatsApp (não comite!)
2. Publicar o QR Code no Supabase
3. Aguardar você escanear pelo app do WhatsApp:  
   **Configurações → Aparelhos conectados → Conectar um aparelho**

Depois de pareado, a sessão fica salva em `./auth/` e reconecta sozinha em quedas de rede.

---

## 🔧 Variáveis de ambiente (`.env`)

| Variável | Descrição |
| --- | --- |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (servidor only) |
| `WORKSPACE_ID` | UUID do workspace que este gateway atende |
| `CHAT_AGENT_URL` | URL completa da edge function `chat-agent` |
| `PORT` | Porta do servidor HTTP (default `3333`) |
| `AUTH_DIR` | Pasta onde a sessão é persistida (default `./auth`) |

---

## 🌐 Endpoints HTTP

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET`  | `/health`     | Status do gateway + dados da sessão |
| `POST` | `/reconnect`  | Força logout + nova geração de QR |
| `POST` | `/send`       | Envia mensagem manual `{ "phone": "+5511...", "text": "..." }` |

---

## 🐳 Deploy com Docker (opcional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
VOLUME ["/app/auth"]
EXPOSE 3333
CMD ["node", "index.js"]
```

```bash
docker build -t leadpilot-wa .
docker run -d --name leadpilot-wa \
  --env-file .env \
  -v $(pwd)/auth:/app/auth \
  -p 3333:3333 \
  leadpilot-wa
```

> ⚠️ Mantenha o volume `/app/auth` persistido — sem ele você precisa parear o WhatsApp do zero a cada deploy.

---

## 🔐 Segurança

- A `service_role` key dá acesso total ao banco — **nunca** a coloque no frontend nem em repositórios públicos
- Rode o gateway em uma máquina dedicada (VPS, container, Raspberry, etc.)
- A pasta `auth/` contém as credenciais do WhatsApp — trate como senha

---

## 🧪 Testando localmente

1. Inicie o serviço: `npm start`
2. Abra o LeadPilot em **Configurações → WhatsApp** — o QR aparece automaticamente
3. Escaneie com o WhatsApp
4. Mande mensagem para o número conectado de outro celular — você verá a conversa surgir em **/conversations** no LeadPilot, com o agente respondendo

---

## ❓ Troubleshooting

| Problema | Solução |
| --- | --- |
| QR não aparece no LeadPilot | Verifique `WORKSPACE_ID` e a service_role no `.env`; cheque logs do serviço |
| `chat-agent` retorna 401 | A edge function precisa estar deployada (Lovable faz isso automaticamente) e o `CHAT_AGENT_URL` correto |
| Desconectou e ficou em loop | Apague a pasta `./auth/` e pareie de novo |
| Mensagens chegam mas não respondem | Confira `agent_configs.business_hours_*` e `active_days` — pode estar fora do horário |
