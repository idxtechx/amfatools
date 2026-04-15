const { Connection, PublicKey } = require('@solana/web3.js');
const { Metaplex } = require('@metaplex-foundation/js');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// --- CONFIGURATION ---
// IMPORTANT: Replace the values below with your own API Keys and Tokens!
const RPC_URL = "YOUR_RPC_URL_HERE";
const WSS_URL = "YOUR_WSS_URL_HERE";
const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE";
const CHAT_ID = "YOUR_CHAT_ID_HERE";
const TOPIC_ID = 0; // Replace 0 with your actual Telegram Topic ID

const STREAMFLOW_PROGRAM_ID = new PublicKey("strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m");


const ONE_YEAR_IN_SECONDS = 365 * 24 * 60 * 60; 

const solanaConnection = new Connection(RPC_URL, {
    wsEndpoint: WSS_URL,
    commitment: "confirmed"
});
const metaplex = Metaplex.make(solanaConnection);

const processedSignatures = new Set();

const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: { interval: 2000, autoStart: true, params: { timeout: 10 } }
});

bot.on('polling_error', (error) => {
    if (error.code !== 'EFATAL' && error.code !== 'ENOTFOUND') {
        console.log('⚠️ Polling error:', error.code);
    }
});

console.log("⚡ Streamflow Monitor Active (First-Unlock Mode)...");

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        "✅ <b>Streamflow Monitor Bot Active!</b>\n\n" +
        "🔒 Displaying tokens where the <b>FIRST unlock</b> is locked for at least 1 year.",
        { parse_mode: 'HTML' }
    ).catch(err => console.log('Error send /start:', err.message));
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatDuration(seconds) {
    const years  = Math.floor(seconds / (365 * 24 * 3600));
    const months = Math.floor((seconds % (365 * 24 * 3600)) / (30 * 24 * 3600));

    if (years > 0 && months > 0) return `${years} Year(s) ${months} Month(s)`;
    if (years > 0)               return `${years} Year(s)`;
    if (months > 0)              return `${months} Month(s)`;
    return `< 1 Month`; 
}


let streamClient = null;

async function initStreamClient() {
    if (streamClient) return true; 
    try {
        const sf = await import("@streamflow/stream");
        if (sf.SolanaStreamClient) {
            streamClient = new sf.SolanaStreamClient(RPC_URL);
        } else if (sf.createClient) {
            streamClient = sf.createClient({ chain: 'solana', clusterUrl: RPC_URL });
        } else {
            console.log("⚠️ Failed to find valid Client inside SDK.");
            return false;
        }
        return true;
    } catch (err) {
        console.error("❌ Failed to load Streamflow SDK:", err.message);
        return false;
    }
}


async function getStreamLockInfo(tx) {
    const isSdkReady = await initStreamClient();
    if (!isSdkReady || !streamClient) return null;

    const accounts = tx.transaction.message.accountKeys;
    const ignoreList = [
        "11111111111111111111111111111111", 
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", 
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", 
        "ComputeBudget111111111111111111111111111111", 
        STREAMFLOW_PROGRAM_ID.toString() 
    ];

    const possibleAccounts = accounts.filter(acc => {
        const pubkey = acc.pubkey ? acc.pubkey.toString() : acc.toString();
        return !ignoreList.includes(pubkey) && acc.writable;
    });

    const parseToSeconds = (val) => {
        if (val === undefined || val === null) return 0;
        let num = 0;
        if (typeof val === 'object' && val !== null) {
            if (typeof val.toNumber === 'function') num = val.toNumber();
            else if (typeof val.toString === 'function') num = Number(val.toString());
        } else {
            num = Number(val);
        }
        if (isNaN(num)) return 0;
        if (num > 100000000000) return Math.floor(num / 1000);
        return num;
    };

    for (const account of possibleAccounts) {
        const pubkeyStr = account.pubkey ? account.pubkey.toString() : account.toString();

        try {
            const streamData = await streamClient.getOne({ id: pubkeyStr });
            
            if (streamData) {
                const startTime = parseToSeconds(streamData.start || streamData.startTime);
                const endTime = parseToSeconds(streamData.end || streamData.endTime);
                const cliffTime = parseToSeconds(streamData.cliff || streamData.cliffTime);
                const period = parseToSeconds(streamData.period);
                
                // Ambil mint address langsung dari dalam data stream
                const mintRaw = streamData.mint || streamData.tokenMint;
                const mintAddress = mintRaw ? mintRaw.toString() : null;
                
                if (endTime === 0 || !mintAddress) continue; 

                let firstUnlockTime = 0;
                let lockType = "Linear Vesting 📉"; 

                if (cliffTime > 0) {
                    firstUnlockTime = cliffTime;
                    lockType = (cliffTime === endTime) ? "Hard Lock 🔒" : "Vesting with Cliff 📉";
                } else {
                    firstUnlockTime = (period > 0) ? (startTime + period) : endTime;
                    if (firstUnlockTime === endTime) lockType = "Hard Lock 🔒";
                }

                if (startTime > 0 && firstUnlockTime > startTime) {
                    const durationToFirstUnlock = firstUnlockTime - startTime;
                    return { 
                        duration: durationToFirstUnlock, 
                        startTime, 
                        firstUnlockTime: firstUnlockTime, 
                        lockType,
                        mintAddress // Return mint address ke fungsi pemanggil
                    };
                }
            }
        } catch (err) {
            // Abaikan akun yang bukan merupakan akun stream Streamflow
        }
    }
    return null;
}

