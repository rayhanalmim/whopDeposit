const express = require("express");
const { ethers } = require("ethers");
const axios = require('axios');
const Moralis = require("moralis").default;
const { EvmChain } = require("@moralisweb3/common-evm-utils");
const cors = require('cors');
const crypto = require('crypto');

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
const { MORALIS_API_KEY_SECRET, GAS_PAYER_PRIVATE_KEY_SECRET, USDT_CONTRACT_ADDRESS_SECRET, ANKR_RPC_URL_SECRET, TREASURY_ADDRESS_SECRET, WEBHOOK_SECRET } = require("./config");

// Moralis API Configuration
const MORALIS_API_KEY = MORALIS_API_KEY_SECRET;

// USDT Contract Address on BSC
const USDT_CONTRACT_ADDRESS = USDT_CONTRACT_ADDRESS_SECRET;

// BSC RPC URL
const ANKR_RPC_URL = ANKR_RPC_URL_SECRET;

// Treasury wallet configuration
const TREASURY_ADDRESS = TREASURY_ADDRESS_SECRET;
const GAS_PAYER_PRIVATE_KEY = GAS_PAYER_PRIVATE_KEY_SECRET;

// Initialize Moralis
Moralis.start({
    apiKey: MORALIS_API_KEY
});

// Stream management
let activeStreamId = process.env.MORALIS_STREAM_ID || '';

// Store addresses that are being monitored
const monitoredAddresses = new Set();

