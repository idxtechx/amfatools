const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// === CONFIGURATION ===
// IMPORTANT: Replace the placeholders below with your actual credentials!
const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";
const CHAT_ID = "YOUR_CHAT_ID_HERE";
const TOPIC_ID = 0; // Replace 0 with your Topic ID

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
let processedMints = new Set();

// ============================================================
// STORAGE: Track coins that have been alerted
// Format: { mint: { messageId, initialMc, initialVol, name, symbol, detectedAt, alerted2x, alerted3x, highestMc } }
// ============================================================
let trackedCoins = new Map();

// Storage for daily recap
let dailyRecap = new Map();

console.log("🚀 Trending Pre-Migration Bot Active (DexScreener API)...");
console.log("📊 Hunting for exploding Pump.fun tokens...");
console.log("🔔 Auto 2X & 3X Alerts + Daily Recap ENABLED");

// ============================================================
// MAIN FUNCTION: Scan for Trending Coins (Initial Detection)
// ============================================================
async function getTrendingPumpCoins() {
    try {
        const response = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1');
        const tokens = response.data;

        if (!Array.isArray(tokens)) return;

        for (let token of tokens.slice(0, 30)) {
            const mint = token.tokenAddress;
            const chainId = token.chainId;

            if (chainId === 'solana' && !processedMints.has(mint)) {
                const detailRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                const pairs = detailRes.data.pairs;
                if (!pairs) continue;

                // On INITIAL detection, ensure it is a Pump.fun pair
                const pumpPair = pairs.find(p => p.dexId === 'pumpfun');
                if (pumpPair) {
                    const mc  = pumpPair.fdv || 0;
                    const vol = pumpPair.volume?.h1 || 0;
                    const name   = pumpPair.baseToken?.name   || 'Unknown';
                    const symbol = pumpPair.baseToken?.symbol || '???';
                    const imageUrl = pumpPair.info?.imageUrl;

                    if (mc >= 15000 && mc <= 62000 && vol >= 50000) {
                        processedMints.add(mint);
                        const progress = (mc / 65000) * 100;

                        const message =
`🔥 <b>TRENDING PRE-MIGRATION</b>
━━━━━━━━━━━━━━━━━━
🌟 <b>${name}</b> (<code>${symbol}</code>)
📊 <b>Progress:</b> ${progress.toFixed(1)}%
${drawProgressBar(progress)}

💰 <b>Market Cap:</b> $${(mc / 1000).toFixed(1)}K
📈 <b>1h Volume:</b> $${(vol / 1000).toFixed(1)}K
📍 <b>Mint:</b> <code>${mint}</code>

🔗 <a href="https://photon-sol.tinyastro.io/en/lp/${mint}">Photon</a>  |  <a href="https://dexscreener.com/solana/${mint}">DexScreener</a>
━━━━━━━━━━━━━━━━━━`;

                        const opts = {
                            parse_mode: 'HTML',
                            message_thread_id: TOPIC_ID,
                            disable_web_page_preview: true
                        };

                        try {
                            let sentMessage;
                            if (imageUrl) {
                                sentMessage = await bot.sendPhoto(CHAT_ID, imageUrl, { caption: message, ...opts })
                                    .catch(err => bot.sendMessage(CHAT_ID, message, opts)); // Fallback text only
                            } else {
                                sentMessage = await bot.sendMessage(CHAT_ID, message, opts);
                            }

                            // ✅ Save to tracker with 2x & 3x status = false
                            if (sentMessage) {
                                trackedCoins.set(mint, {
                                    messageId:   sentMessage.message_id,
                                    initialMc:   mc,
                                    initialVol:  vol,
                                    name,
                                    symbol,
                                    detectedAt:  Date.now(),
                                    alerted2x:   false,
                                    alerted3x:   false,
                                    highestMc:   mc
                                });

                                dailyRecap.set(mint, {
                                    name,
                                    symbol,
                                    initialMc: mc,
                                    peakMc:    mc,
                                    multiplier: 1,
                                    detectedAt: Date.now()
                                });

                                console.log(`✅ Tracking: ${name} (${symbol}) | MC: $${(mc/1000).toFixed(1)}K`);
                            }
                        } catch (sendErr) {
                            console.log(`⚠️ Failed to send initial message: ${sendErr.message}`);
                        }
                    }
                }
            }
        }
    } catch (error) {
        // Silent error to prevent console flooding on API timeouts
    }
}

