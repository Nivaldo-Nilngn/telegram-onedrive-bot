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
   🔍 Validação de Nome de Arquivo
   Filtra arquivos com nomes genéricos (Telegram ID, WhatsApp DOC, etc)
================================= */
function isValidPdfName(fileName) {
  if (!fileName) return false;
  const nameWithoutExt = fileName.replace(/\.pdf$/i, "");

  // Regra: O nome deve conter pelo menos uma letra (latina ou acentuada).
  // Isso evita que arquivos com nomes puramente numéricos (ID do Telegram, timestamps, etc)
  // sejam sincronizados, pois ficariam estranhos para o usuário final.
  const hasLetters = /[a-zA-ZáéíóúâêîôûãõçÁÉÍÓÚÂÊÎÔÛÃÕÇ]/.test(nameWithoutExt);
  if (!hasLetters) return false;

  // 2. Padrao WhatsApp (DOC-20170203-WA0032)
  if (/^DOC-\d{8}-WA\d+$/i.test(nameWithoutExt)) return false;

  // 3. Nomes genéricos (ebook_123, pdf_123, file_123)
  if (/^(ebook|pdf|file|document)_\d+$/i.test(nameWithoutExt)) return false;

  return true;
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
   � Verifica se arquivo existe no OneDrive (SEM baixar)
================================= */
/* ===============================
   🧹 Sanitiza Nome do Arquivo
================================= */
function sanitizeFileName(fileName) {
  if (!fileName) return "documento.pdf";
  // Remove caracteres proibidos no OneDrive: " * : < > ? / \ |
  return fileName.replace(/["*:<>?/\\|]/g, "").replace(/\s+/g, " ").trim() || "documento.pdf";
}

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
   📤 Upload OneDrive (Suporta Arquivos Grandes)
================================= */
async function uploadToOneDrive(fileName, fileBuffer, accessToken) {
  const safeFileName = encodeURIComponent(fileName);
  const folderPath = "ebooksIgreja";
  const fileSize = fileBuffer.length;

  // Se o arquivo for pequeno (< 4MB), usamos o upload simples (opcional, mas vamos unificar no session para segurança)
  // Ou usamos upload simples para < 4MB para ser mais rápido.
  if (fileSize < 4 * 1024 * 1024) {
    const uploadUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}/${safeFileName}:/content`;
    console.log(`🚀 Uploading (Simple): ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);
    await axios.put(uploadUrl, fileBuffer, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
    });
  } else {
    // Arquivos > 4MB precisam de Upload Session
    console.log(`🚀 Uploading (Session): ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);

    // 1. Criar sessão de upload
    const sessionUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}/${safeFileName}:/createUploadSession`;
    const sessionResponse = await axios.post(sessionUrl, {}, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const uploadUrl = sessionResponse.data.uploadUrl;

    // 2. Upload em partes (bytes)
    const chunkSize = 320 * 1024 * 10; // 3.2MB por parte (deve ser múltiplo de 320KB)
    for (let start = 0; start < fileSize; start += chunkSize) {
      const end = Math.min(start + chunkSize, fileSize);
      const part = fileBuffer.slice(start, end);

      await axios.put(uploadUrl, part, {
        headers: {
          "Content-Range": `bytes ${start}-${end - 1}/${fileSize}`,
          "Content-Length": part.length,
        }
      });
      // process.stdout.write(".");
    }
  }
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
      limit: null // Varre todo o canal com paginação automática
    });

    for await (const message of messageIterator) {
      // 1. Lógica de Log Mensal (Top da iteração para mostrar progresso mesmo em meses sem PDFs)
      const msgDate = new Date(message.date * 1000);
      const msgMonth = msgDate.getMonth();
      const msgYear = msgDate.getFullYear();

      if (msgMonth !== currentMonth || msgYear !== currentYear) {
        currentMonth = msgMonth;
        currentYear = msgYear;
        const monthName = msgDate.toLocaleString('pt-BR', { month: 'long' });
        console.log(`\n📅 --- [ HISTÓRICO: Verificando ${monthName.toUpperCase()} / ${currentYear} ] ---`);
      }

      // 2. Filtros de Mensagem
      if (!message.media || !message.document) continue;

      const rawFileName = message.file?.name || `ebook_${message.id}.pdf`;
      if (!rawFileName.toLowerCase().endsWith(".pdf")) continue;
      const fileName = sanitizeFileName(rawFileName);

      // 3. Validação de Nome (Filtro solicitado: sem números puros)
      if (!isValidPdfName(fileName)) {
        process.stdout.write(`.`); // Ponto indica que achou um arquivo, mas o nome foi rejeitado
        continue;
      }

      // Renova token do OneDrive se necessário
      let currentToken = accessToken;
      if (Date.now() > tokenRefreshAt) {
        currentToken = await getAccessToken();
        tokenRefreshAt = Date.now() + 50 * 60 * 1000;
        console.log("🔑 Token OneDrive renovado.");
      }

      try {
        // ✅ VERIFICA DUPLICIDADE NO ONEDRIVE
        const exists = await fileExistsOnOneDrive(fileName, currentToken);
        if (exists) {
          process.stdout.write(`⏭️`); // Log compacto para arquivos que já existem
          skippedCount++;
          continue;
        }

        // Download e Upload
        console.log(`\n📥 [${msgYear}] Baixando: ${fileName}`);
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
        console.error(`\n❌ Erro ao processar ${fileName}:`, err.response ? JSON.stringify(err.response.data) : err.message);
      }
    }

    console.log(`\n\n🏁 Sincronização histórica finalizada.`);
    console.log(`✅ Novos arquivos: ${syncedCount} | ⏭️  Pulados (duplicados): ${skippedCount}`);

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

    const rawFileName = message.file?.name || `pdf_${Date.now()}.pdf`;
    if (!rawFileName.toLowerCase().endsWith(".pdf")) return;
    const fileName = sanitizeFileName(rawFileName);

    // ✅ FILTRO DE NOMES VÁLIDOS (Evita DOC-XXXX, 12345.pdf, etc)
    if (!isValidPdfName(fileName)) {
      console.log(`⏩ Ignorando nome genérico (tempo real): ${fileName}`);
      return;
    }

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