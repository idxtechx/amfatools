const { Connection, PublicKey } = require('@solana/web3.js');
const { Metaplex } = require('@metaplex-foundation/js');
const { getMint } = require('@solana/spl-token');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// --- CONFIGURATION ---
// IMPORTANT: Replace the placeholders below with your actual credentials!
const HELIUS_API_KEY = "YOUR_HELIUS_API_KEY_HERE";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const WSS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";

// --- MULTI CHANNEL CONFIGURATION ---
// Add your target Chat IDs and Topic IDs here
const CHANNELS = [
    { chatId: "YOUR_PRIMARY_CHAT_ID_HERE", topicId: 0 }, // Replace 0 with Topic ID if applicable
    { chatId: "YOUR_SECONDARY_CHAT_ID_HERE", topicId: null }
];

const RAYDIUM_V4   = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CPMM = new PublicKey("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");

const MIN_LIQUIDITY_SOL = 1.5;
const MAX_LIQUIDITY_SOL = 40;

const solanaConnection = new Connection(RPC_URL, { wsEndpoint: WSS_URL, commitment: "confirmed" });
const metaplex = Metaplex.make(solanaConnection);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ============================================================
// STORAGE & TRACKING
// ============================================================
let trackedCoins = new Map();
let dailyRecap   = new Map();

console.log("🚀 Monitoring Bot Active (V4 & CPMM) - Multi Channel...");
console.log(`💧 LP Filter: ${MIN_LIQUIDITY_SOL} - ${MAX_LIQUIDITY_SOL} SOL`);
console.log("🛡️ Filter: Mint & Freeze REVOKED");
console.log("🔔 Strict Real-Time LP Burn/Lock/Rug Monitor & Multiplier Alert ACTIVE");