// ============================================================
// FUNCTION: Check Price Multipliers (2X and 3X)
// ============================================================
async function checkTrackedCoins() {
    if (trackedCoins.size === 0) return;

    console.log(`🔍 Checking price action for ${trackedCoins.size} coins...`);

    for (const [mint, data] of trackedCoins.entries()) {
        try {
            const detailRes = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
                { timeout: 5000 }
            );
            const pairs = detailRes.data.pairs;
            if (!pairs || pairs.length === 0) continue;

            // ✅ FIX: Get the pair with the highest FDV (Handles Raydium migration)
            const bestPair = pairs.reduce((prev, current) => ((prev.fdv || 0) > (current.fdv || 0)) ? prev : current);
            
            const currentMc = bestPair.fdv || 0;
            if (currentMc <= 0) continue;

            const multiplier = currentMc / data.initialMc;

            // Update highest MC for daily recap & tracker
            if (currentMc > data.highestMc) {
                trackedCoins.set(mint, { ...data, highestMc: currentMc });
                if (dailyRecap.has(mint)) {
                    const recap = dailyRecap.get(mint);
                    recap.peakMc = currentMc;
                    recap.multiplier = Math.max(recap.multiplier, multiplier);
                    dailyRecap.set(mint, recap);
                }
            }

            const currentVol = bestPair.volume?.h1 || 0;
            const currentProgress = (currentMc / 65000) * 100;
            const elapsed = Math.floor((Date.now() - data.detectedAt) / 60000); // in minutes

            // ✅ CHECK 3X ALERT
            if (multiplier >= 3 && !data.alerted3x) {
                await sendMultiplierAlert(mint, data, currentMc, currentVol, currentProgress, elapsed, multiplier, 3);
                // Update state: alerted 3x (also marks 2x as true to prevent double alerts)
                trackedCoins.set(mint, { ...trackedCoins.get(mint), alerted3x: true, alerted2x: true });
            } 
            // ✅ CHECK 2X ALERT (Only if 3X hasn't fired)
            else if (multiplier >= 2 && multiplier < 3 && !data.alerted2x) {
                await sendMultiplierAlert(mint, data, currentMc, currentVol, currentProgress, elapsed, multiplier, 2);
                // Update state: alerted 2x
                trackedCoins.set(mint, { ...trackedCoins.get(mint), alerted2x: true });
            }

            // Remove from tracker if older than 6 hours (Memory optimization)
            const ageHours = (Date.now() - data.detectedAt) / 3600000;
            if (ageHours > 6) {
                trackedCoins.delete(mint);
                console.log(`🗑️ ${data.name} removed from tracking (age > 6h)`);
            }

        } catch (err) {
            // Ignore temporary network errors
        }

        // Delay 500ms between coins to avoid DexScreener rate limits
        await delay(500);
    }
}

// HELPER FUNCTION: Format and Send Multiplier Alert
async function sendMultiplierAlert(mint, data, currentMc, currentVol, currentProgress, elapsed, multiplier, targetX) {
    const icon = targetX >= 3 ? "🚀🚀" : "📈";
    const replyMsg =
`${icon} <b>${targetX}X ALERT — ${data.name} (${data.symbol})</b>
━━━━━━━━━━━━━━━━━━
🎯 <b>Gain:</b> ${multiplier.toFixed(2)}X in ${elapsed} minutes!

💰 <b>Initial MC:</b> $${(data.initialMc / 1000).toFixed(1)}K
💰 <b>Current MC:</b> $${(currentMc / 1000).toFixed(1)}K
📈 <b>1h Volume:</b> $${(currentVol / 1000).toFixed(1)}K
📊 <b>Progress:</b> ${Math.min(currentProgress, 100).toFixed(1)}%
${drawProgressBar(currentProgress)}

🔗 <a href="https://photon-sol.tinyastro.io/en/lp/${mint}">Photon</a>  |  <a href="https://dexscreener.com/solana/${mint}">DexScreener</a>
━━━━━━━━━━━━━━━━━━`;

    try {
        await bot.sendMessage(CHAT_ID, replyMsg, {
            parse_mode: 'HTML',
            message_thread_id: TOPIC_ID,
            disable_web_page_preview: true,
            reply_to_message_id: data.messageId // Reply to the original notification
        });
        console.log(`${icon} ${targetX}X Alert sent: ${data.name} | ${multiplier.toFixed(2)}X`);
    } catch (replyErr) {
        console.log(`⚠️ Failed to send multiplier alert: ${replyErr.message}`);
    }
}

