
// Enhanced debug endpoint for Ankr provider
app.get("/debug-balance/:address", async (req, res) => {
    try {
        const { address } = req.params;

        if (!address) {
            return res.status(400).json({
                success: false,
                message: "Address is required"
            });
        }

        const provider = getAnkrProvider();

        // Fetch account balances
        const accountBalances = await provider.getAccountBalance({
            blockchain: ['bsc'],
            walletAddress: address,
            onlyWhitelisted: false
        });

        // Process balances for easier reading
        const processedBalances = {
            totalBalanceUsd: accountBalances.totalBalanceUsd,
            assets: accountBalances.assets?.map(asset => ({
                blockchain: asset.blockchain,
                tokenName: asset.tokenName,
                tokenSymbol: asset.tokenSymbol,
                tokenType: asset.tokenType,
                contractAddress: asset.contractAddress,
                balance: ethers.formatUnits(asset.balanceRawInteger, asset.tokenDecimals),
                balanceRawInteger: asset.balanceRawInteger,
                balanceUsd: asset.balanceUsd
            })) || []
        };

        res.json({
            success: true,
            message: "Account balances retrieved",
            rawData: accountBalances,
            processedBalances: processedBalances
        });
    } catch (error) {
        console.error('Error in debug balance endpoint:', error);
        res.status(500).json({
            success: false,
            message: "Error retrieving account balances",
            error: error.message
        });
    }
});
// Endpoint to release tokens
app.post("/release-tokens", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "Missing userId" });

        const tokensReleased = await releaseTokens(userId);

        if (tokensReleased > 0) {
            res.json({
                success: true,
                message: `Released ${tokensReleased} tokens for user ${userId}`
            });
        } else {
            res.status(400).json({
                success: false,
                message: "No tokens available for release or deposit not confirmed"
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error releasing tokens",
            error: error.message
        });
    }
});

// Manual credit endpoint for testing
app.post("/manual-credit", async (req, res) => {
    try {
        const { userId, bnbAmount, usdtAmount } = req.body;

        if (!userId) {
            return res.status(400).json({ error: "Missing userId" });
        }

        // Find the deposit
        const deposit = await Deposit.findOne({ userId });

        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: "No deposit found for this user"
            });
        }

        // Manually update balances for testing
        if (bnbAmount !== undefined) {
            deposit.balance = parseFloat(bnbAmount);
        }

        if (usdtAmount !== undefined) {
            deposit.usdtDeposited = parseFloat(usdtAmount);
        }

        await deposit.save();

        // Trigger validation
        const tokensToRelease = await validateAndReleaseTokens(userId);

        res.json({
            success: true,
            message: "Manually credited deposit",
            details: {
                bnbBalance: deposit.balance,
                usdtDeposited: deposit.usdtDeposited,
                tokensToRelease
            }
        });
    } catch (error) {
        console.error('Error in manual credit:', error);
        res.status(500).json({
            success: false,
            message: "Error in manual credit",
            error: error.message
        });
    }
});
// Function to fetch wallet balance using Moralis with error handling
async function fetchWalletBalance(address) {
    try {
        // Fetch native balance
        const nativeBalanceResponse = await Moralis.EvmApi.balance.getNativeBalance({
            address,
            chain: EvmChain.BSC
        });

        // Fetch USDT token balance
        const usdtBalanceResponse = await Moralis.EvmApi.token.getTokenBalance({
            address,
            tokenAddresses: [USDT_CONTRACT_ADDRESS],
            chain: EvmChain.BSC
        });

        return {
            nativeBalance: nativeBalanceResponse.result.balance.toString(),
            usdtBalance: usdtBalanceResponse.result.length > 0
                ? usdtBalanceResponse.result[0].balance.toString()
                : '0'
        };
    } catch (error) {
        console.error(`Error fetching balances for ${address}:`, error);
        return {
            nativeBalance: '0',
            usdtBalance: '0'
        };
    }
}