// ============================================================
// HELPERS
// ============================================================
async function fetchWithRetry(url, retries = 3, timeout = 10000) {
    for (let i = 0; i < retries; i++) {
        try {
            const { data } = await axios.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0' } });
            return data;
        } catch (e) {
            if (i === retries - 1) throw e;
            await delay(1000 * (i + 1));
        }
    }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function formatElapsed(ms) {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes} mins`;
}

function formatMc(value) {
    if (!value || value === 0) return "N/A";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000)     return `${(value / 1_000).toFixed(1)}K`;
    return value.toFixed(0);
}

// Fetch DexScreener Data
async function getDexScreenerData(mintAddress) {
    try {
        const data = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, 2, 5000);
        if (data.pairs?.length > 0) {
            return data.pairs.find(p => p.dexId === 'raydium' || p.dexId === 'raydium-cpmm') || data.pairs[0];
        }
    } catch (_) {}
    return null;
}

// ============================================================
// SENDER HELPER (Multi Channel)
// ============================================================
async function sendToAllChannels(image, msg, replyIds = null) {
    const messageIds = {};
    for (const channel of CHANNELS) {
        // Skip if credentials are not configured
        if (channel.chatId.includes("YOUR_")) continue;

        const options = {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...(channel.topicId && { message_thread_id: channel.topicId })
        };
        
        if (replyIds && replyIds[channel.chatId]) {
            options.reply_to_message_id = replyIds[channel.chatId];
        }

        try {
            let sent;
            if (image && !replyIds) {
                sent = await bot.sendPhoto(channel.chatId, image, { caption: msg, ...options });
            } else {
                sent = await bot.sendMessage(channel.chatId, msg, options);
            }
            messageIds[channel.chatId] = sent.message_id;
        } catch (e) {
            if (image && !replyIds) {
                try {
                    const sent = await bot.sendMessage(channel.chatId, msg, options);
                    messageIds[channel.chatId] = sent.message_id;
                } catch (_) {}
            }
        }
    }
    return messageIds;
}

// ============================================================
// MAIN LOOP: Price Action & STRICT LP Checker
// ============================================================
async function checkTrackedCoins() {
    if (trackedCoins.size === 0) return;

    for (const [mint, data] of trackedCoins.entries()) {
        try {
            const pairData = await getDexScreenerData(mint);
            const currentMc = pairData ? (pairData.fdv || pairData.marketCap || 0) : 0;
            const liqUsd = pairData ? (pairData.liquidity?.usd || 0) : 0;

            // --- 1. STRICT ON-CHAIN LP BURN, LOCK & RUG CHECKER ---
            if (!data.lpActionNotified && data.lpMint) {
                const lpMintPubkey = new PublicKey(data.lpMint);
                const currentSupplyRes = await solanaConnection.getTokenSupply(lpMintPubkey);
                const currentLpSupply = currentSupplyRes.value.uiAmount || 0;

                if (currentLpSupply > data.maxLpSupply) {
                    data.maxLpSupply = currentLpSupply;
                }

                if (data.maxLpSupply > 0) {
                    const largestAccs = await solanaConnection.getTokenLargestAccounts(lpMintPubkey);
                    let incineratorAmount = 0;
                    let lockedAmount = 0;

                    const LOCK_PROGRAMS = [
                        "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", // Streamflow
                        "LockJvWeQvWZ9k2qfRpxS4q1iKxgJk4sQjV3YJ5z5Z5",  // PinkSale
                        "7y1EGHvPvooXG2y2v4M4H9qRj8D8P7YhFkXZXqz4i35s",
                        "E11FsDfN1qQowrEiE1x7Y3A1qZ1p4bK1Kj9K5c4G1B1"
                    ];

                    for (const acc of largestAccs.value.slice(0, 3)) {
                        if (acc.uiAmount === 0) continue;
                        try {
                            const accInfo = await solanaConnection.getParsedAccountInfo(acc.address);
                            const owner = accInfo.value?.data?.parsed?.info?.owner;

                            if (owner === "1nc1nerator11111111111111111111111111111111") {
                                incineratorAmount += acc.uiAmount;
                            } else if (LOCK_PROGRAMS.includes(owner)) {
                                lockedAmount += acc.uiAmount;
                            }
                        } catch (e) {}
                    }

                    const incinBurnedPct = (incineratorAmount / data.maxLpSupply) * 100;
                    const splBurnedPct = Math.max(0, ((data.maxLpSupply - currentLpSupply) / data.maxLpSupply) * 100);
                    const totalLockedPct = (lockedAmount / data.maxLpSupply) * 100;

                    let isTrueBurn = false;
                    let isLocked = (totalLockedPct >= 90);

                    // ANTI-RUG PULL LOGIC (Detecting LP Removal)
                    if (incinBurnedPct >= 95) {
                        isTrueBurn = true; // Sent to dead wallet = 100% valid
                    } else if (splBurnedPct >= 95) {
                        try {
                            const tokenAccs = await solanaConnection.getTokenLargestAccounts(new PublicKey(mint));
                            const topAccAddress = tokenAccs.value[0]?.address;
                            
                            if (topAccAddress) {
                                const topAccInfo = await solanaConnection.getParsedAccountInfo(new PublicKey(topAccAddress));
                                const topOwner = topAccInfo.value?.data?.parsed?.info?.owner;
                                
                                const RAYDIUM_AUTHORITIES = [
                                    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium V4 Authority
                                    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"  // Raydium CPMM Authority
                                ];
                                
                                if (RAYDIUM_AUTHORITIES.includes(topOwner)) {
                                    isTrueBurn = true; // Token secured in Raydium vault
                                } else if (topOwner === data.devWallet) {
                                    // 🚨 RUG PULL: Dev retrieved the liquidity tokens
                                    console.log(`🚨 [RUG DETECTED] ${data.symbol}: Dev removed liquidity! Sending alert.`);
                                    
                                    const rugMsg = 
`🚨 <b>RUG PULL DETECTED! (LP REMOVED)</b> 🚨
<i>Developer just removed the liquidity! DO NOT BUY!</i>
━━━━━━━━━━━━━━━━━━
🌟 <b>${data.name} (${data.symbol})</b>

💳 <b>CA:</b> <code>${mint}</code>
👤 <b>Dev Wallet:</b> <a href="https://solscan.io/account/${data.devWallet}">${data.devWallet.substring(0, 4)}...${data.devWallet.substring(data.devWallet.length - 4)}</a>

🔗 <a href="https://dexscreener.com/solana/${mint}">📊 DexScreener</a>
━━━━━━━━━━━━━━━━━━`;
                                    await sendToAllChannels(null, rugMsg, data.messageIds);
                                    trackedCoins.delete(mint);
                                    continue;

                                } else {
                                    // Fallback Rug Pull if Liquidity drained significantly (< $1000)
                                    if (liqUsd > 1000) {
                                        isTrueBurn = true; 
                                    } else {
                                        console.log(`🚨 [RUG DETECTED - LOW LIQ] ${data.symbol}: Liquidity drained!`);
                                        const rugMsg = 
`🚨 <b>LIQUIDITY DRAINED / POSSIBLE RUG!</b> 🚨
<i>Liquidity dropped to abnormal levels. DO NOT BUY!</i>
━━━━━━━━━━━━━━━━━━
🌟 <b>${data.name} (${data.symbol})</b>

💳 <b>CA:</b> <code>${mint}</code>

🔗 <a href="https://dexscreener.com/solana/${mint}">📊 DexScreener</a>
━━━━━━━━━━━━━━━━━━`;
                                        await sendToAllChannels(null, rugMsg, data.messageIds);
                                        trackedCoins.delete(mint);
                                        continue;
                                    }
                                }
                            }
                        } catch(e) {
                            if (liqUsd > 1000) isTrueBurn = true;
                        }
                    }

                    let lpActionMsg = null;
                    if (isTrueBurn) {
                        lpActionMsg = "🔥 <b>LP 100% BURNED!</b> 🔥\n<i>Liquidity has been permanently burned.</i>";
                    } 
                    else if (isLocked) {
                        lpActionMsg = "🔒 <b>LP LOCKED!</b> 🔒\n<i>Liquidity is secured in a smart contract locker.</i>";
                    }

                    if (lpActionMsg) {
                        const mcDisplay = currentMc > 0 ? `$${formatMc(currentMc)}` : '<i>Fetching DexScreener...</i>';
                        const liqDisplay = liqUsd > 0 ? `$${liqUsd.toLocaleString()}` : '<i>Fetching DexScreener...</i>';

                        const lpAlertText =
`${lpActionMsg}
━━━━━━━━━━━━━━━━━━
🌟 <b>${data.name} (${data.symbol})</b>

💰 <b>Liquidity:</b> ${liqDisplay}
📈 <b>Market Cap:</b> ${mcDisplay}

🔗 <a href="https://dexscreener.com/solana/${mint}">📊 DexScreener</a> | <a href="https://rugcheck.xyz/tokens/${mint}">🛡️ RugCheck</a>
━━━━━━━━━━━━━━━━━━`;
                        await sendToAllChannels(null, lpAlertText, data.messageIds);
                        data.lpActionNotified = true;
                        console.log(`[LP ALERT VALID] ${data.name}: LP Validated (Burn/Lock)`);
                    }
                }
            }

            // If coin was not deleted due to Rug, update state in memory
            if (trackedCoins.has(mint)) {
                trackedCoins.set(mint, data);
            }

            // --- 2. MULTIPLIER ALERT (PRICE ACTION) ---
            if (!pairData || currentMc <= 0 || data.initialMc <= 0) continue;

            const multiplier = currentMc / data.initialMc;

            if (dailyRecap.has(mint)) {
                const recap = dailyRecap.get(mint);
                if (currentMc > recap.peakMc) {
                    recap.peakMc = currentMc;
                    recap.multiplier = multiplier;
                    dailyRecap.set(mint, recap);
                }
            }

            if (currentMc > data.highestMc) {
                data.highestMc = currentMc;
                trackedCoins.set(mint, data);
            }

            const milestones = [
                { key: 'peaked10x', threshold: 10, emoji: '💎', label: '10X' },
                { key: 'peaked5x',  threshold: 5,  emoji: '🌕', label: '5X'  },
                { key: 'peaked3x',  threshold: 3,  emoji: '🚀', label: '3X'  },
                { key: 'peaked2x',  threshold: 2,  emoji: '📈', label: '2X'  },
            ];

            for (const ms of milestones) {
                if (multiplier >= ms.threshold && !data[ms.key]) {
                    const alertMsg =
`${ms.emoji} <b>${ms.label} ALERT — ${data.name} (${data.symbol})</b>
━━━━━━━━━━━━━━━━━━
🎯 <b>Gain:</b> ${multiplier.toFixed(2)}X in ${formatElapsed(Date.now() - data.detectedAt)}

💰 <b>Initial MC:</b> $${formatMc(data.initialMc)}
💰 <b>Current MC:</b> $${formatMc(currentMc)}

🔗 <a href="https://dexscreener.com/solana/${mint}">📊 DexScreener</a> | <a href="https://rugcheck.xyz/tokens/${mint}">🛡️ RugCheck</a>
━━━━━━━━━━━━━━━━━━`;
                    await sendToAllChannels(null, alertMsg, data.messageIds);
                    data[ms.key] = true;
                    trackedCoins.set(mint, data);
                    break;
                }
            }

            // Remove from cache after 12 hours
            if ((Date.now() - data.detectedAt) / 3600000 > 12) trackedCoins.delete(mint);

        } catch (_) {}

        await delay(600); 
    }
}

// ============================================================
// TOKEN METADATA & REVOKE CHECKER
// ============================================================
async function getTokenMetadata(mintAddress) {
    try {
        const mintPubkey = new PublicKey(mintAddress);
        const mintInfo   = await getMint(solanaConnection, mintPubkey);

        if (mintInfo.mintAuthority !== null || mintInfo.freezeAuthority !== null) {
            console.log(`🚫 Skipped — Authorities not fully revoked.`);
            return null;
        }

        const supply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
        let name = "Unknown", symbol = "TOKEN", image = null;

        try {
            const nft = await metaplex.nfts().findByMint({ mintAddress: mintPubkey });
            name = nft.name?.replace(/[*_`]/g, '') || "Unknown";
            symbol = nft.symbol?.replace(/[*_`]/g, '') || "TOKEN";

            if (nft.uri) {
                const metadata = await fetchWithRetry(nft.uri, 2, 5000).catch(() => ({}));
                image = metadata.image || metadata.imageUrl || null;
                if (image?.startsWith('ipfs://')) image = image.replace('ipfs://', 'https://ipfs.io/ipfs/');
            }
        } catch (_) {}

        if (!image) {
            try {
                const d = await fetchWithRetry(`https://token.jup.ag/strict/${mintAddress}`, 1, 3000);
                if (d.logoURI) { image = d.logoURI; name = d.name || name; symbol = d.symbol || symbol; }
            } catch (_) {}
        }

        return { name, symbol, image, supply, decimals: mintInfo.decimals, status: "✅ Revoked" };
    } catch (e) {
        return null;
    }
}

