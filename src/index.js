const express = require("express");
const { ethers } = require("ethers");
const axios = require('axios');
const Moralis = require("moralis").default;
const { EvmChain } = require("@moralisweb3/common-evm-utils");
const cron = require('node-cron');
const cors = require('cors'); // Add CORS import

const {
    addDeposit,
    releaseTokens,
    getDepositDetails,
    creditUser,
    verifyRecentDeposits,
    validateDepositsByTransactions,
    getAnkrProvider,
    Deposit,
    ArchivedDeposit
} = require("./db");
const { MORALIS_API_KEY_SECRET, GAS_PAYER_PRIVATE_KEY_SECRET, USDT_CONTRACT_ADDRESS_SECRET, ANKR_RPC_URL_SECRET, TREASURY_ADDRESS_SECRET } = require("./config");
const { apiKeyAuth } = require("./middleware/auth");

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
        deposit.usdtDeposited = parseFloat(ethers.formatUnits(remainingBalance, 18));
        await deposit.save();

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

//Check deposit
async function processDeposits() {
    try {

        // Fetch pending deposits
        const pendingDepositsResponse = await axios.get(`http://localhost:8000/pending-deposits?flag=${true}`);
        const deposits = pendingDepositsResponse.data.deposits;

        console.log(`🔍 Found ${deposits.length} pending deposits to process`);

        console.log('deposits', deposits);

        // Process each deposit
        for (const deposit of deposits) {
            try {
                // Check if the total received USDT matches the expected amount
                const totalUSDTReceived = parseFloat(deposit.balances.usdt.totalReceived);
                const expectedAmount = deposit.expectedAmount;


                // Check if the deposit meets the expected amount
                if (totalUSDTReceived >= expectedAmount) {
                    // Find the actual deposit document
                    const depositToUpdate = await Deposit.findOne({
                        userId: deposit.userId,
                        address: deposit.address
                    });

                    if (depositToUpdate) {
                        // Update deposit details
                        depositToUpdate.status = 'CONFIRMED';
                        depositToUpdate.usdtDeposited = totalUSDTReceived;

                        // Save the updated deposit
                        await depositToUpdate.save();

                        // Credit tokens
                        const updateResult = await creditUser(deposit.userId, expectedAmount, true);

                        // Attempt to transfer to treasury
                        const transferResult = await transferToTreasury(depositToUpdate);

                        if (transferResult.success) {
                            console.log(`💼 Funds transferred to treasury for user ${deposit.userId}`);
                        } else {
                            console.log(`❌ Failed to transfer funds to treasury for user ${deposit.userId}`);
                        }
                    } else {
                        console.log(`❌ Deposit not found for user ${deposit.userId}`);
                    }
                } else {
                    console.log(`⚠️ Deposit for user ${deposit.userId} not yet validated`);
                }
            } catch (depositError) {
                console.error(`Error processing deposit for user ${deposit.userId}:`, depositError);
            }
        }
    } catch (error) {
        console.error('❌ Error in periodic deposit processing:', error);
    }
}
async function processDepositsWithFlag() {
    try {
        // Fetch pending deposits
        const pendingDepositsResponse = await axios.get(`http://localhost:8000/pending-deposits?flag=${false}`);
        const deposits = pendingDepositsResponse.data.deposits;

        console.log(`🔍 Found ${deposits.length} pending deposits to process`);

        console.log('deposits', deposits);

        // Process each deposit
        for (const deposit of deposits) {
            try {
                // Check if the total received USDT matches the expected amount
                const totalUSDTReceived = parseFloat(deposit.balances.usdt.totalReceived);
                const expectedAmount = deposit.expectedAmount;


                // Check if the deposit meets the expected amount
                if (totalUSDTReceived >= expectedAmount) {
                    // Find the actual deposit document
                    const depositToUpdate = await Deposit.findOne({
                        userId: deposit.userId,
                        address: deposit.address
                    });

                    if (depositToUpdate) {
                        // Update deposit details
                        depositToUpdate.status = 'CONFIRMED';
                        depositToUpdate.usdtDeposited = totalUSDTReceived;

                        // Save the updated deposit
                        await depositToUpdate.save();

                        // Credit tokens
                        const updateResult = await creditUser(deposit.userId, expectedAmount, true);

                        // Attempt to transfer to treasury
                        const transferResult = await transferToTreasury(depositToUpdate);

                        if (transferResult.success) {
                            console.log(`💼 Funds transferred to treasury for user ${deposit.userId}`);
                        } else {
                            console.log(`❌ Failed to transfer funds to treasury for user ${deposit.userId}`);
                        }
                    } else {
                        console.log(`❌ Deposit not found for user ${deposit.userId}`);
                    }
                } else {
                    console.log(`⚠️ Deposit for user ${deposit.userId} not yet validated`);
                }
            } catch (depositError) {
                console.error(`Error processing deposit for user ${deposit.userId}:`, depositError);
            }
        }
    } catch (error) {
        console.error('❌ Error in periodic deposit processing:', error);
    }
}

