require('dotenv').config();
const mongoose = require('mongoose');
const ethers = require('ethers');
const { AnkrProvider } = require('@ankr.com/ankr.js');

// MongoDB connection URL from environment variable
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is not defined in the environment variables');
    process.exit(1);
}

// Ankr RPC URL with API key
const ANKR_RPC_URL = 'https://rpc.ankr.com/multichain/c28346545b352ffe725599a797cacfad2dafb9d376391df51dcdc2c4d64e1650';

// USDT Contract Address on BSC
const USDT_CONTRACT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";

// USDT ABI for transfer event
const USDT_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// Function to get Ankr provider
function getAnkrProvider() {
    try {
        const provider = new AnkrProvider(ANKR_RPC_URL);
        return provider;
    } catch (error) {
        console.error('Error creating Ankr provider:', error);
        throw error;
    }
}

// Function to get ethers provider
function getEthersProvider() {
    try {
        const provider = new ethers.JsonRpcProvider(ANKR_RPC_URL);
        return provider;
    } catch (error) {
        console.error('Error creating ethers provider:', error);
        throw error;
    }
}

// Deposit Schema
const depositSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    address: {
        type: String,
        required: true,
        unique: true
    },
    privateKey: {
        type: String,
        required: true
    },
    balance: {
        type: Number,
        default: 0
    },
    tokenBalance: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['PENDING', 'CONFIRMED', 'RELEASED'],
        default: 'PENDING'
    },
    isTaken: {
        type: Boolean,
        required: false
    },
    expectedAmount: {
        type: Number,
        default: 0
    },
    usdtDeposited: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Create Deposit Model
const Deposit = mongoose.model('userdeposits', depositSchema);

// Archived Deposit Schema
const archivedDepositSchema = new mongoose.Schema({
    originalId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    userId: {
        type: String,
        required: true,
        index: true
    },
    address: {
        type: String,
        required: true
    },
    privateKey: {
        type: String,
        required: true
    },
    isTaken: {
        type: Boolean,
        required: false
    },
    balance: {
        type: Number,
        default: 0
    },
    tokenBalance: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['PENDING', 'EXPIRED'],
        default: 'EXPIRED'
    },
    expectedAmount: {
        type: Number,
        default: 0
    },
    usdtDeposited: {
        type: Number,
        default: 0
    },
    originalCreatedAt: {
        type: Date,
        required: true
    },
    archivedAt: {
        type: Date,
        default: Date.now
    }
});

// Create Archived Deposit Model
const ArchivedDeposit = mongoose.model('archiveddeposits', archivedDepositSchema);

// Connect to MongoDB
async function connectDB() {
    try {
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });
        console.log('✅ Connected to MongoDB successfully');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Validate and potentially release tokens
async function validateAndReleaseTokens(userId) {
    try {
        const deposit = await Deposit.findOne({ userId });

        if (deposit && deposit.status === 'PENDING') {
            const bnbDepositValid = deposit.balance > 0;
            const usdtDepositValid = deposit.expectedAmount === 0 || deposit.usdtDeposited >= deposit.expectedAmount;

            if (bnbDepositValid && usdtDepositValid) {
                // Example conversion rate: 1 BNB = 1000 Tokens
                const tokensToRelease = deposit.balance * 1000;

                deposit.tokenBalance = tokensToRelease;
                deposit.status = 'CONFIRMED';

                await deposit.save();

                console.log(`🚀 Tokens ready for user ${userId}: ${tokensToRelease} tokens`);
                return tokensToRelease;
            }
        }
        return 0;
    } catch (error) {
        console.error('Error validating tokens:', error);
        throw error;
    }
}