// ============================================================
// NEW POOL TRANSACTION PROCESSOR
// ============================================================
async function processTransaction(signature, version, retryCount = 0) {
    try {
        await delay(3500);

        const tx = await solanaConnection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
        });

        if (!tx || !tx.meta) return retryCount < 3 ? processTransaction(signature, version, retryCount + 1) : null;

        let owner = "Unknown";
        try { owner = tx.transaction.message.accountKeys[0]?.pubkey?.toString() || "Unknown"; } catch (_) {}

        const preBal  = tx.meta.preBalances[0] || 0;
        const postBal = tx.meta.postBalances[0] || 0;
        const solAmount = Math.abs(preBal - postBal) / 1_000_000_000;

        if (solAmount < MIN_LIQUIDITY_SOL || solAmount > MAX_LIQUIDITY_SOL) return;

        const nonSolBalances = tx.meta.postTokenBalances?.filter(b => b.mint !== "So11111111111111111111111111111111111111112") || [];
        if (nonSolBalances.length === 0) return;

        nonSolBalances.sort((a, b) => (b.uiTokenAmount.uiAmount || 0) - (a.uiTokenAmount.uiAmount || 0));
        
        const tokenMint = nonSolBalances[0].mint;
        const lpMintData = nonSolBalances.find(b => b.mint !== tokenMint);
        const lpMint = lpMintData ? lpMintData.mint : null;

        console.log(`\n🔍 Found Token: ${tokenMint} | LP: ${solAmount.toFixed(2)} SOL`);

        const meta = await getTokenMetadata(tokenMint);
        if (!meta) return;

        let initialLpSupply = 0;
        if (lpMintData && lpMintData.uiTokenAmount) {
            initialLpSupply = lpMintData.uiTokenAmount.uiAmount || 0;
        }
        
        if (initialLpSupply === 0 && lpMint) {
            try {
                const supplyRes = await solanaConnection.getTokenSupply(new PublicKey(lpMint));
                initialLpSupply = supplyRes.value.uiAmount || 0;
            } catch (_) {}
        }

        const pairData = await getDexScreenerData(tokenMint);
        const initialMc = pairData ? (pairData.fdv || pairData.marketCap || 0) : 0;
        
        const devShort = owner !== "Unknown" ? `${owner.substring(0, 4)}...${owner.substring(owner.length - 4)}` : "Unknown";

        const msg =