// Schedule the deposit processing task to run every 3 minutes
cron.schedule('*/3 * * * *', processDeposits);


cron.schedule('*/20 * * * *', processDepositsWithFlag);

// Schedule the treasury transfer task to run every 3 minutes
cron.schedule('*/3 * * * *', async () => {
    try {
        console.log('🏦 Starting periodic treasury transfer process...');

        // Find all confirmed deposits that haven't been released
        const confirmedDeposits = await Deposit.find({
            status: 'CONFIRMED',
            usdtDeposited: { $gt: 0 }
        });

        console.log('confirmed deposits: ', confirmedDeposits);

        console.log(`🔍 Found ${confirmedDeposits.length} confirmed deposits to transfer`);

        // Process each confirmed deposit
        for (const deposit of confirmedDeposits) {
            try {
                // Attempt to transfer to treasury
                const transferResult = await transferToTreasury(deposit);

                if (transferResult.success) {
                    console.log(`💼 Successfully transferred deposit for user ${deposit.userId} to treasury`);
                } else {
                    console.log(`❌ Failed to transfer deposit for user ${deposit.userId} to treasury`);
                }
            } catch (depositTransferError) {
                console.error(`Error processing deposit transfer for user ${deposit.userId}:`, depositTransferError);
            }
        }
    } catch (error) {
        console.error('❌ Error in periodic treasury transfer process:', error);
    }
});

// Function to move old pending deposits to archive
async function archiveOldPendingDeposits() {
    try {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

        // Find old pending deposits
        const oldPendingDeposits = await Deposit.find({
            status: 'PENDING',
            createdAt: { $lt: thirtyMinutesAgo }
        });

        // If no old deposits, return early
        if (oldPendingDeposits.length === 0) {
            console.log('🕰️ No old pending deposits to archive');
            return;
        }

        // Prepare archived deposits
        const archivedDeposits = oldPendingDeposits.map(deposit => ({
            originalId: deposit._id,
            userId: deposit.userId,
            address: deposit.address,
            privateKey: deposit.privateKey,
            balance: deposit.balance,
            tokenBalance: deposit.tokenBalance,
            status: 'EXPIRED',
            expectedAmount: deposit.expectedAmount,
            usdtDeposited: deposit.usdtDeposited,
            originalCreatedAt: deposit.createdAt
        }));

        // Insert into archived collection
        await ArchivedDeposit.insertMany(archivedDeposits);

        // Remove from original collection
        await Deposit.deleteMany({
            status: 'PENDING',
            createdAt: { $lt: thirtyMinutesAgo }
        });

        console.log(`🗄️ Archived ${archivedDeposits.length} old pending deposits`);
    } catch (error) {
        console.error('Error archiving old pending deposits:', error);
    }
}

// Schedule the archive old pending deposits task to run every 3 minutes
cron.schedule('*/3 * * * *', archiveOldPendingDeposits);

const app = express();
app.use(express.json());

