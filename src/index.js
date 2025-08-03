const express = require("express");
const { ethers } = require("ethers");
const axios = require('axios');
const Moralis = require("moralis").default;
const { EvmChain } = require("@moralisweb3/common-evm-utils");

const {
    addDeposit,
    releaseTokens,
    getDepositDetails,
    creditUser,
    verifyRecentDeposits,
    validateDepositsByTransactions,
    getAnkrProvider,
    Deposit
} = require("./db");

// Moralis API Configuration
const MORALIS_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjczMWJkZDMzLTE5MWEtNDJlZS05NzM0LTAyMzhkMDRlNDVlNCIsIm9yZ0lkIjoiNDYxNzczIiwidXNlcklkIjoiNDc1MDcwIiwidHlwZUlkIjoiYWJjMzdmZGUtNzI5Zi00NDNjLTgxYWEtNGQ4YTU3NDFiMWY1IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NTM2MjkzMTIsImV4cCI6NDkwOTM4OTMxMn0.-TFKNZ2b6nvgQEDp0M4O8iA4Xdt-SesVhFCVf1GswT0';

// USDT Contract Address on BSC
const USDT_CONTRACT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";

// Initialize Moralis
Moralis.start({
    apiKey: MORALIS_API_KEY
});

// Fixed function to fetch wallet balance with correct response handling
async function fetchWalletBalance(address) {
    try {
        console.log(`Fetching balance for address: ${address}`);

        // Get native BNB balance
        const nativeBalance = await Moralis.EvmApi.balance.getNativeBalance({
            address: address,
            chain: EvmChain.BSC,
        });

        console.log(`Native balance response:`, nativeBalance.toJSON());

        // Get all token balances for the wallet
        const tokenBalances = await Moralis.EvmApi.token.getWalletTokenBalances({
            address: address,
            chain: EvmChain.BSC,
        });

        const tokenBalanceData = tokenBalances.toJSON();
        console.log(`Token balances response:`, tokenBalanceData);

        // Handle the response format - it can be an array directly or an object with result property
        let tokenResults = [];
        if (Array.isArray(tokenBalanceData)) {
            tokenResults = tokenBalanceData;
        } else if (tokenBalanceData && tokenBalanceData.result) {
            tokenResults = tokenBalanceData.result;
        }

        // Find USDT balance from token balances (case-insensitive comparison)
        const usdtToken = tokenResults.find(
            token => token.token_address &&
                token.token_address.toLowerCase() === USDT_CONTRACT_ADDRESS.toLowerCase()
        );

        console.log(`USDT token found:`, usdtToken);

        return {
            nativeBalance: nativeBalance.toJSON().balance || "0",
            usdtBalance: usdtToken ? usdtToken.balance : "0"
        };
    } catch (error) {
        console.error(`Error fetching wallet balance for ${address}:`, error);
        return {
            nativeBalance: "0",
            usdtBalance: "0"
        };
    }
}

// Fixed function to fetch token transfers with correct filtering
async function fetchTokenTransfers(address) {
    try {
        console.log(`Fetching token transfers for address: ${address}`);

        // Get all token transfers for the address
        const response = await Moralis.EvmApi.token.getWalletTokenTransfers({
            address: address,
            chain: EvmChain.BSC,
            limit: 100,
        });

        const transferData = response.toJSON();
        console.log(`Token transfers response:`, transferData);

        const transfers = transferData?.result || [];

        // Filter for USDT transfers (incoming only - where to_address matches our address)
        // Use 'address' field from the response which contains the token contract address
        const usdtTransfers = transfers.filter(
            transfer => transfer.address &&
                transfer.address.toLowerCase() === USDT_CONTRACT_ADDRESS.toLowerCase() &&
                transfer.to_address.toLowerCase() === address.toLowerCase()
        );

        console.log(`Found ${usdtTransfers.length} USDT transfers for ${address}`);

        return usdtTransfers;
    } catch (error) {
        console.error(`Error fetching token transfers for ${address}:`, error);
        return [];
    }
}

const app = express();
app.use(express.json());

// Generate deposit address for a user with expected amount
app.post("/generate-deposit", async (req, res) => {
    try {
        const { userId, expectedAmount } = req.body;
        if (!userId) return res.status(400).json({ error: "Missing userId" });

        const wallet = ethers.Wallet.createRandom();
        const deposit = await addDeposit(userId, wallet.address, wallet.privateKey, expectedAmount);

        res.json({
            depositAddress: deposit.address,
            expectedAmount: deposit.expectedAmount || 0,
            instructions: `
                Send BNB to this address and USDT to the same address.
                Minimum BNB deposit: 0.001 BNB
                Expected USDT Amount: ${deposit.expectedAmount || 'Not specified'}
                Maximum BNB deposit: 100 BNB
            `
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error generating deposit",
            error: error.message
        });
    }
});