`🌟 <b>${meta.name} (${meta.symbol})</b>

<b>💰 Initial LP:</b> ${solAmount.toFixed(2)} SOL
${initialMc > 0 ? `<b>📈 Market Cap:</b> $${formatMc(initialMc)}\n` : ''}
<b>💳 CA:</b> <code>${tokenMint}</code>
<b>👤 Dev:</b> <a href="https://solscan.io/account/${owner}">${devShort}</a>

<b>📋 Token Info:</b>
- <b>Total Supply:</b> ${meta.supply.toLocaleString()}
- <b>DEX Platform:</b> ${version}
- <b>Authorities:</b> ${meta.status}

<b>🔗 Quick Links:</b>
<a href="https://rugcheck.xyz/tokens/${tokenMint}">🛡️ RugCheck</a> | <a href="https://dexscreener.com/solana/${tokenMint}">📊 DexScreener</a> | <a href="https://solscan.io/tx/${signature}">⛓️ TX</a>`;

        const messageIds = await sendToAllChannels(meta.image, msg);

        trackedCoins.set(tokenMint, {
            messageIds, initialMc, highestMc: initialMc,
            name: meta.name, symbol: meta.symbol, detectedAt: Date.now(),
            peaked2x: false, peaked3x: false, peaked5x: false, peaked10x: false,
            lpMint, maxLpSupply: initialLpSupply, lpActionNotified: false,
            devWallet: owner
        });

        dailyRecap.set(tokenMint, {
            name: meta.name, symbol: meta.symbol,
            initialMc, peakMc: initialMc, multiplier: 1, detectedAt: Date.now()
        });
        
        console.log(`📌 Tracking Active: ${meta.name} | Monitoring LP Burn & Price Action...`);
        
    } catch (e) {
        console.error(`❌ processTransaction error:`, e.message);
    }
}