// ============================================================
// FUNCTION: Send Daily Recap every 24 hours
// ============================================================
async function sendDailyRecap() {
    console.log("📋 Preparing Daily Recap...");

    if (dailyRecap.size === 0) {
        console.log("📋 No data to recap today.");
        return;
    }

    const sorted = [...dailyRecap.entries()]
        .map(([mint, d]) => ({ mint, ...d }))
        .sort((a, b) => b.multiplier - a.multiplier);

    const top = sorted.slice(0, 10);
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    let recapMsg = `📊 <b>DAILY RECAP — ${dateStr}</b>\n━━━━━━━━━━━━━━━━━━\n🏆 <b>Top 10 Coins Today</b>\n\n`;

    top.forEach((coin, i) => {
        const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        const multiStr = coin.multiplier >= 3 ? `🚀 ${coin.multiplier.toFixed(2)}X` : (coin.multiplier >= 2 ? `📈 ${coin.multiplier.toFixed(2)}X` : `➡️ ${coin.multiplier.toFixed(2)}X`);
        recapMsg += `${medal} <b>${coin.name}</b> (<code>${coin.symbol}</code>)\n   ${multiStr} | MC: $${(coin.initialMc/1000).toFixed(1)}K → $${(coin.peakMc/1000).toFixed(1)}K\n   <a href="https://dexscreener.com/solana/${coin.mint}">DexScreener</a>\n\n`;
    });

    const hit3x = sorted.filter(c => c.multiplier >= 3).length;
    const hit2x = sorted.filter(c => c.multiplier >= 2 && c.multiplier < 3).length;

    recapMsg += `━━━━━━━━━━━━━━━━━━\n🚀 Surpassed 3X+: <b>${hit3x} coins</b>\n📈 Surpassed 2X+: <b>${hit2x} coins</b>\n📌 Total Detected: <b>${dailyRecap.size} coins</b>`;

    try {
        await bot.sendMessage(CHAT_ID, recapMsg, { parse_mode: 'HTML', message_thread_id: TOPIC_ID, disable_web_page_preview: true });
        console.log(`✅ Daily recap sent successfully!`);
    } catch (err) {
        console.log(`⚠️ Failed to send recap: ${err.message}`);
    }

    // Reset Data for the next day
    dailyRecap.clear();
    processedMints.clear();
    trackedCoins.clear();
}

// ============================================================
// HELPER & SCHEDULER
// ============================================================
function drawProgressBar(progress) {
    const filled = Math.round(Math.min(progress, 100) / 10);
    return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Scan for trending coins every 30 seconds
setInterval(getTrendingPumpCoins, 30000);

// Check price action of tracked coins every 2 minutes
setInterval(checkTrackedCoins, 2 * 60 * 1000);

// Daily recap scheduler (17:00 UTC = 00:00 WIB)
function scheduleDailyRecap() {
    const now = new Date();
    const target = new Date();
    target.setUTCHours(17, 0, 0, 0);
    if (now >= target) target.setDate(target.getDate() + 1);

    const msUntilRecap = target - now;
    setTimeout(() => {
        sendDailyRecap();
        setInterval(sendDailyRecap, 24 * 60 * 60 * 1000);
    }, msUntilRecap);
}

// Execute on start
getTrendingPumpCoins();
checkTrackedCoins();
scheduleDailyRecap();

module.exports = { getTrendingPumpCoins };