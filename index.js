require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const axios = require("axios");
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");

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
   🔍 Validação de Nome de Arquivo
================================= */
function isValidPdfName(fileName) {
  if (!fileName) return false;
  const nameWithoutExt = fileName.replace(/\.pdf$/i, "");
  const hasLetters = /[a-zA-ZáéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ]/.test(nameWithoutExt);
  if (!hasLetters) return false;
  if (/^DOC-\d{8}-WA\d+$/i.test(nameWithoutExt)) return false;
  if (/^(ebook|pdf|file|document)_\d+$/i.test(nameWithoutExt)) return false;
  return true;
}

/* ===============================
   🧹 Sanitiza Nome do Arquivo
================================= */
function sanitizeFileName(fileName) {
  if (!fileName) return "documento.pdf";
  return fileName.replace(/["*:<>?/\\|]/g, "").replace(/\s+/g, " ").trim() || "documento.pdf";
}

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
   🔎 Verifica se arquivo já existe no OneDrive
================================= */
async function fileExistsOnOneDrive(fileName, accessToken) {
  const safeFileName = encodeURIComponent(fileName);
  const checkUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/ebooksIgreja/${safeFileName}`;
  try {
    await axios.get(checkUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return true;
  } catch (error) {
    if (error.response?.status === 404) return false;
    throw error;
  }
}

/* ===============================
   📤 Upload OneDrive — OTIMIZADO PARA MEMÓRIA
   Usa Upload Session em partes com leitura direta 
   do disco, evitando manter o arquivo na RAM.
================================= */
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB por parte (reduzido para economizar ainda mais RAM)

async function uploadToOneDriveChunked(fileName, filePath, accessToken) {
  const safeFileName = encodeURIComponent(fileName);
  const folderPath = "ebooksIgreja";
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  console.log(`🚀 Uploading: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);

  // Arquivo pequeno < 4 MB → upload simples
  if (fileSize < 4 * 1024 * 1024) {
    const uploadUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}/${safeFileName}:/content`;
    const stream = fs.createReadStream(filePath);
    await axios.put(uploadUrl, stream, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": fileSize,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 600000,
    });
    console.log(`✅ Upload simples concluído: ${fileName}`);
    return;
  }

  // Arquivo grande → Upload Session em partes (baixo uso de RAM)
  const sessionUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}/${safeFileName}:/createUploadSession`;
  const sessionResponse = await axios.post(sessionUrl, {}, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const uploadUrl = sessionResponse.data.uploadUrl;

  for (let start = 0; start < fileSize; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const length = end - start;
    const stream = fs.createReadStream(filePath, { start, end: end - 1 });

    await axios.put(uploadUrl, stream, {
      headers: {
        "Content-Range": `bytes ${start}-${end - 1}/${fileSize}`,
        "Content-Length": length,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 600000,
    });

    const progress = ((end / fileSize) * 100).toFixed(0);
    process.stdout.write(`\r  ↑ ${fileName}: ${progress}%   `);
  }

  if (global.gc) global.gc(); // Coleta lixo se disponível

  console.log(`\n✅ Upload em partes concluído: ${fileName}`);
}

/* ===============================
   📅 Varredura Histórica — OTIMIZADA
   Processa UM arquivo por vez, libera memória entre cada um.
================================= */
async function runHistoricalSync(channelPeer) {
  console.log("🚀 Iniciando sincronização histórica retroativa...");

  const startBeforeDate = new Date("2026-01-01").getTime() / 1000;
  let syncedCount = 0;
  let skippedCount = 0;
  let currentMonth = -1;
  let currentYear = -1;

  try {
    let accessToken = await getAccessToken();
    let tokenRefreshAt = Date.now() + 50 * 60 * 1000;

    const messageIterator = client.iterMessages(targetChannel, {
      offsetDate: startBeforeDate,
      limit: null,
    });

    for await (const message of messageIterator) {
      // Log mensal de progresso
      const msgDate = new Date(message.date * 1000);
      const msgMonth = msgDate.getMonth();
      const msgYear = msgDate.getFullYear();

      if (msgMonth !== currentMonth || msgYear !== currentYear) {
        currentMonth = msgMonth;
        currentYear = msgYear;
        const monthName = msgDate.toLocaleString("pt-BR", { month: "long" });
        console.log(`\n📅 --- [ ${monthName.toUpperCase()} / ${currentYear} ] ---`);
        // Força GC entre meses para liberar memória acumulada
        if (global.gc) global.gc();
      }

      // Filtros básicos
      if (!message.media || !message.document) continue;
      const rawFileName = message.file?.name || `ebook_${message.id}.pdf`;
      if (!rawFileName.toLowerCase().endsWith(".pdf")) continue;
      const fileName = sanitizeFileName(rawFileName);
      if (!isValidPdfName(fileName)) { process.stdout.write("."); continue; }

      // Renova token se necessário
      if (Date.now() > tokenRefreshAt) {
        accessToken = await getAccessToken();
        tokenRefreshAt = Date.now() + 50 * 60 * 1000;
        console.log("🔑 Token OneDrive renovado.");
      }

      try {
        const exists = await fileExistsOnOneDrive(fileName, accessToken);
        if (exists) { process.stdout.write("⏭️"); skippedCount++; continue; }

        console.log(`\n📥 [${msgYear}] Baixando para o disco: ${fileName}`);

        const tempFilePath = path.join(os.tmpdir(), fileName);

        // ✅ Baixa diretamente para o disco
        await client.downloadMedia(message.media, {
          workers: 1,
          outputFile: tempFilePath
        });

        // ✅ Faz o upload a partir do disco
        await uploadToOneDriveChunked(fileName, tempFilePath, accessToken);

        // ✅ Apaga o arquivo temporário
        if (fs.existsSync(tempFilePath)) {
          fs.rmSync(tempFilePath, { force: true });
        }

        // ✅ Notifica canal SEM reenviar o arquivo (economiza memória)
        const monthName = msgDate.toLocaleString("pt-BR", { month: "long" });
        await client.sendMessage(channelPeer, {
          message: `📚 **Histórico Recuperado (${monthName} / ${msgYear})**\n\nArquivo: '${fileName}'\n\n✅ Sincronizado no OneDrive.`,
        });

        syncedCount++;
        console.log(`✨[${syncedCount}]Concluído: ${fileName}`);

        // Pausa entre arquivos para dar tempo ao GC liberar recursos
        await new Promise((r) => setTimeout(r, 2000));

      } catch (err) {
        console.error(`\n❌ Erro ao processar ${fileName}: `, err.response ? JSON.stringify(err.response.data) : err.message);
        const tempFilePath = path.join(os.tmpdir(), fileName);
        if (fs.existsSync(tempFilePath)) {
          fs.rmSync(tempFilePath, { force: true });
        }
        // Continua mesmo em caso de erro
      }
    }

    console.log(`\n\n🏁 Sincronização histórica finalizada.`);
    console.log(`✅ Novos: ${syncedCount} | ⏭️  Pulados: ${skippedCount}`);

  } catch (err) {
    console.error("⚠️ Falha crítica na sincronização histórica:");
    if (err.response) {
      console.error(`Status: ${err.response.status}`);
      console.error(`Data: ${JSON.stringify(err.response.data)}`);
    } else {
      console.error(err.message);
    }
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
      try { await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash })); } catch (e) { }
      const dialogs = await client.getDialogs();
      const found = dialogs.find(
        (d) => d.title?.toLowerCase().includes("ebook") || d.title?.toLowerCase().includes("igreja")
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

    const rawFileName = message.file?.name || `pdf_${Date.now()}.pdf`;
    if (!rawFileName.toLowerCase().endsWith(".pdf")) return;
    const fileName = sanitizeFileName(rawFileName);

    if (!isValidPdfName(fileName)) {
      console.log(`⏩ Ignorando nome genérico(tempo real): ${fileName}`);
      return;
    }

    let chat;
    try { chat = await message.getChat(); } catch (e) { return; }

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

      // ✅ Baixa, sobe em partes lendo do disco, e libera armazenamento
      const tempFilePath = path.join(os.tmpdir(), fileName);
      await client.downloadMedia(message.media, {
        workers: 1,
        outputFile: tempFilePath
      });
      await uploadToOneDriveChunked(fileName, tempFilePath, accessToken);

      if (fs.existsSync(tempFilePath)) {
        fs.rmSync(tempFilePath, { force: true });
      }

      // ✅ Notifica sem reenviar o arquivo inteiro
      await client.sendMessage(channelPeer, {
        message: `📚 ** Novo eBook detectado em @${targetChannel} **\n\nArquivo: \`${fileName}\`\n\n✅ Salvo no OneDrive.`,
      });
      console.log(`✨ Finalizado (tempo real): ${fileName}`);
    } catch (err) {
      console.error(`❌ Erro (tempo real): ${err.message}`);
      const tempFilePath = path.join(os.tmpdir(), fileName);
      if (fs.existsSync(tempFilePath)) {
        fs.rmSync(tempFilePath, { force: true });
      }
    }
  }, new NewMessage({ incoming: true }));
})();

const app = express();
app.get("/", (req, res) => res.send("Userbot Ativo com Sincronismo Histórico ✅"));
app.get("/health", (req, res) => res.status(200).send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Health check na porta ${PORT}`));