// ============================================================
// DAILY RECAP & STARTUP LISTENER
// ============================================================
async function sendDailyRecap() {
    if (dailyRecap.size === 0) return dailyRecap.clear();
    const sorted = [...dailyRecap.entries()].map(([mint, d]) => ({ mint, ...d })).sort((a, b) => b.multiplier - a.multiplier);
    const top = sorted.slice(0, 10);
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    let recapMsg = `📊 <b>DAILY RECAP — ${dateStr}</b>\n━━━━━━━━━━━━━━━━━━\n🏆 <b>Top Gainers Today</b>\n\n`;
    top.forEach((coin, i) => {
        const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
        const multiEmoji = coin.multiplier >= 10 ? '💎' : coin.multiplier >= 5 ? '🌕' : coin.multiplier >= 3 ? '🚀' : coin.multiplier >= 2 ? '📈' : '➡️';
        recapMsg += `${medal} <b>${coin.name}</b> (<code>${coin.symbol}</code>)\n   ${multiEmoji} <b>${coin.multiplier.toFixed(2)}X</b> | MC: $${formatMc(coin.initialMc)} → $${formatMc(coin.peakMc)}\n   <a href="https://dexscreener.com/solana/${coin.mint}">DexScreener</a>\n\n`;
    });

    recapMsg += `━━━━━━━━━━━━━━━━━━\n💎 10X+: <b>${sorted.filter(c => c.multiplier >= 10).length} tokens</b>\n🚀 3X+: <b>${sorted.filter(c => c.multiplier >= 3).length} tokens</b>\n📌 Total Detected: <b>${dailyRecap.size} tokens</b>`;
    await sendToAllChannels(null, recapMsg);
    dailyRecap.clear(); trackedCoins.clear();
}

function scheduleDailyRecap() {
    const target = new Date();
    target.setUTCHours(17, 0, 0, 0);
    if (new Date() >= target) target.setDate(target.getDate() + 1);
    setTimeout(() => { sendDailyRecap(); setInterval(sendDailyRecap, 24 * 60 * 60 * 1000); }, target - new Date());
}

async function start() {
    setInterval(checkTrackedCoins, 60 * 1000); 
    scheduleDailyRecap();

    solanaConnection.onLogs(RAYDIUM_V4, async ({ logs, err, signature }) => {
        if (!err && logs?.some(log => log.includes("initialize2"))) processTransaction(signature, "Raydium V4");
    }, "confirmed");

    solanaConnection.onLogs(RAYDIUM_CPMM, async ({ logs, err, signature }) => {
        if (!err && logs?.some(log => log.includes("Initialize") || log.includes("create_pool"))) processTransaction(signature, "Raydium CPMM");
    }, "confirmed");
}

start();

module.exports = { processTransaction, getTokenMetadata };