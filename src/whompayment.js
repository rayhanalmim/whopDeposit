const express = require('express');
const router = express.Router();
const { whopSdk } = require('./middleware/whomsdk'); // Adjust path as needed

// Create a new deposit charge
router.post('/create-deposit-charge', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    
    if (!userId || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid user ID or amount' 
      });
    }
    
    const amountInCents = Math.round(parseFloat(amount) * 100);
    
    // Option 1: Using metadata to track your user
    const result = await whopSdk.payments.chargeUser({
      amount: amountInCents,
      currency: "usd",
      userId: "business", // Using business account for guest checkout
      metadata: {
        tahweelUserId: userId, // Store your user ID in metadata
        depositAmount: amount
      },
    });
    
    // Option 2: If you've synced users between systems
    /*
    const result = await whopSdk.payments.chargeUser({
      amount: amountInCents,
      currency: "usd",
      userId: userId, // Using the Whop user ID you've stored
      metadata: {
        depositAmount: amount
      },
    });
    */
    
    if (!result?.inAppPurchase) {
      return res.status(500).json({
        success: false,
        message: 'Failed to create charge'
      });
    }
    
    return res.status(200).json({
      success: true,
      inAppPurchase: result.inAppPurchase
    });
    
  } catch (error) {
    console.error('Error creating charge:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create charge'
    });
  }
});

// Webhook to handle successful payments
router.post('/webhook', (req, res) => {
  // Implement webhook handling for payment confirmations
  // This would update your user's balance after payment is confirmed
  
  // 1. Verify webhook signature
  // 2. Process payment confirmation
  // 3. Update user balance
  
  res.status(200).send('Webhook received');
});

module.exports = router;