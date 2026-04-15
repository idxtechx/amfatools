// SolTools SDK - Entry Point
const raydium = require('./bot-raydium');
const pumpfun = require('./bot-pumpfun');
const streamflow = require('./bot-streamflow');
const devScanner = require('./bot-dev-scanner');

module.exports = {
    // Mengekspor semua logika agar bisa dipakai developer lain
    ...raydium,
    ...pumpfun,
    ...streamflow,
    ...devScanner
};