// Validate deposits by directly fetching and checking transactions
async function validateDepositsByTransactions() {
    try {
        // Find all pending deposits
        const pendingDeposits = await Deposit.find({
            status: 'PENDING',
            createdAt: {
                $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
        });

        console.log(`🔍 Validating ${pendingDeposits.length} pending deposits`);

        const provider = getAnkrProvider();

        const validationResults = [];

        for (const deposit of pendingDeposits) {
            console.log(`\n🕵️ Checking Deposit Details:`);
            console.log(`   User ID: ${deposit.userId}`);
            console.log(`   Address: ${deposit.address}`);
            console.log(`   Expected Amount: ${deposit.expectedAmount}`);

            try {
                // Fetch account balances across multiple chains
                console.log('🌐 Fetching Account Balances...');
                const accountBalances = await provider.getAccountBalance({
                    blockchain: ['bsc'],
                    walletAddress: deposit.address,
                    onlyWhitelisted: false
                });

                // Log full account balances for debugging
                console.log('📊 Full Account Balances:', JSON.stringify(accountBalances, null, 2));

                // Extract BNB balance
                let bnbBalanceEther = '0';
                let usdtBalanceFormatted = '0';

                // Find BNB balance
                const bnbAsset = accountBalances.assets?.find(
                    asset => asset.blockchain === 'bsc' && asset.tokenType === 'NATIVE'
                );
                if (bnbAsset) {
                    bnbBalanceEther = ethers.formatEther(bnbAsset.balanceRawInteger);
                }
                console.log(`   BNB Balance: ${bnbBalanceEther}`);

                // Find USDT balance
                const usdtAsset = accountBalances.assets?.find(
                    asset => asset.contractAddress?.toLowerCase() === USDT_CONTRACT_ADDRESS.toLowerCase()
                );
                if (usdtAsset) {
                    usdtBalanceFormatted = ethers.formatUnits(
                        usdtAsset.balanceRawInteger,
                        usdtAsset.tokenDecimals
                    );
                }
                console.log(`   USDT Balance: ${usdtBalanceFormatted}`);

                // Validation logic
                const shouldValidate =
                    parseFloat(bnbBalanceEther) > 0 &&
                    (deposit.expectedAmount === 0 ||
                        parseFloat(usdtBalanceFormatted) >= deposit.expectedAmount);

                if (shouldValidate) {
                    console.log(`✅ Deposit Validated for User ${deposit.userId}`);

                    // Update deposit details
                    deposit.balance = parseFloat(bnbBalanceEther);
                    deposit.usdtDeposited = parseFloat(usdtBalanceFormatted);

                    // Validate and potentially release tokens
                    const tokensToRelease = await validateAndReleaseTokens(deposit.userId);

                    validationResults.push({
                        userId: deposit.userId,
                        status: 'VALIDATED',
                        address: deposit.address,
                        bnbBalance: bnbBalanceEther,
                        usdtBalance: usdtBalanceFormatted,
                        tokensReleased: tokensToRelease
                    });
                } else {
                    console.log(`⚠️ Deposit Not Validated for User ${deposit.userId}`);
                    console.log('   Reasons:');
                    if (parseFloat(bnbBalanceEther) === 0) console.log('   - No BNB Balance');
                    if (deposit.expectedAmount > 0 && parseFloat(usdtBalanceFormatted) < deposit.expectedAmount) {
                        console.log('   - USDT Deposit Insufficient');
                    }

                    validationResults.push({
                        userId: deposit.userId,
                        status: 'NOT_VALIDATED',
                        address: deposit.address,
                        bnbBalance: bnbBalanceEther,
                        usdtBalance: usdtBalanceFormatted,
                        tokensReleased: 0
                    });
                }
            } catch (addressError) {
                console.error(`❌ Error processing deposit for user ${deposit.userId}:`, addressError);
                validationResults.push({
                    userId: deposit.userId,
                    status: 'ERROR',
                    address: deposit.address,
                    error: addressError.message
                });
            }
        }

        console.log('\n📊 Validation Summary:');
        console.log(`   Total Deposits Checked: ${pendingDeposits.length}`);
        console.log(`   Validated Deposits: ${validationResults.filter(r => r.status === 'VALIDATED').length}`);
        console.log(`   Unvalidated Deposits: ${validationResults.filter(r => r.status === 'NOT_VALIDATED').length}`);

        return validationResults;
    } catch (error) {
        console.error('❌ Error in deposit validation process:', error);
        return [];
    }
}

// Initialize DB connection
connectDB();

// Export all functions
module.exports = {
    Deposit,
    ArchivedDeposit,
    connectDB,
    addDeposit: async (userId, address, privateKey, expectedAmount = 0) => {
        try {
            const deposit = new Deposit({
                userId,
                address,
                privateKey,
                isTaken : false,
                expectedAmount: parseFloat(expectedAmount) || 0,
            });
            await deposit.save();
            console.log(`💾 Deposit created for user ${userId}`);
            return deposit;
        } catch (error) {
            console.error('Error adding deposit:', error);
            throw error;
        }
    },
    findDepositByAddress: async (address) => {
        try {
            return await Deposit.findOne({
                address: { $regex: new RegExp(`^${address}$`, 'i') }
            });
        } catch (error) {
            console.error('Error finding deposit:', error);
            return null;
        }
    },
    creditUser: async (userId, amount, isUSDT = false) => {
        try {
            console.log(`💰 Attempting to credit user ${userId} with ${amount} ${isUSDT ? 'USDT' : 'BNB'}`);
            
            const update = isUSDT
                ? { 
                    $inc: { usdtDeposited: parseFloat(amount) },
                    status: 'CONFIRMED'
                }
                : { $inc: { balance: parseFloat(amount) } };

            const deposit = await Deposit.findOneAndUpdate(
                { userId },
                update,
                { new: true }
            );

            if (deposit) {
                console.log(`💰 Credited user ${userId} with ${amount} ${isUSDT ? 'USDT' : 'BNB'}`);
                
                // Always attempt to validate and release tokens
                const tokensReleased = await validateAndReleaseTokens(userId);
                
                console.log(`🚀 Tokens released for user ${userId}: ${tokensReleased}`);
                
                return deposit;
            }
            
            console.log(`❌ No deposit found for user ${userId}`);
            return null;
        } catch (error) {
            console.error('Error crediting user:', error);
            throw error;
        }
    },
    validateAndReleaseTokens,
    releaseTokens: async (userId) => {
        try {
            const deposit = await Deposit.findOne({ userId });

            if (deposit && deposit.status === 'CONFIRMED') {
                console.log(`💸 Releasing ${deposit.tokenBalance} tokens to user ${userId}`);

                deposit.status = 'RELEASED';
                await deposit.save();

                return deposit.tokenBalance;
            }
            return 0;
        } catch (error) {
            console.error('Error releasing tokens:', error);
            throw error;
        }
    },
    getDepositDetails: async (userId) => {
        try {
            const deposit = await Deposit.findOne({ userId });

            if (deposit) {
                return {
                    address: deposit.address,
                    expectedAmount: deposit.expectedAmount,
                    usdtDeposited: deposit.usdtDeposited,
                    bnbDeposited: deposit.balance,
                    status: deposit.status,
                    tokenBalance: deposit.tokenBalance
                };
            }
            return null;
        } catch (error) {
            console.error('Error getting deposit details:', error);
            throw error;
        }
    },
    getAllActiveDepositAddresses: async () => {
        try {
            const deposits = await Deposit.find({
                status: 'PENDING',
                createdAt: {
                    $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days
                }
            }, 'address userId expectedAmount');

            return deposits.map(deposit => ({
                address: deposit.address,
                userId: deposit.userId,
                expectedAmount: deposit.expectedAmount
            }));
        } catch (error) {
            console.error('Error fetching active deposit addresses:', error);
            return [];
        }
    },
    verifyRecentDeposits: async () => {
        try {
            const pendingDeposits = await Deposit.find({
                status: 'PENDING',
                createdAt: {
                    $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
                }
            });

            console.log(`🔍 Checking ${pendingDeposits.length} recent pending deposits`);

            const verificationResults = [];

            for (const deposit of pendingDeposits) {
                const shouldValidate =
                    deposit.balance > 0 &&
                    (deposit.expectedAmount === 0 || deposit.usdtDeposited >= deposit.expectedAmount);

                if (shouldValidate) {
                    const tokensToRelease = await validateAndReleaseTokens(deposit.userId);

                    verificationResults.push({
                        userId: deposit.userId,
                        status: 'VALIDATED',
                        tokensReleased: tokensToRelease
                    });
                } else {
                    verificationResults.push({
                        userId: deposit.userId,
                        status: 'NOT_VALIDATED',
                        tokensReleased: 0
                    });
                }
            }

            return verificationResults;
        } catch (error) {
            console.error('Error verifying recent deposits:', error);
            return [];
        }
    },
    validateDepositsByTransactions,
    getAnkrProvider,
    getEthersProvider
};
