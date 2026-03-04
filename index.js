const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const app = express();

const token = process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const tenantId = process.env.TENANT_ID;

if (!token || !clientId || !clientSecret || !tenantId) {
  console.error("Variáveis de ambiente não configuradas!");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

/* ===============================
   🔐 Pega token Microsoft Graph
================================= */
async function getAccessToken() {
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
}

/* ===============================
   📤 Upload para OneDrive
================================= */
async function uploadToOneDrive(fileName, fileBuffer) {
  const accessToken = await getAccessToken();

  const uploadUrl = `https://graph.microsoft.com/v1.0/users/4d9c425f-abc5-4f86-a275-f2280196fd83/drive/root:/${fileName}:/content`;

  const response = await axios.put(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
    },
  });

  return response.data;
}

/* ===============================
   🤖 Quando receber arquivo
================================= */
bot.on("document", async (msg) => {
  try {
    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
    });

    await uploadToOneDrive(msg.document.file_name, response.data);

    bot.sendMessage(msg.chat.id, "✅ Arquivo enviado para o OneDrive!");
  } catch (error) {
    console.error(error.response?.data || error.message);
    bot.sendMessage(msg.chat.id, "❌ Erro ao enviar para OneDrive.");
  }
});

/* ===============================
   🌐 Servidor HTTP (Render)
================================= */
app.get("/", (req, res) => {
  res.send("Bot está online 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor web ativo");
});