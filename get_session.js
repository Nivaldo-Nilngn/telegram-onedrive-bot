const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = 31636935; // Coloque seu API ID aqui
const apiHash = "5571bf4e02da970cda1ca9962590a398"; // Coloque sua API HASH aqui
const stringSession = new StringSession(""); // Vazio para começar uma nova sessão

(async () => {
    console.log("Iniciando login...");
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({
        phoneNumber: async () => await input.text("Seu número (Ex: +5511999999999): "),
        password: async () => await input.text("Sua senha de 2 etapas (se tiver): "),
        phoneCode: async () => await input.text("O código que o Telegram te enviou: "),
        onError: (err) => console.log(err),
    });

    console.log("\n✅ Login realizado com sucesso!");
    console.log("\n--- COPIE O CÓDIGO ABAIXO (TUDO, INCLUSIVE O FINAL) ---");
    console.log(client.session.save()); // Salva e exibe a session string
    console.log("--- FIM DO CÓDIGO ---\n");

    process.exit(0);
})();
