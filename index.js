require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const axios = require("axios");
const express = require("express");

/* ===============================
   ⚙️ Configurações (Ambiente)
================================= */
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.STRING_SESSION || "");
const targetChannel = process.env.TARGET_CHANNEL || "livrosemaudio";
const ownChannel = process.env.OWN_CHANNEL; // Link ou Username

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const tenantId = process.env.TENANT_ID;
const userId = process.env.USER_ID;

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

/* ===============================
   � Autenticação OneDrive (MS Graph)
================================= */
async function getAccessToken() {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "https://graph.microsoft.com/.default",
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });

  const response = await axios.post(url, params);
  return response.data.access_token;
}

/* ===============================
   📤 Upload OneDrive com Verificação
================================= */
async function uploadToOneDrive(fileName, fileBuffer) {
  const accessToken = await getAccessToken();
  const safeFileName = encodeURIComponent(fileName);
  const uploadUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/ebooksIgreja/${safeFileName}:/content`;

  // 🔍 Verifica se o arquivo já existe para evitar duplicatas
  try {
    const checkUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/ebooksIgreja/${safeFileName}`;
    await axios.get(checkUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    console.log(`ℹ️ Arquivo "${fileName}" já existe no OneDrive. Pulando.`);
    return { exists: true };
  } catch (error) {
    if (error.response?.status !== 404) {
      console.error(`❌ Erro ao verificar:`, error.message);
    }
  }

  console.log(`🚀 Uploading: ${fileName}...`);
  await axios.put(uploadUrl, fileBuffer, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" },
  });
  return { exists: false };
}

/* ===============================
   🤖 Lógica do Userbot
================================= */
(async () => {
  await client.connect();
  console.log("💎 Userbot Conectado e Vigilante!");

  let channelPeer;
  try {
    if (ownChannel.includes("t.me/+")) {
      const inviteHash = ownChannel.split("+")[1];
      try { await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash })); } catch (e) { }
      const dialogs = await client.getDialogs();
      const found = dialogs.find(d => d.title?.toLowerCase().includes("ebook") || d.title?.toLowerCase().includes("igreja"));
      channelPeer = found ? found.entity : ownChannel;
    } else {
      channelPeer = await client.getEntity(ownChannel);
    }
  } catch (e) { channelPeer = ownChannel; }

  client.addEventHandler(async (event) => {
    const message = event.message;
    if (message.media && message.document) {
      const fileName = message.file.name || `pdf_${Date.now()}.pdf`;
      if (!fileName.toLowerCase().endsWith(".pdf")) return;

      const chat = await message.getChat();
      const source = chat.username || chat.title || "Unknown";

      if (source === targetChannel || chat.id?.toString() === targetChannel || message.isPrivate) {
        console.log(`� PDF Detectado: ${fileName}`);
        try {
          const buffer = await client.downloadMedia(message.media, { workers: 4 });
          const result = await uploadToOneDrive(fileName, buffer);

          if (!result.exists) {
            await client.sendMessage(channelPeer, {
              message: `📚 **Novo eBook**\n\nArquivo: \`${fileName}\`\n\n✅ Salvo no OneDrive.`,
              file: buffer,
            });
            console.log(`✨ OK: ${fileName}`);
          }
        } catch (err) { console.error(`❌ Erro: ${err.message}`); }
      }
    }
  }, new NewMessage({ incoming: true }));
})();

const app = express();
app.get("/", (req, res) => res.send("Userbot Ativo 💎"));
app.get("/health", (req, res) => res.status(200).send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Health check na porta ${PORT}`));