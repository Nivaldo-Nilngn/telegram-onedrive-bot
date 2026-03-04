const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const express = require("express");
const axios = require("axios");

// Configurações Express para o Render
const app = express();
app.use(express.json());

// Variáveis de Ambiente
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.STRING_SESSION || "");
const targetChannel = process.env.TARGET_CHANNEL || "livrosemaudio"; // Canal a vigiar
const ownChannel = process.env.OWN_CHANNEL; // Seu canal de destino

// OneDrive Env
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const tenantId = process.env.TENANT_ID;
const userId = process.env.USER_ID;

if (!apiId || !apiHash || !clientId || !clientSecret || !tenantId || !userId || !ownChannel) {
  console.error("❌ ERRO: Faltam variáveis de ambiente (API_ID, API_HASH, CLIENT_ID, ETC)");
  process.exit(1);
}

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

/* ===============================
   🔐 Token Microsoft Graph
================================= */
async function getAccessToken() {
  try {
    const response = await axios.post(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: clientId,
        scope: "https://graph.microsoft.com/.default",
        client_secret: clientSecret,
        grant_type: "client_credentials",
      })
    );
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Erro Token Microsoft:", error.response?.data || error.message);
    throw error;
  }
}

/* ===============================
   📤 Upload OneDrive
================================= */
async function uploadToOneDrive(fileName, fileBuffer) {
  const accessToken = await getAccessToken();
  const safeFileName = encodeURIComponent(fileName);
  const uploadUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/ebooksIgreja/${safeFileName}:/content`;

  console.log(`🚀 Uploading: ${fileName} para OneDrive...`);

  await axios.put(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
    },
  });
  console.log(`✅ ${fileName} salvo no OneDrive!`);
}

/* ===============================
   🤖 Lógica do Userbot
================================= */
(async () => {
  await client.connect();
  console.log("� Userbot Conectado e Vigilante!");

  client.addEventHandler(async (event) => {
    const message = event.message;

    // Verifica se a mensagem tem documento e se é de um canal/grupo
    if (message.media && message.document) {
      const fileName = message.file.name || `pdf_${Date.now()}.pdf`;

      // Filtra apenas PDF
      if (!fileName.toLowerCase().endsWith(".pdf")) return;

      console.log(`� Novo PDF detectado: ${fileName}`);

      try {
        // 1. Baixar o arquivo do Telegram (Streaming eficiente)
        const buffer = await client.downloadMedia(message.media, {
          workers: 4,
        });

        // 2. Enviar para o OneDrive
        await uploadToOneDrive(fileName, buffer);

        // 3. Postar no SEU Canal (Opcional, mas útil)
        await client.sendMessage(ownChannel, {
          message: `📚 Novo eBook detectado: **${fileName}**\nSalvo automaticamente no OneDrive.`,
          file: buffer,
        });

        console.log(`✨ Processo completo para: ${fileName}`);

      } catch (err) {
        console.error(`❌ Falha ao processar ${fileName}:`, err.message);
      }
    }
  }, new NewMessage({ incoming: true }));
})();

/* ===============================
   🌐 Rotas Express (Render)
================================= */
app.get("/", (req, res) => res.send("Userbot Ativo �"));
app.get("/health", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Monitor Express na porta ${PORT}`));