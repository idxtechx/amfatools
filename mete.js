const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// === CONFIGURATION ===
// IMPORTANT: Replace the placeholders below with your actual credentials!
const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";
const CHAT_ID = "YOUR_CHAT_ID_HERE";
const TOPIC_ID = 339; // Make sure this matches your Telegram Topic ID

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
let processedMints = new Set(); 

console.log("🚀 Pre-Migration Trending Bot Active (DexScreener API)...");
console.log("📊 Hunting for exploding Pump.fun tokens...");

async function getTrendingPumpCoins() {
    try {
        // DexScreener Latest Boosted/Trending Pairs
        const response = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
        const tokens = response.data;

        if (!Array.isArray(tokens)) return;

        // Take the top 30 active tokens
        for (let token of tokens.slice(0, 30)) {
            const mint = token.tokenAddress;
            const chainId = token.chainId;

            if (chainId === 'solana' && !processedMints.has(mint)) {
                
                // Fetch market cap and liquidity details
                const detailRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                const pairs = detailRes.data.pairs;

                if (!pairs) continue;

                // Ensure the pair is actively trading on pump.fun
                const pumpPair = pairs.find(p => p.dexId === 'pumpfun');

                if (pumpPair) {
                    const mc = pumpPair.fdv || 0; // Market Cap
                    const vol = pumpPair.volume?.h1 || 0; // 1-hour Volume
                    const name = pumpPair.baseToken?.name || 'Unknown'; // Token Name
                    const symbol = pumpPair.baseToken?.symbol || 'TOKEN'; // Token Symbol
                    const imageUrl = pumpPair.info?.imageUrl; // Token Image

                    // PRE-MIGRATION TRENDING CRITERIA:
                    // 1. Market Cap between $15K - $62K (Rising but not graduated)
                    // 2. 1-hour Volume at least $10K (High activity)
                    if (mc >= 15000 && mc <= 62000 && vol >= 10000) {
                        
                        processedMints.add(mint);
                        const progress = (mc / 65000) * 100;

                        const message = `🔥 <b>TRENDING PRE-MIGRATION</b>
━━━━━━━━━━━━━━━━━━
🌟 <b>${name}</b> (<code>${symbol}</code>)
📊 <b>Progress:</b> ${progress.toFixed(1)}%
${drawProgressBar(progress)}

💰 <b>Market Cap:</b> $${(mc / 1000).toFixed(1)}K
📈 <b>1h Volume:</b> $${(vol / 1000).toFixed(1)}K
📍 <b>Mint:</b> <code>${mint}</code>

🔗 <a href="https://photon-sol.tinyastro.io/en/lp/${mint}">Photon</a>
🔗 <a href="https://dexscreener.com/solana/${mint}">DexScreener</a>
━━━━━━━━━━━━━━━━━━`;

                        const opts = { 
                            parse_mode: 'HTML',
                            message_thread_id: TOPIC_ID,
                            disable_web_page_preview: true
                        };

                        // Send with image if available, fallback to text-only if image fails
                        if (imageUrl) {
                            bot.sendPhoto(CHAT_ID, imageUrl, { caption: message, ...opts })
                               .catch(err => bot.sendMessage(CHAT_ID, message, opts));
                        } else {
                            bot.sendMessage(CHAT_ID, message, opts);
                        }

                        console.log(`✅ Trending: ${name} | MC: $${mc} | Vol: $${vol}`);
                        
                        // 500ms delay to prevent Telegram Rate Limits (Error 429)
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }
        }
    } catch (error) {
        // Keep console clean instead of spamming timeout errors
        // console.log("⚠️ Waiting for API data update...");
    }
}

// Helper to draw visual progress bar
function drawProgressBar(progress) {
    const filled = Math.round(Math.min(progress, 100) / 10);
    return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

// Check every 30 seconds
setInterval(getTrendingPumpCoins, 30000);

// Reset memory cache every 1 hour to prevent memory leaks and allow re-alerts if needed
setInterval(() => processedMints.clear(), 3600000);

// Run immediately on startup
getTrendingPumpCoins();