// Fixed function to fetch wallet balance with correct response handling
async function fetchWalletBalance(address) {
    try {
        // Get native BNB balance
        const nativeBalance = await Moralis.EvmApi.balance.getNativeBalance({
            address: address,
            chain: EvmChain.BSC,
        });

        // Get all token balances for the wallet
        const tokenBalances = await Moralis.EvmApi.token.getWalletTokenBalances({
            address: address,
            chain: EvmChain.BSC,
        });

        const tokenBalanceData = tokenBalances.toJSON();

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
        // Get all token transfers for the address
        const response = await Moralis.EvmApi.token.getWalletTokenTransfers({
            address: address,
            chain: EvmChain.BSC,
            limit: 100,
        });

        const transferData = response.toJSON();

        const transfers = transferData?.result || [];

        // Filter for USDT transfers (incoming only - where to_address matches our address)
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

async function transferToTreasury(deposit) {
    try {
        console.log(`🏦 Initiating transfer for deposit of user ${deposit.userId}`);
        console.log(`Processing deposit for user ${deposit.userId}, address: ${deposit.address}`);

        // Create provider
        const provider = new ethers.JsonRpcProvider(ANKR_RPC_URL);

        // Create wallet from deposit's private key
        const depositWallet = new ethers.Wallet(deposit.privateKey, provider);

        // Create gas payer wallet
        const gasPayerWallet = new ethers.Wallet(GAS_PAYER_PRIVATE_KEY, provider);

        // USDT Contract instance with deposit wallet (for approval)
        const usdtContractWithDeposit = new ethers.Contract(
            USDT_CONTRACT_ADDRESS,
            [
                "function transfer(address recipient, uint256 amount) public returns (bool)",
                "function balanceOf(address account) public view returns (uint256)",
                "function transferFrom(address sender, address recipient, uint256 amount) public returns (bool)",
                "function approve(address spender, uint256 amount) public returns (bool)",
                "function allowance(address owner, address spender) public view returns (uint256)"
            ],
            depositWallet
        );

        // USDT Contract instance with gas payer wallet (for transferFrom)
        const usdtContractWithGasPayer = new ethers.Contract(
            USDT_CONTRACT_ADDRESS,
            [
                "function transfer(address recipient, uint256 amount) public returns (bool)",
                "function balanceOf(address account) public view returns (uint256)",
                "function transferFrom(address sender, address recipient, uint256 amount) public returns (bool)",
                "function approve(address spender, uint256 amount) public returns (bool)",
                "function allowance(address owner, address spender) public view returns (uint256)"
            ],
            gasPayerWallet
        );

        // Fetch the exact USDT balance for the deposit address
        const usdtBalance = await usdtContractWithDeposit.balanceOf(deposit.address);
        console.log(`💰 USDT Balance: ${ethers.formatUnits(usdtBalance, 18)}`);

        // Check if balance is zero
        if (usdtBalance === 0n) {
            console.log(`⚠️ No USDT balance to transfer for user ${deposit.userId}`);
            return {
                success: false,
                error: 'No USDT balance to transfer'
            };
        }

        // Use the full balance for transfer
        const transferAmount = usdtBalance;
        console.log(`💸 Transfer Amount: ${ethers.formatUnits(transferAmount, 18)} USDT`);

        // Check gas payer BNB balance
        const gasPayerBalance = await provider.getBalance(gasPayerWallet.address);
        console.log(`⛽ Gas Payer BNB Balance: ${ethers.formatEther(gasPayerBalance)}`);

        // Check deposit wallet BNB balance
        const depositBnbBalance = await provider.getBalance(deposit.address);
        console.log(`⛽ Deposit Wallet BNB Balance: ${ethers.formatEther(depositBnbBalance)}`);

        // Get current gas price with fallback
        let gasPrice;
        try {
            gasPrice = await provider.getFeeData().then(data => data.gasPrice);
        } catch (error) {
            console.log(`⚠️ Using fallback gas price`);
            gasPrice = ethers.parseUnits("5", "gwei"); // 5 gwei fallback
        }

        // Estimate gas for approval transaction only
        const approvalGasEstimate = await usdtContractWithDeposit.approve.estimateGas(gasPayerWallet.address, transferAmount);
        const approvalGasCost = approvalGasEstimate * gasPrice;
        const approvalGasCostWithBuffer = approvalGasCost + (approvalGasCost * 50n / 100n); // 50% buffer

        console.log(`⛽ Approval Gas Estimate: ${approvalGasEstimate}`);
        console.log(`💸 Approval Gas Cost with Buffer: ${ethers.formatEther(approvalGasCostWithBuffer)} BNB`);

        // If deposit wallet has no BNB, send minimal amount for approval
        if (depositBnbBalance < approvalGasCostWithBuffer) {
            console.log(`📤 Sending minimal BNB from gas payer to deposit wallet for approval...`);

            // Estimate gas for the BNB transfer and add buffer for transferFrom later
            const bnbTransferGasEstimate = 21000n; // Standard gas for BNB transfer
            const bnbTransferGasCost = bnbTransferGasEstimate * gasPrice;
            const estimatedTransferFromGas = 100000n; // Conservative estimate for transferFrom
            const estimatedTransferFromCost = estimatedTransferFromGas * gasPrice;

            const totalRequiredGas = approvalGasCostWithBuffer + bnbTransferGasCost + estimatedTransferFromCost;

            if (gasPayerBalance < totalRequiredGas) {
                throw new Error(`Insufficient gas payer balance. Required: ${ethers.formatEther(totalRequiredGas)} BNB, Available: ${ethers.formatEther(gasPayerBalance)} BNB`);
            }

            // Send minimal BNB for approval
            const bnbTransferTx = await gasPayerWallet.sendTransaction({
                to: deposit.address,
                value: approvalGasCostWithBuffer,
                gasPrice: gasPrice,
                gasLimit: bnbTransferGasEstimate
            });

            await bnbTransferTx.wait();
            console.log(`✅ Minimal BNB sent to deposit wallet. Hash: ${bnbTransferTx.hash}`);

            // Wait for balance to update
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Verify deposit wallet now has BNB
            const updatedBnbBalance = await provider.getBalance(deposit.address);
            console.log(`⛽ Updated Deposit Wallet BNB Balance: ${ethers.formatEther(updatedBnbBalance)}`);
        }

        // Step 1: Approve gas payer to spend USDT on behalf of deposit wallet
        console.log(`📝 Approving gas payer to spend USDT...`);
        const approvalTx = await usdtContractWithDeposit.approve(gasPayerWallet.address, transferAmount, {
            gasPrice: gasPrice,
            gasLimit: approvalGasEstimate + (approvalGasEstimate * 20n / 100n)
        });

        const approvalReceipt = await approvalTx.wait();
        console.log(`✅ Approval successful. Hash: ${approvalReceipt.hash}`);

        // Verify allowance
        const allowance = await usdtContractWithDeposit.allowance(deposit.address, gasPayerWallet.address);
        console.log(`📋 Allowance granted: ${ethers.formatUnits(allowance, 18)} USDT`);

        if (allowance < transferAmount) {
            throw new Error(`Insufficient allowance. Required: ${ethers.formatUnits(transferAmount, 18)}, Granted: ${ethers.formatUnits(allowance, 18)}`);
        }

        // Step 2: Now estimate gas for transferFrom (after approval is complete)
        console.log(`⛽ Estimating gas for transferFrom...`);
        const transferFromGasEstimate = await usdtContractWithGasPayer.transferFrom.estimateGas(
            deposit.address,
            TREASURY_ADDRESS,
            transferAmount
        );
        console.log(`⛽ TransferFrom Gas Estimate: ${transferFromGasEstimate}`);

        // Step 3: Gas payer executes transferFrom to move USDT to treasury
        console.log(`🚀 Executing USDT transferFrom via gas payer...`);
        const transferFromTx = await usdtContractWithGasPayer.transferFrom(
            deposit.address,
            TREASURY_ADDRESS,
            transferAmount,
            {
                gasPrice: gasPrice,
                gasLimit: transferFromGasEstimate + (transferFromGasEstimate * 20n / 100n) // 20% buffer
            }
        );

        const transferFromReceipt = await transferFromTx.wait();
        console.log(`✅ USDT transfer successful for user ${deposit.userId}`);
        console.log(`📝 USDT Transaction Hash: ${transferFromReceipt.hash}`);

        // Verify the transfer
        const remainingBalance = await usdtContractWithDeposit.balanceOf(deposit.address);
        console.log(`💰 Remaining USDT Balance: ${ethers.formatUnits(remainingBalance, 18)}`);

        // Update deposit status
        deposit.status = 'RELEASED';
        deposit.usdtDeposited = parseFloat(ethers.formatUnits(transferAmount, 18));
        deposit.transactionHash = transferFromReceipt.hash;
        await deposit.save();

        // Remove address from monitoring
        if (monitoredAddresses.has(deposit.address.toLowerCase())) {
            monitoredAddresses.delete(deposit.address.toLowerCase());
            
            // In a production environment, you might want to remove it from the stream as well
            // if you have many addresses to manage
            // await removeAddressFromStream(activeStreamId, deposit.address);
        }

        return {
            success: true,
            approvalTransactionHash: approvalReceipt.hash,
            transferTransactionHash: transferFromReceipt.hash,
            amount: ethers.formatUnits(transferAmount, 18),
            remainingBalance: ethers.formatUnits(remainingBalance, 18)
        };

    } catch (error) {
        console.error(`❌ Error transferring funds for user ${deposit.userId}:`, error);

        return {
            success: false,
            error: error.message,
            details: error.reason || error.code || 'Unknown error'
        };
    }
}

// Setup Moralis Stream for monitoring deposits
async function setupMoralisStream() {
    try {
        console.log("🔄 Setting up Moralis Stream for USDT transfers...");
        
        // Create a webhook to monitor USDT transfers
        const webhookStream = await Moralis.Streams.add({
            name: "USDT Deposit Monitor",
            networkType: "bsc",
            chains: [EvmChain.BSC],
            description: "Monitors USDT transfers to deposit addresses",
            topic0: [
                "Transfer(address,address,uint256)" // ERC20 Transfer event
            ],
            includeContractLogs: true,
            includeNativeTxs: false,
            abi: {
                anonymous: false,
                inputs: [
                    {
                        indexed: true,
                        name: "from",
                        type: "address"
                    },
                    {
                        indexed: true,
                        name: "to",
                        type: "address"
                    },
                    {
                        indexed: false,
                        name: "value",
                        type: "uint256"
                    }
                ],
                name: "Transfer",
                type: "event"
            },
            webhookUrl: process.env.WEBHOOK_URL || "https://your-api-url.com/webhook/moralis",
            tag: "usdt-deposits",
            contractAddress: USDT_CONTRACT_ADDRESS
        });
        
        console.log(`✅ Stream created with ID: ${webhookStream.id}`);
        activeStreamId = webhookStream.id;
        
        // Add existing pending deposit addresses to the stream
        const pendingDeposits = await Deposit.find({ status: 'PENDING' });
        
        if (pendingDeposits.length > 0) {
            const addresses = pendingDeposits.map(deposit => deposit.address);
            console.log(`🔄 Adding ${addresses.length} existing deposit addresses to stream...`);
            
            // Add addresses to the Set for local tracking
            addresses.forEach(address => monitoredAddresses.add(address.toLowerCase()));
            
            // Add addresses to the stream in batches (Moralis has limits)
            const batchSize = 100;
            for (let i = 0; i < addresses.length; i += batchSize) {
                const addressBatch = addresses.slice(i, i + batchSize);
                await Moralis.Streams.addAddress({
                    id: webhookStream.id,
                    address: addressBatch
                });
                console.log(`✅ Added addresses batch ${i} to ${i + addressBatch.length - 1} to stream`);
            }
        }
        
        console.log("🎯 Moralis Stream setup complete");
        return webhookStream.id;
    } catch (error) {
        console.error("❌ Error setting up Moralis Stream:", error);
        throw error;
    }
}

// Add a new address to the stream
async function addAddressToStream(address) {
    try {
        if (!activeStreamId) {
            console.log("⚠️ No active stream ID found. Setting up a new stream...");
            activeStreamId = await setupMoralisStream();
        }
        
        console.log(`🔄 Adding address ${address} to stream ${activeStreamId}`);
        
        // Add to local tracking set
        monitoredAddresses.add(address.toLowerCase());
        
        // Add to Moralis stream
        await Moralis.Streams.addAddress({
            id: activeStreamId,
            address: [address]
        });
        
        console.log(`✅ Address ${address} added to stream ${activeStreamId}`);
        return true;
    } catch (error) {
        console.error(`❌ Error adding address ${address} to stream:`, error);
        return false;
    }
}

// Remove address from stream when no longer needed
async function removeAddressFromStream(address) {
    try {
        if (!activeStreamId) {
            console.log("⚠️ No active stream ID found. Cannot remove address.");
            return false;
        }
        
        console.log(`🔄 Removing address ${address} from stream ${activeStreamId}`);
        
        // Remove from local tracking set
        monitoredAddresses.delete(address.toLowerCase());
        
        // Remove from Moralis stream
        await Moralis.Streams.deleteAddress({
            id: activeStreamId,
            address
        });
        
        console.log(`✅ Address ${address} removed from stream ${activeStreamId}`);
        return true;
    } catch (error) {
        console.error(`❌ Error removing address ${address} from stream:`, error);
        return false;
    }
}

// Process a USDT transfer event
async function processUsdtTransfer(toAddress, fromAddress, amount, txHash, blockNumber) {
    try {
        console.log(`🔍 Processing USDT transfer: ${amount} USDT from ${fromAddress} to ${toAddress} in tx ${txHash}`);
        
        // Check if this is a monitored address
        if (!monitoredAddresses.has(toAddress.toLowerCase())) {
            console.log(`⏭️ Address ${toAddress} is not being monitored. Skipping.`);
            return {
                success: false,
                message: "Address not monitored"
            };
        }
        
        // Find the deposit
        const deposit = await Deposit.findOne({
            address: toAddress,
            status: 'PENDING'
        });
        
        if (!deposit) {
            console.log(`❓ No pending deposit found for address ${toAddress}`);
            return {
                success: false,
                message: "No pending deposit found"
            };
        }
        
        console.log(`🎯 Found deposit for user ${deposit.userId} with expected amount ${deposit.expectedAmount}`);
        
        // Convert amount to number for comparison
        const amountReceived = parseFloat(amount);
        const expectedAmount = deposit.expectedAmount;
        
        // Check if the deposit meets the expected amount
        if (amountReceived >= expectedAmount) {
            console.log(`✅ Deposit of ${amountReceived} USDT meets or exceeds expected amount of ${expectedAmount} USDT`);
            
            // Update deposit status
            deposit.status = 'CONFIRMED';
            deposit.usdtDeposited = amountReceived;
            await deposit.save();
            
            // Credit tokens to user
            const creditResult = await creditUser(deposit.userId, expectedAmount, true);
            console.log(`💰 Credited user ${deposit.userId} with tokens:`, creditResult);
            
            // Transfer to treasury
            const transferResult = await transferToTreasury(deposit);
            
            if (transferResult.success) {
                console.log(`🏦 Successfully transferred ${transferResult.amount} USDT to treasury for user ${deposit.userId}`);
                return {
                    success: true,
                    message: "Deposit processed successfully",
                    transferResult
                };
            } else {
                console.log(`⚠️ Failed to transfer to treasury for user ${deposit.userId}: ${transferResult.error}`);
                return {
                    success: false,
                    message: "Deposit confirmed but treasury transfer failed",
                    error: transferResult.error
                };
            }
        } else {
            console.log(`⚠️ Deposit amount ${amountReceived} is less than expected ${expectedAmount}`);
            return {
                success: false,
                message: "Deposit amount is less than expected"
            };
        }
    } catch (error) {
        console.error(`❌ Error processing USDT transfer:`, error);
        return {
            success: false,
            message: "Error processing transfer",
            error: error.message
        };
    }
}

// Express app setup
const app = express();
app.use(express.json());

// Configure CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Signature']
}));

