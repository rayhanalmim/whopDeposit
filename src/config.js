require('dotenv').config();

// Working BSC WebSocket endpoints (as of 2025)
const BSC_ENDPOINTS = [
    "wss://bsc-ws-node.nariox.org:443",
    "wss://bsc.publicnode.com",
    "wss://bsc-mainnet.4everland.org/ws/v1",
    "wss://bsc-rpc.publicnode.com",
];

module.exports = {
    BSC_WS: process.env.BSC_WS || BSC_ENDPOINTS[0],
    BSC_ENDPOINTS,
    TREASURY_ADDRESS: process.env.TREASURY_ADDRESS,
    SWEEP_GAS_LIMIT: parseInt(process.env.SWEEP_GAS_LIMIT) || 21000,
    SWEEP_GAS_PRICE_GWEI: process.env.SWEEP_GAS_PRICE_GWEI || "3",
    DB_PATH: process.env.DB_PATH || "./deposits.db",
    MORALIS_API_KEY_SECRET: process.env.MORALIS_API_KEY,
    USDT_CONTRACT_ADDRESS_SECRET: process.env.USDT_CONTRACT_ADDRESS,
    ANKR_RPC_URL_SECRET: process.env.ANKR_RPC_URL,
    GAS_PAYER_PRIVATE_KEY_SECRET: process.env.GAS_PAYER_PRIVATE_KEY,
    TREASURY_ADDRESS_SECRET: process.env.TREASURY_ADDRESS,
};