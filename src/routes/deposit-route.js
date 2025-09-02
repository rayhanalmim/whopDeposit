const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('./auth-rotues');
const { whopSdk } = require('../services/whop-service');
const { createTransaction, processDeposit } = require('../services/transaction-service');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// Create a deposit (simplified version)
router.post('/create', isAuthenticated, async (req, res) => {
    try {
      const { amount } = req.body;
      const userId = req.user.id;
      
      if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid amount' 
        });
      }

      const currentuser = await whopSdk.users.getCurrentUser();
      
      // Log the transaction attempt
      console.log(`Creating charge for user`, currentuser);
      
      // Create transaction record in pending state
      const pendingTransaction = await createTransaction({
        userId,
        type: 'deposit',
        amount: parseFloat(amount),
        currency: 'usd',
        status: 'pending',
        createdBy: req.user.name || req.user.email,
        notes: 'Deposit initiated via webapp'
      });
      
      // Use your agent user ID directly
      const agentUserId = process.env.WHOP_AGENT_USER_ID || "user_vkkJspp0eI1SK";
      
      // Use chargeUser method with direct agent ID
      const result = await whopSdk.payments.chargeUser({
        amount: amount, // Convert to cents
        currency: "usd",
        userId: agentUserId, // Direct use of agent ID
        metadata: {
          mongoUserId: userId,
          transactionId: pendingTransaction._id.toString(),
          type: "deposit",
          amount: parseFloat(amount),
          createdBy: "rayhanalmim",
          createdAt: new Date().toISOString()
        },
      });
      
      if (!result?.inAppPurchase) {
        // Update transaction to failed
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

// Confirm a deposit
router.post('/confirm', isAuthenticated, async (req, res) => {
  try {
    const { receiptId, amount, transactionId } = req.body;
    const userId = req.user.id;
    
    // Process the deposit
    const result = await processDeposit(userId, receiptId, parseFloat(amount), {
      receiptId,
      confirmedVia: 'client',
      confirmationTime: new Date().toISOString(),
      transactionId
    });
    
    // Update the specific transaction if provided
    if (transactionId) {
      const transaction = await Transaction.findById(transactionId);
      if (transaction) {
        transaction.status = 'completed';
        transaction.receiptId = receiptId;
        transaction.updatedBy = req.user.name || req.user.email;
        await transaction.save();
      }
    }
    
    return res.json({
      success: true,
      message: 'Deposit confirmed and balance updated',
      newBalance: result.user.balance
    });
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error confirming deposit:`, error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to confirm deposit'
    });
  }
});

module.exports = router;