// Webhook endpoint for Moralis Streams
app.post("/webhook/moralis", async (req, res) => {
    try {
        console.log("📨 Webhook received from Moralis Stream");
        
        // Verify the webhook signature for security
        const providedSignature = req.headers['x-signature'];
        if (WEBHOOK_SECRET) {
            const generatedSignature = crypto
                .createHmac('sha256', WEBHOOK_SECRET)
                .update(JSON.stringify(req.body))
                .digest('hex');
                
            if (providedSignature !== generatedSignature) {
                console.log("❌ Invalid webhook signature");
                return res.status(401).json({ success: false, message: "Invalid signature" });
            }
        }
        
        // Extract webhook data
        const { logs, block, confirmed, retries } = req.body;
        
        // Only process confirmed transactions for security
        if (!confirmed) {
            console.log("⏳ Received unconfirmed transaction, waiting for confirmation");
            return res.status(202).json({ success: true, message: "Waiting for confirmation" });
        }
        
        // Process the logs (ERC20 transfers)
        if (logs && logs.length > 0) {
            for (const log of logs) {
                try {
                    // Verify this is a USDT transfer
                    if (log.address.toLowerCase() === USDT_CONTRACT_ADDRESS.toLowerCase()) {
                        // Parse log data
                        const decodedLog = Moralis.Streams.parseLog(log);
                        
                        // Extract transfer details
                        const fromAddress = decodedLog.from;
                        const toAddress = decodedLog.to;
                        const amount = ethers.formatUnits(decodedLog.value, 18); // 18 decimals for USDT on BSC
                        
                        console.log(`💸 Detected USDT transfer: ${amount} from ${fromAddress} to ${toAddress}`);
                        
                        // Process this transfer
                        const result = await processUsdtTransfer(
                            toAddress,
                            fromAddress,
                            amount,
                            log.transactionHash,
                            log.blockNumber
                        );
                        
                        if (result.success) {
                            console.log(`✅ Successfully processed USDT transfer`);
                        }
                    }
                } catch (logError) {
                    console.error(`❌ Error processing log:`, logError);
                    // Continue to next log even if one fails
                }
            }
        }
        
        // Acknowledge the webhook
        return res.status(200).json({
            success: true,
            message: "Webhook processed successfully"
        });
    } catch (error) {
        console.error("❌ Error processing webhook:", error);
        return res.status(500).json({
            success: false,
            message: "Error processing webhook",
            error: error.message
        });
    }
});

