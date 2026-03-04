const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const TENANT_ID = process.env.TENANT_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function getAccessToken() {
  const response = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      scope: "https://graph.microsoft.com/.default",
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  );
  return response.data.access_token;
}

async function fileExists(filename, token) {
  try {
    await axios.get(
      `https://graph.microsoft.com/v1.0/me/drive/root:/ebooksIgreja/${filename}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return true;
  } catch {
    return false;
  }
}

bot.on('channel_post', async (msg) => {
  if (!msg.document) return;
  if (!msg.document.file_name.endsWith(".pdf")) return;

  const fileName = msg.document.file_name;
  console.log("Recebido:", fileName);

  const file = await bot.getFile(msg.document.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  fs.writeFileSync(fileName, response.data);

  const token = await getAccessToken();
  const exists = await fileExists(fileName, token);

  if (exists) {
    console.log("Já existe:", fileName);
    fs.unlinkSync(fileName);
    return;
  }

  await axios.put(
    `https://graph.microsoft.com/v1.0/me/drive/root:/ebooksIgreja/${fileName}:/content`,
    fs.readFileSync(fileName),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/pdf"
      }
    }
  );

  fs.unlinkSync(fileName);
  console.log("Enviado com sucesso:", fileName);
});