// ============================================================
// METADATA HELPERS
// ============================================================
async function getTokenMetaFromDexScreener(mintAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 3000 });
        if (response.data?.pairs?.length > 0) {
            const pair  = response.data.pairs[0];
            const token = pair.baseToken.address === mintAddress ? pair.baseToken : pair.quoteToken;
            return { name: token.name || null, symbol: token.symbol || null, image: pair.info?.imageUrl || null };
        }
    } catch (e) {}
    return null;
}

async function getTokenMetaFromJupiter(mintAddress) {
    try {
        const response = await axios.get(`https://tokens.jup.ag/token/${mintAddress}`, { timeout: 3000 });
        if (response.data) return { name: response.data.name || null, symbol: response.data.symbol || null, image: response.data.logoURI || null };
    } catch (e) {}
    return null;
}

async function getTokenMeta(mintAddress) {
    let meta = await getTokenMetaFromJupiter(mintAddress);
    if (meta?.name) return meta;
    meta = await getTokenMetaFromDexScreener(mintAddress);
    if (meta?.name) return meta;
    return { name: "Unknown Token", symbol: "TOKEN", image: null };
}

// ============================================================
// TRANSACTION PROCESSOR
// ============================================================
async function processTransaction(signature) {
    try {
        console.log(`⏳ [${signature.substring(0,6)}] Waiting 8 seconds for RPC sync...`);
        await delay(8000); // Diperpanjang agar data pasti masuk ke node RPC

        const tx = await solanaConnection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
        });

        if (!tx || !tx.meta) {
            console.log(`❌ [${signature.substring(0,6)}] Transaction data not found in RPC yet.`);
            return;
        }

        console.log(`⏱️ [${signature.substring(0,6)}] Reading stream SDK data...`);
        const lockInfo = await getStreamLockInfo(tx);

        if (!lockInfo) {
            console.log(`⚠️ [${signature.substring(0,6)}] No valid stream data found.`);
            return;
        }

        const mintAddress = lockInfo.mintAddress;
        console.log(`💎 [${signature.substring(0,6)}] Token Mint: ${mintAddress}`);

        if (lockInfo.duration < ONE_YEAR_IN_SECONDS) {
            console.log(`⏭️ [${signature.substring(0,6)}] Skipped. First Unlock is only ${formatDuration(lockInfo.duration)} (< 1 year).`);
            return;
        }

        console.log(`✅ [${signature.substring(0,6)}] PASSED FILTER! Generating Telegram message...`);

        const meta = await getTokenMeta(mintAddress);
        const streamflowLink = `https://app.streamflow.finance/token-dashboard/solana/mainnet/${mintAddress}`;
        
        const unlockDate = new Date(lockInfo.firstUnlockTime * 1000).toLocaleString('en-US', {
            month: 'long', 
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
        });

        let msg = `🔒 <b>New Token Locked!</b>\n\n` +
                  `<b>🌟 Name:</b> ${meta.name} (${meta.symbol})\n` +
                  `<b>💳 Address:</b> <code>${mintAddress}</code>\n` +
                  `<b>⚙️ Lock Type:</b> ${lockInfo.lockType}\n` +
                  `<b>⏳ Time to First Unlock:</b> ${formatDuration(lockInfo.duration)}\n` +
                  `<b>📅 First Unlock Date:</b> <b>${unlockDate}</b>\n\n` +
                  `<b><i>Click more details on Streamflow 👇</i></b>\n\n` +
                  `<b>🔗 Links:</b>\n` +
                  `• <a href="${streamflowLink}">🌐 Streamflow Dashboard</a>\n` +
                  `• <a href="https://dexscreener.com/solana/${mintAddress}">📊 DexScreener</a>`;

        const opts = { parse_mode: 'HTML', message_thread_id: TOPIC_ID, disable_web_page_preview: true };

        if (meta.image) {
            await bot.sendPhoto(CHAT_ID, meta.image, { caption: msg, ...opts })
                .catch(() => bot.sendMessage(CHAT_ID, msg, opts));
        } else {
            await bot.sendMessage(CHAT_ID, msg, opts);
        }

        console.log(`✅ [${signature.substring(0,6)}] Successfully sent to Telegram!\n`);

    } catch (e) {
        console.error(`❌ [${signature.substring(0,6)}] Error processing:`, e.message);
    }
}


async function start() {
    await initStreamClient();

    solanaConnection.onLogs(STREAMFLOW_PROGRAM_ID, async ({ logs, err, signature }) => {
        if (!err && logs && logs.some(log => log.includes("Create"))) {
            if (processedSignatures.has(signature)) return;
            processedSignatures.add(signature);
            setTimeout(() => processedSignatures.delete(signature), 5 * 60 * 1000);
            
            console.log(`\n🚀 New Transaction: ${signature}`);
            processTransaction(signature);
        }
    }, "confirmed");
}

start();

module.exports = { getStreamLockInfo };