// Generate deposit address for a user with expected amount
app.post("/generate-deposit", async (req, res) => {
    try {
        const { userId, expectedAmount } = req.body;
        if (!userId) return res.status(400).json({ error: "Missing userId" });

        // Check for existing pending deposit for this user
        const existingDeposit = await Deposit.findOne({
            userId,
            status: 'PENDING'
        });

        if (existingDeposit) {
            return res.status(400).json({
                success: false,
                message: "You already have an active deposit request. Please complete or cancel the existing deposit before creating a new one.",
                existingDepositAddress: existingDeposit.address
            });
        }

        const wallet = ethers.Wallet.createRandom();
        const deposit = await addDeposit(userId, wallet.address, wallet.privateKey, expectedAmount);
        
        // Add this address to the Moralis stream for monitoring
        const added = await addAddressToStream(wallet.address);
        
        if (added) {
            console.log(`✅ Address ${wallet.address} added to monitoring for user ${userId}`);
        } else {
            console.log(`⚠️ Failed to add address ${wallet.address} to stream, but deposit created`);
        }

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

// Endpoint to fetch existing pending deposits for a specific user
app.get("/user-pending-deposits/:userId", async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "User ID is required"
            });
        }

        // Find pending deposits for the specific user
        const pendingDeposits = await Deposit.find({
            userId,
            status: 'PENDING',
            createdAt: {
                $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
        });

        // If no pending deposits found, return an empty array
        if (pendingDeposits.length === 0) {
            return res.json({
                success: true,
                message: "No pending deposits found for this user",
                deposits: []
            });
        }

        // Process each pending deposit to get more details
        const depositDetails = await Promise.all(pendingDeposits.map(async (deposit) => {
            try {
                // Fetch wallet balances
                const balances = await fetchWalletBalance(deposit.address);

                // Fetch token transfers
                const tokenTransfers = await fetchTokenTransfers(deposit.address);

                // Process token transfers
                const processedTokenTxs = tokenTransfers.map(tx => ({
                    blockchain: 'bsc',
                    contractAddress: tx.address,
                    fromAddress: tx.from_address,
                    toAddress: tx.to_address,
                    tokenName: tx.token_name,
                    tokenSymbol: tx.token_symbol,
                    tokenDecimals: parseInt(tx.token_decimals) || 18,
                    value: tx.value,
                    valueDecimal: tx.value_decimal,
                    transactionHash: tx.transaction_hash,
                    blockNumber: tx.block_number,
                    timestamp: tx.block_timestamp
                }));

                // Calculate total USDT received
                const totalUSDTReceived = processedTokenTxs.reduce((total, tx) => {
                    try {
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
                    depositId: deposit._id,
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
                console.error(`Error processing deposit for user ${userId}:`, addressError);
                return {
                    depositId: deposit._id,
                    address: deposit.address,
                    expectedAmount: deposit.expectedAmount,
                    error: addressError.message
                };
            }
        }));

        res.json({
            success: true,
            message: `Found ${depositDetails.length} pending deposits for user ${userId}`,
            deposits: depositDetails
        });
    } catch (error) {
        console.error(`Error fetching pending deposits for user ${req.params.userId}:`, error);
        res.status(500).json({
            success: false,
            message: "Error retrieving pending deposits",
            error: error.message
        });
    }
});

// Endpoint to check deposit status
app.get("/check-deposit-status", async (req, res) => {
    try {
        const { userId, depositAddress } = req.query;

        if (!userId || !depositAddress) {
            return res.status(400).json({
                success: false,
                message: "User ID and Deposit Address are required"
            });
        }

        // Find the deposit
        const deposit = await Deposit.findOne({
            userId,
            address: depositAddress
        });

        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: "Deposit not found"
            });
        }

        // Fetch wallet balances
        const balances = await fetchWalletBalance(depositAddress);

        // Fetch token transfers
        const tokenTransfers = await fetchTokenTransfers(depositAddress);

        // Process token transfers
        const processedTokenTxs = tokenTransfers.map(tx => ({
            blockchain: 'bsc',
            contractAddress: tx.address,
            fromAddress: tx.from_address,
            toAddress: tx.to_address,
            value: tx.value_decimal || ethers.formatUnits(tx.value || "0", tx.token_decimals),
            transactionHash: tx.transaction_hash,
            timestamp: tx.block_timestamp
        }));

        // Calculate total USDT received
        const totalUSDTReceived = processedTokenTxs.reduce((total, tx) => {
            try {
                return total + parseFloat(tx.value);
            } catch (formatError) {
                console.error(`Error formatting token value:`, formatError);
                return total;
            }
        }, 0);

        res.json({
            success: true,
            depositStatus: deposit.status,
            expectedAmount: deposit.expectedAmount,
            usdtDeposited: totalUSDTReceived,
            transactions: processedTokenTxs,
            isReleased: deposit.status === 'RELEASED'
        });
    } catch (error) {
        console.error('Error checking deposit status:', error);
        res.status(500).json({
            success: false,
            message: "Error checking deposit status",
            error: error.message
        });
    }
});

