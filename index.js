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
const ownChannel = process.env.OWN_CHANNEL;

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const tenantId = process.env.TENANT_ID;
const userId = process.env.USER_ID;

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

/* ===============================
   🔐 Autenticação OneDrive (MS Graph)
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
   � Verifica se arquivo existe no OneDrive (SEM baixar)
================================= */
async function fileExistsOnOneDrive(fileName, accessToken) {
  const safeFileName = encodeURIComponent(fileName);
  const checkUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/ebooksIgreja/${safeFileName}`;
  try {
    await axios.get(checkUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return true; // 404 lança erro, então true = arquivo existe
  } catch (error) {
    if (error.response?.status === 404) return false;
    throw error; // outro erro: relança
  }
}

/* ===============================
   📤 Upload OneDrive
================================= */
async function uploadToOneDrive(fileName, fileBuffer, accessToken) {
  const safeFileName = encodeURIComponent(fileName);
  const uploadUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/ebooksIgreja/${safeFileName}:/content`;

  console.log(`🚀 Uploading: ${fileName}...`);
  await axios.put(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  console.log(`✅ Upload concluído: ${fileName}`);
}

/* ===============================
   📅 Varredura Histórica Retroativa (Mês a Mês)
   Percorre o histórico do canal de 2025 para trás, 
   organizando por meses e verificando duplicatas.
================================= */
async function runHistoricalSync(channelPeer) {
  console.log("🚀 Iniciando sincronização histórica retroativa (2025 e anteriores)...");

  // O usuário já baixou tudo de 2026, então começamos ANTES de 1º de Janeiro de 2026
  const startBeforeDate = new Date("2026-01-01").getTime() / 1000;

  let syncedCount = 0;
  let skippedCount = 0;
  let currentMonth = -1;
  let currentYear = -1;

  try {
    const accessToken = await getAccessToken();
    let tokenRefreshAt = Date.now() + 50 * 60 * 1000;

    // offsetDate: inicia em mensagens anteriores a essa data
    const messageIterator = client.iterMessages(targetChannel, {
      offsetDate: startBeforeDate,
      limit: 10000 // Limite maior para pegar todo o histórico
    });

    for await (const message of messageIterator) {
      // Ignora mensagens sem documento PDF
      if (!message.media || !message.document) continue;

      const fileName = message.file?.name || `ebook_${message.id}.pdf`;
      if (!fileName.toLowerCase().endsWith(".pdf")) continue;

      // Lógica de Log Mensal
      const msgDate = new Date(message.date * 1000);
      const msgMonth = msgDate.getMonth();
      const msgYear = msgDate.getFullYear();

      if (msgMonth !== currentMonth || msgYear !== currentYear) {
        currentMonth = msgMonth;
        currentYear = msgYear;
        const monthName = msgDate.toLocaleString('pt-BR', { month: 'long' });
        console.log(`\n📅 --- [ PROCESSANDO: ${monthName.toUpperCase()} / ${currentYear} ] ---`);
      }

      // Renova token do OneDrive se necessário
      let currentToken = accessToken;
      if (Date.now() > tokenRefreshAt) {
        currentToken = await getAccessToken();
        tokenRefreshAt = Date.now() + 50 * 60 * 1000;
        console.log("🔑 Token OneDrive renovado.");
      }

      // ✅ VERIFICA DUPLICIDADE NO ONEDRIVE
      const exists = await fileExistsOnOneDrive(fileName, currentToken);
      if (exists) {
        process.stdout.write(`⏭️`); // Log compacto para arquivos que já existem
        skippedCount++;
        continue;
      }

      // Download e Upload
      console.log(`\n📥 [${msgYear}] Baixando: ${fileName}`);
      try {
        const buffer = await client.downloadMedia(message.media, { workers: 2 });
        await uploadToOneDrive(fileName, buffer, currentToken);
        syncedCount++;

        // Envia para o canal privado de backup
        await client.sendMessage(channelPeer, {
          message: `📚 **Histórico Recuperado (${monthName} / ${msgYear})**\n\nArquivo: \`${fileName}\`\n\n✅ Sincronizado.`,
          file: buffer,
        });

        console.log(`✨ [${syncedCount}] Concluído: ${fileName}`);
        // Pequena pausa para evitar limites de taxa da API
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        console.error(`❌ Erro ao processar ${fileName}:`, err.message);
      }
    }

    console.log(`\n\n🏁 Sincronização histórica finalizada.`);
    console.log(`✅ Novos arquivos: ${syncedCount} | ⏭️  Pulados (duplicados): ${skippedCount}`);

  } catch (err) {
    console.error("⚠️ Falha crítica na sincronização histórica:", err.message);
  }
}

/* ===============================
   🤖 Lógica do Userbot
================================= */
(async () => {
  await client.connect();
  console.log("💎 Userbot Conectado e Vigilante!");

  // Resolve canal de destino
  let channelPeer;
  try {
    if (ownChannel && ownChannel.includes("t.me/+")) {
      const inviteHash = ownChannel.split("+")[1];
      try {
        await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
      } catch (e) { }
      const dialogs = await client.getDialogs();
      const found = dialogs.find(
        (d) =>
          d.title?.toLowerCase().includes("ebook") ||
          d.title?.toLowerCase().includes("igreja")
      );
      channelPeer = found ? found.entity : ownChannel;
    } else {
      channelPeer = ownChannel ? await client.getEntity(ownChannel) : "me";
    }
  } catch (e) {
    channelPeer = ownChannel || "me";
  }

  // 1. Sincronização histórica em segundo plano
  runHistoricalSync(channelPeer);

  // 2. Escuta novas mensagens em tempo real
  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message.media || !message.document) return;

    const fileName = message.file?.name || `pdf_${Date.now()}.pdf`;
    if (!fileName.toLowerCase().endsWith(".pdf")) return;

    let chat;
    try {
      chat = await message.getChat();
    } catch (e) {
      return;
    }

    const source = chat.username || chat.title || "";
    const isTarget =
      source === targetChannel ||
      chat.id?.toString() === targetChannel ||
      message.isPrivate;

    if (!isTarget) return;

    console.log(`📩 PDF em tempo real: ${fileName}`);
    try {
      const accessToken = await getAccessToken();
      const exists = await fileExistsOnOneDrive(fileName, accessToken);

      if (exists) {
        console.log(`ℹ️ Já existe no OneDrive: ${fileName}`);
        return;
      }

      const buffer = await client.downloadMedia(message.media, { workers: 4 });
      await uploadToOneDrive(fileName, buffer, accessToken);

      await client.sendMessage(channelPeer, {
        message: `📚 **Novo eBook detectado em @${targetChannel}**\n\nArquivo: \`${fileName}\`\n\n✅ Salvo no OneDrive.`,
        file: buffer,
      });
      console.log(`✨ Finalizado (tempo real): ${fileName}`);
    } catch (err) {
      console.error(`❌ Erro (tempo real): ${err.message}`);
    }
  }, new NewMessage({ incoming: true }));
})();

const app = express();
app.get("/", (req, res) =>
  res.send("Userbot Ativo com Sincronismo Histórico ✅")
);
app.get("/health", (req, res) => res.status(200).send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Health check na porta ${PORT}`));