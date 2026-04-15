const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// --- CONFIGURATION ---
// IMPORTANT: Replace the placeholders below with your actual API Keys
const HELIUS_KEY = "YOUR_HELIUS_API_KEY_HERE";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Utility: Delay function to prevent Telegram Rate Limiting (Spam Blocks)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to extract Solana Address from Text or URL
function extractAddress(input) {
    // Regex to find 32-44 character Base58 string (Solana wallet format)
    const solanaAddrRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
    const match = input.match(solanaAddrRegex);
    return match ? match[0] : null;
}

console.log("⚡ Dev Scanner Bot is Active...");

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();

    if (!text) return;

    if (text === "/start") {
        bot.sendMessage(chatId, "👋 **Welcome to Dev Scanner!**\n\nSend me any Solana Wallet Address or Solscan link to discover all tokens created by that developer.", { parse_mode: 'Markdown' });
        return;
    }

    // Extract address from the input
    const walletAddress = extractAddress(text);

    if (walletAddress) {
        bot.sendMessage(chatId, `🕵️ **Scanning Dev Projects...**\nTarget: \`${walletAddress}\``, { parse_mode: 'Markdown' });

        try {
            const response = await axios.post(RPC_URL, {
                jsonrpc: "2.0",
                id: "authority-scan",
                method: "getAssetsByAuthority",
                params: {
                    authorityAddress: walletAddress,
                    page: 1,
                    limit: 15
                }
            });

            const assets = response.data.result?.items;

            if (assets && assets.length > 0) {
                // Loop with a delay to prevent Telegram Spam limit (Error 429)
                for (let i = 0; i < assets.length; i++) {
                    const asset = assets[i];
                    
                    // Fallback if metadata is empty
                    const name = asset.content?.metadata?.name || "Unknown Token";
                    const symbol = asset.content?.metadata?.symbol || "UNKNOWN";
                    const mint = asset.id;

                    const caption = `🔥 **Project #${i + 1}: ${name}**\n\n` +
                                    `**Symbol:** $${symbol}\n` +
                                    `**CA:** \`${mint}\`\n\n` +
                                    `👇 *Check details below:*`;

                    const opts = {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: "🔍 Scan via Rick Bot",
                                        url: `https://t.me/RickBurpBot?start=${mint}`
                                    },
                                    {
                                        text: "📊 DexScreener",
                                        url: `https://dexscreener.com/solana/${mint}`
                                    }
                                ]
                            ]
                        }
                    };

                    await bot.sendMessage(chatId, caption, opts);
                    
                    // Pause for 500ms before sending the next message
                    await delay(500); 
                }
            } else {
                bot.sendMessage(chatId, "❌ **No tokens found.**\nThis wallet hasn't deployed any standard SPL tokens.", { parse_mode: 'Markdown' });
            }

        } catch (error) {
            console.error("Error fetching from Helius:", error.response?.data || error.message);
            bot.sendMessage(chatId, "⚠️ **Technical Error.**\nFailed to scan the developer wallet. Please check your Helius API Key.", { parse_mode: 'Markdown' });
        }
    } else {
        // If the user sends normal text that doesn't contain a Solana address
        bot.sendMessage(chatId, "⚠️ Invalid format. Please send a valid Solana Wallet Address or link.");
    }
});

module.exports = { extractAddress };