// Endpoint to fetch user's released deposits
app.get("/user-released-deposits/:userId", async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "User ID is required"
            });
        }

        // Find all released deposits for the user
        const releasedDeposits = await Deposit.find({
            userId,
            status: 'RELEASED',
            createdAt: {
                $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // Last 90 days
            }
        }).sort({ createdAt: -1 }); // Sort by most recent first

        // Process deposits to include more details
        const processedDeposits = releasedDeposits.map(deposit => ({
            depositId: deposit._id,
            expectedAmount: deposit.expectedAmount,
            usdtDeposited: deposit.usdtDeposited,
            network: deposit.network || 1, // Default to BNB network if not specified
            createdAt: deposit.createdAt,
            releasedAt: deposit.updatedAt, // Assuming updatedAt is set when status changes
            transactionHash: deposit.transactionHash || null
        }));

        res.json({
            success: true,
            message: `Found ${processedDeposits.length} released deposits for user ${userId}`,
            deposits: processedDeposits
        });
    } catch (error) {
        console.error(`Error fetching released deposits for user ${req.params.userId}:`, error);
        res.status(500).json({
            success: false,
            message: "Error retrieving released deposits",
            error: error.message
        });
    }
});

// Delete a specific deposit
app.delete("/api/deposit/:depositId", async (req, res) => {
    try {
        const { depositId } = req.params;
        const { userId } = req.body;

        if (!depositId) {
            return res.status(400).json({
                success: false,
                message: "Deposit ID is required"
            });
        }

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "User ID is required"
            });
        }

        // Find the deposit first to get the address
        const deposit = await Deposit.findOne({
            _id: depositId,
            userId: userId,
            status: 'PENDING'
        });

        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: "Deposit not found or cannot be deleted"
            });
        }

        // Remove from monitoring if it exists
        if (monitoredAddresses.has(deposit.address.toLowerCase())) {
            monitoredAddresses.delete(deposit.address.toLowerCase());
            
            // You might want to remove from the stream as well in a production environment
            // if (activeStreamId) {
            //     await removeAddressFromStream(deposit.address);
            // }
        }

        // Delete the deposit
        await Deposit.findOneAndDelete({
            _id: depositId,
            userId: userId,
            status: 'PENDING'
        });

        res.json({
            success: true,
            message: "Deposit successfully deleted",
            depositId: deposit._id
        });
    } catch (error) {
        console.error('Error deleting deposit:', error);
        res.status(500).json({
            success: false,
            message: "Error deleting deposit",
            error: error.message
        });
    }
});