// Endpoint to fetch all pending deposit addresses with transactions
app.get("/pending-deposits", async (req, res) => {
    try {
        // Find all pending deposits
        const pendingDeposits = await Deposit.find({
            status: 'PENDING',
            createdAt: {
                $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
        });

        console.log(`Found ${pendingDeposits.length} pending deposits`);

        // Fetch transactions for each deposit
        const depositDetails = await Promise.all(pendingDeposits.map(async (deposit) => {
            try {
                console.log(`Processing deposit for user ${deposit.userId}, address: ${deposit.address}`);

                // Fetch wallet balances
                const balances = await fetchWalletBalance(deposit.address);

                // Get wallet transactions (optional - for debugging)
                let walletTransactions = [];
                try {
                    const response = await Moralis.EvmApi.transaction.getWalletTransactions({
                        address: deposit.address,
                        chain: EvmChain.BSC,
                        limit: 100
                    });
                    const txData = response.toJSON();
                    walletTransactions = txData?.result || [];
                    console.log(`Found ${walletTransactions.length} transactions for ${deposit.address}`);
                } catch (txError) {
                    console.error(`Error fetching transactions for ${deposit.address}:`, txError);
                }

                // Fetch token transfers
                const tokenTransfers = await fetchTokenTransfers(deposit.address);

                // Process token transfers
                const processedTokenTxs = tokenTransfers.map(tx => ({
                    blockchain: 'bsc',
                    contractAddress: tx.address, // Use 'address' field which contains token contract
                    fromAddress: tx.from_address,
                    toAddress: tx.to_address,
                    tokenName: tx.token_name,
                    tokenSymbol: tx.token_symbol,
                    tokenDecimals: parseInt(tx.token_decimals) || 18,
                    value: tx.value,
                    valueDecimal: tx.value_decimal, // Already formatted value
                    transactionHash: tx.transaction_hash,
                    blockNumber: tx.block_number,
                    timestamp: tx.block_timestamp
                }));

                // Calculate total USDT received using the pre-formatted value_decimal
                const totalUSDTReceived = processedTokenTxs.reduce((total, tx) => {
                    try {
                        // Use value_decimal if available, otherwise format the raw value
                        const amount = tx.valueDecimal ?
                            parseFloat(tx.valueDecimal) :
                            parseFloat(ethers.formatUnits(tx.value || "0", tx.tokenDecimals));
                        return total + amount;
                    } catch (formatError) {
                        console.error(`Error formatting token value:`, formatError);
                        return total;
                    }
                }, 0);

                return {
                    userId: deposit.userId,
                    address: deposit.address,
                    expectedAmount: deposit.expectedAmount,
                    createdAt: deposit.createdAt,
                    balances: {
                        usdt: {
                            balance: ethers.formatUnits(balances.usdtBalance || "0", 18),
                            balanceRaw: balances.usdtBalance,
                            totalReceived: totalUSDTReceived.toString()
                        },
                        bnb: {
                            balance: ethers.formatEther(balances.nativeBalance || "0"),
                            balanceRaw: balances.nativeBalance
                        }
                    },
                    transactions: {
                        count: walletTransactions.length,
                        tokenTransfersCount: processedTokenTxs.length,
                        usdt: processedTokenTxs,
                        usdtDetails: processedTokenTxs.map(tx => ({
                            amount: tx.valueDecimal || ethers.formatUnits(tx.value || "0", tx.tokenDecimals),
                            transactionHash: tx.transactionHash,
                            timestamp: tx.timestamp,
                            from: tx.fromAddress,
                            blockNumber: tx.blockNumber
                        }))
                    }
                };
            } catch (addressError) {
                console.error(`Error processing deposit for user ${deposit.userId}:`, addressError);
                return {
                    userId: deposit.userId,
                    address: deposit.address,
                    expectedAmount: deposit.expectedAmount,
                    error: addressError.message
                };
            }
        }));

        res.json({
            success: true,
            message: `Found ${depositDetails.length} pending deposits`,
            deposits: depositDetails
        });
    } catch (error) {
        console.error('Error fetching pending deposits:', error);
        res.status(500).json({
            success: false,
            message: "Error retrieving pending deposits",
            error: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        message: "Something went wrong!",
        error: err.message
    });
});

// Start the server if this file is run directly
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;