// Function to fetch token transfers using Moralis
async function fetchTokenTransfers(address) {
    try {
        // Fetch ERC20 transfers
        const transfersResponse = await Moralis.EvmApi.token.getTokenTransfers({
            address,
            contractAddresses: [USDT_CONTRACT_ADDRESS],
            chain: EvmChain.BSC
        });

        return transfersResponse.result;
    } catch (error) {
        console.error(`Error fetching transfers for ${address}:`, error);
        return [];
    }
}
// Endpoint to check deposit details
app.get("/deposit-details/:userId", async (req, res) => {
    try {
        const { userId } = req.params;

        const details = await getDepositDetails(userId);

        if (details) {
            res.json({
                success: true,
                details: details
            });
        } else {
            res.status(404).json({
                success: false,
                message: "No deposit found for this user"
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error retrieving deposit details",
            error: error.message
        });
    }
});

// Detailed deposit information endpoint
app.get("/deposit-details-full/:userId", async (req, res) => {
    try {
        const { userId } = req.params;

        // Find the deposit
        const deposit = await Deposit.findOne({ userId });

        if (!deposit) {
            return res.status(404).json({
                success: false,
                message: "No deposit found for this user"
            });
        }

        // Prepare detailed information
        const details = {
            userId: deposit.userId,
            address: deposit.address,
            status: deposit.status,
            expectedAmount: deposit.expectedAmount,
            bnbBalance: deposit.balance,
            usdtDeposited: deposit.usdtDeposited,
            tokenBalance: deposit.tokenBalance,
            createdAt: deposit.createdAt,
            validationCriteria: {
                bnbBalanceRequired: deposit.balance > 0,
                usdtDepositRequired: deposit.expectedAmount === 0 || deposit.usdtDeposited >= deposit.expectedAmount
            }
        };

        res.json({
            success: true,
            details
        });
    } catch (error) {
        console.error('Error retrieving deposit details:', error);
        res.status(500).json({
            success: false,
            message: "Error retrieving deposit details",
            error: error.message
        });
    }
});

// Endpoint to manually credit USDT
app.post("/credit-usdt", async (req, res) => {
    try {
        const { userId, amount } = req.body;

        if (!userId || !amount) {
            return res.status(400).json({ error: "Missing userId or amount" });
        }

        const deposit = await creditUser(userId, amount, true);

        if (deposit) {
            res.json({
                success: true,
                message: `Credited ${amount} USDT to user ${userId}`,
                details: deposit
            });
        } else {
            res.status(404).json({
                success: false,
                message: "User deposit not found"
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Error crediting USDT",
            error: error.message
        });
    }
});

// New endpoint for deposit validation
app.post("/verify-deposits", async (req, res) => {
    try {
        console.log('🔍 Verify Deposits Endpoint Hit');
        const validationResults = await validateDepositsByTransactions();

        console.log('\n📊 Validation Results:');
        validationResults.forEach(result => {
            console.log(`User ${result.userId}:`);
            console.log(`   Status: ${result.status}`);
            console.log(`   BNB Balance: ${result.bnbBalance || 'N/A'}`);
            console.log(`   USDT Received: ${result.usdtReceived || 'N/A'}`);
            console.log(`   Tokens Released: ${result.tokensReleased || 0}`);
        });

        res.json({
            success: true,
            message: `Validated ${validationResults.length} deposits`,
            details: validationResults,
            summary: {
                total: validationResults.length,
                validated: validationResults.filter(r => r.status === 'VALIDATED').length,
                notValidated: validationResults.filter(r => r.status === 'NOT_VALIDATED').length,
                errors: validationResults.filter(r => r.status === 'ERROR').length
            }
        });
    } catch (error) {
        console.error('❌ Error in verify-deposits endpoint:', error);
        res.status(500).json({
            success: false,
            message: "Error verifying deposits",
            error: error.message
        });
    }
});