// Initialize the application
async function initializeApp() {
    try {
        console.log("🚀 Initializing deposit monitoring system...");
        
        // Check for existing stream ID in environment
        if (process.env.MORALIS_STREAM_ID) {
            activeStreamId = process.env.MORALIS_STREAM_ID;
            console.log(`🔄 Using existing Moralis Stream ID: ${activeStreamId}`);
            
            // Load existing pending deposits into monitored addresses
            const pendingDeposits = await Deposit.find({ status: 'PENDING' });
            pendingDeposits.forEach(deposit => {
                monitoredAddresses.add(deposit.address.toLowerCase());
            });
            
            console.log(`📋 Loaded ${monitoredAddresses.size} addresses for monitoring`);
        } else {
            // Set up new stream
            activeStreamId = await setupMoralisStream();
            console.log(`🔄 Created new Moralis Stream with ID: ${activeStreamId}`);
            console.log(`⚠️ Save this stream ID in your environment variables: MORALIS_STREAM_ID=${activeStreamId}`);
        }
        
        console.log("✅ Deposit monitoring system initialized successfully");
    } catch (error) {
        console.error("❌ Failed to initialize deposit monitoring system:", error);
    }
}

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
    const PORT = process.env.PORT || 8000;
    app.listen(PORT, async () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        await initializeApp();
    });
}

module.exports = app;