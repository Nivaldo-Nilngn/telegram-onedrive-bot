const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const app = express();
app.use(express.json());

const token = process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const tenantId = process.env.TENANT_ID;
const userId = process.env.USER_ID;

if (!token || !clientId || !clientSecret || !tenantId || !userId) {
  console.error("Variáveis de ambiente não configuradas! Certifique-se de definir BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, TENANT_ID e USER_ID.");
  process.exit(1);
}

const bot = new TelegramBot(token);

const RENDER_URL = "https://telegram-onedrive-bot.onrender.com";

bot.setWebHook(`${RENDER_URL}/bot${token}`);

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
    console.log("✅ Token Microsoft obtido com sucesso.");
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Erro ao obter Token Microsoft:", error.response?.data || error.message);
    throw error;
  }
}

/* ===============================
   📤 Upload OneDrive
================================= */
async function uploadToOneDrive(fileName, fileBuffer) {
  const accessToken = await getAccessToken();

  // Encode o nome do arquivo para evitar erros com espaços ou caracteres especiais
  const safeFileName = encodeURIComponent(fileName);

  // Salva na pasta específica 'ebooksIgreja'
  const uploadUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/ebooksIgreja/${safeFileName}:/content`;

  console.log(`🚀 Tentando upload para: ${uploadUrl}`);

  const response = await axios.put(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
    },
  });

  console.log("✅ Resposta do OneDrive:", response.status);
  return response.data;
}

/* ===============================
   🤖 Webhook
================================= */
app.post(`/bot${token}`, async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

/* ===============================
   📥 Receber arquivo
================================= */
bot.on("document", async (msg) => {
  try {
    // Verifica se o arquivo é um PDF
    if (msg.document.mime_type !== "application/pdf" && !msg.document.file_name.toLowerCase().endsWith(".pdf")) {
      return bot.sendMessage(msg.chat.id, "⚠️ Por favor, envie apenas arquivos no formato PDF.");
    }

    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const response = await axios.get(fileUrl, {
      responseType: "arraybuffer",
    });

    await uploadToOneDrive(msg.document.file_name, response.data);

    bot.sendMessage(msg.chat.id, "✅ PDF enviado para a pasta ebooksIgreja!");
  } catch (error) {
    console.error(error.response?.data || error.message);
    bot.sendMessage(msg.chat.id, "❌ Erro ao enviar o PDF para o OneDrive.");
  }
});

/* ===============================
   🌐 Rotas HTTP
================================= */

app.get("/", (req, res) => {
  res.send("Bot está online 🚀");
});

// 👇 ESSA ROTA É O QUE O RENDER PRECISA
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});