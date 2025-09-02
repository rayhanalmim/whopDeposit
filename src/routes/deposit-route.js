const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('./auth-rotues');
const { whopSdk } = require('../services/whop-service');
const { createTransaction, processDeposit } = require('../services/transaction-service');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// Create a deposit (simplified version)
// Modified deposit route without isAuthenticated middleware
router.post('/create', async (req, res) => {
    try {
        const { amount, user } = req.body;

        // Validate required fields
        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid amount'
            });
        }

        if (!user || !user.id || !user.email) {
            return res.status(400).json({
                success: false,
                message: 'User data is required'
            });
        }

        // Find or create user in database (if needed)
        let dbUser = await User.findOne({ email: user.email });

        if (!dbUser) {
            // Create new user record if needed
            dbUser = new User({
                email: user.email,
                name: user.name,
                picture: user.picture,
                balance: 0
            });
            await dbUser.save();
        }

        const userId = dbUser._id;

        // Create transaction record in pending state
        const pendingTransaction = await createTransaction({
            userId,
            type: 'deposit',
            amount: parseFloat(amount),
            currency: 'usd',
            status: 'pending',
            createdBy: dbUser.name || dbUser.email,
            notes: 'Deposit initiated via webapp'
        });

        // Use your agent user ID directly
        const agentUserId = process.env.WHOP_AGENT_USER_ID || "user_vkkJspp0eI1SK";

        // Use chargeUser method with direct agent ID
        const result = await whopSdk.payments.chargeUser({
            amount: amount,
            currency: "usd",
            userId: agentUserId,
            metadata: {
                mongoUserId: userId,
                transactionId: pendingTransaction._id.toString(),
                type: "deposit",
                amount: parseFloat(amount),
                createdBy: dbUser.name || "client",
                createdAt: new Date().toISOString()
            },
        });

        if (!result?.inAppPurchase) {
            pendingTransaction.status = 'failed';
            await pendingTransaction.save();

            return res.status(500).json({
                success: false,
                message: 'Failed to create charge'
            });
        }

        console.log('done, make the transaction successful');

        return res.json({
            success: true,
            inAppPurchase: result.inAppPurchase,
            transactionId: pendingTransaction._id
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error creating deposit:`, error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to create deposit'
        });
    }
});



module.exports = router;