// Configure CORS with specific options
app.use(cors({
    origin: '*', // Allow requests from any origin
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.post("/generate-deposit", apiKeyAuth, async (req, res) => {
    try {
        const { userId, expectedAmount } = req.body;
        if (!userId) return res.status(400).json({ error: "Missing userId" });

        // Check for existing pending deposit for this user
        const existingDeposit = await Deposit.findOne({
            userId,
            status: 'PENDING'
        });

        const existingReleasedDeposit = await Deposit.findOne({
            userId,
            status: 'RELEASED',
            isTaken: false
        });

        console.log("both deposits", existingDeposit, existingReleasedDeposit);

        if (existingDeposit || existingReleasedDeposit) {
            return res.status(202).json({
                success: false,
                message: "You already have an active deposit request. Please complete or cancel the existing deposit before creating a new one.",
                existingDepositAddress: existingDeposit?.address || existingReleasedDeposit?.address
            });
        }

        const wallet = ethers.Wallet.createRandom();
        const deposit = await addDeposit(userId, wallet.address, wallet.privateKey, expectedAmount);

        // Exclude privateKey from the new deposit object
        const { privateKey, tokenBalance, ...sanitizedDeposit } = deposit.toObject();

        res.json({
            success: true,
            deposit: sanitizedDeposit
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
        const flag = req.query.flag;
        const pendingDeposits = await Deposit.find({
            status: 'PENDING',
            readyForValidate : flag,
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

// New endpoint to fetch existing pending deposits for a specific user
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

        // Find pending and released deposits for the specific user
        const PendingReleasedDeposits = await Deposit.find({
            userId,
            status: 'RELEASED',
            isTaken: false,
            createdAt: {
                $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
        });

        // If no pending deposits found, return an empty array
        if (pendingDeposits.length === 0 && PendingReleasedDeposits.length === 0) {
            return res.json({
                pending: false,
                message: "No pending deposits found for this user",
                deposits: []
            });
        }

        const allDeposits = [...pendingDeposits, ...PendingReleasedDeposits];



        // Process each pending deposit to get more details
        const depositDetails = await Promise.all(allDeposits.map(async (deposit) => {
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
            pending: pendingDeposits.length > 0 && PendingReleasedDeposits.length === 0,
            pendingReleased: PendingReleasedDeposits.length > 0,
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



// New endpoint to check deposit status
app.get("/check-deposit-status", async (req, res) => {
    try {
        const { userId, depositAddress } = req.query;

        if (!userId || !depositAddress) {
            return res.status(400).json({
                success: false,
                message: "User ID and Deposit Address are required"
            });
        }

        console.log('both deposits', userId, depositAddress);

        // Find the deposit in main collection
        let deposit = await Deposit.findOne({
            userId,
            address: depositAddress
        });

        console.log(deposit);


        // Set archive flag
        let isArchived = false;

        // If deposit not found in main collection, check the archive
        if (!deposit) {
            deposit = await ArchivedDeposit.findOne({
                userId,
                address: depositAddress,
                status: "EXPIRED"
            });

            // If still not found, return 404
            if (!deposit) {
                return res.status(404).json({
                    success: false,
                    message: "Deposit not found"
                });
            }

            // Set archive flag to true if found in archive
            isArchived = true;
        }

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


        const isReleased = await Deposit.findOne({
            userId,
            address: depositAddress,
            status: "RELEASED"
        });

        await Deposit.updateOne({
            userId,
            address: depositAddress
        }, {
            readyForValidate: true
        });

        if (isReleased) {
            await Deposit.updateOne({
                userId,
                address: depositAddress
            }, {
                isTaken: true
            });
        }

        res.json({
            success: true,
            depositStatus: deposit.status,
            expectedAmount: deposit.expectedAmount,
            depositId: deposit._id,
            depositAddress: deposit.address,
            isReleased: deposit.status === 'RELEASED',
            archived: isArchived // Added archive flag to the response
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

// New endpoint to fetch user's released deposits
app.get("/user-released-deposits/:userId", apiKeyAuth, async (req, res) => {
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
        const processedDeposits = await Promise.all(releasedDeposits.map(async (deposit) => {
            try {
                // Fetch wallet balances at the time of deposit
                const balances = await fetchWalletBalance(deposit.address);

                return {
                    depositId: deposit._id,
                    expectedAmount: deposit.expectedAmount,
                    usdtDeposited: deposit.usdtDeposited,
                    network: deposit.network || 1, // Default to BNB network if not specified
                    createdAt: deposit.createdAt,
                    releasedAt: deposit.updatedAt, // Assuming updatedAt is set when status changes
                    transactionHash: deposit.transactionHash || null
                };
            } catch (addressError) {
                console.error(`Error processing released deposit for user ${userId}:`, addressError);
                return {
                    depositId: deposit._id,
                    expectedAmount: deposit.expectedAmount,
                    error: addressError.message
                };
            }
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
app.delete("/api/deposit/:depositId", apiKeyAuth, async (req, res) => {
    try {
        const { depositId } = req.params;

        console.log('hitttttttttt');

        if (!depositId) {
            return res.status(400).json({
                success: false,
                message: "Deposit ID is required"
            });
        }


        // Find and delete the deposit
        const deletedDeposit = await Deposit.findOneAndDelete({
            _id: depositId,
            status: 'PENDING' // Only allow deleting pending deposits
        });

        if (!deletedDeposit) {
            return res.status(404).json({
                success: false,
                message: "Deposit not found or cannot be deleted"
            });
        }

        res.json({
            success: true,
            message: "Deposit successfully deleted",
            depositId: deletedDeposit._id
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
    const PORT = 8000;
    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;