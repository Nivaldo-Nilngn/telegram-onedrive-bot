const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// 🔐 Pega o token do Render (Environment Variable)
const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("BOT_TOKEN não foi definido!");
  process.exit(1);
}

// 🤖 Inicia o bot
const bot = new TelegramBot(token, { polling: true });

bot.on("message", (msg) => {
  bot.sendMessage(msg.chat.id, "Bot está funcionando 🚀");
});

// 🌐 Servidor HTTP (para Render não dormir)
app.get("/", (req, res) => {
  res.send("Bot está online 🚀");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor web ativo");
});