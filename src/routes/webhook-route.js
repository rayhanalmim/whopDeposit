const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const { processDeposit } = require('../services/transaction-service');

router.post('/whop', async (req, res) => {
  try {
    const signature = req.headers['x-whop-signature'];
    const payload = JSON.stringify(req.body);
    const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || "";
    
    // Verify the webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', WHOP_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');
    
    if (signature !== expectedSignature) {
      console.error(`[${new Date().toISOString()}] Invalid webhook signature`);
      return res.status(401).send('Invalid signature');
    }
    
    // Process the webhook event
    const event = req.body;
    console.log(`[${new Date().toISOString()}] Received webhook event: ${event.type}`);
    
    if (event.type === 'checkout.completed') {
      // Extract relevant information
      const { metadata, amount, currency } = event.data;
      
      // Check if this is a deposit
      if (metadata && metadata.type === 'deposit') {
        // Extract user ID from metadata
        const mongoUserId = metadata.mongoUserId;
        
        if (!mongoUserId) {
          console.error(`[${new Date().toISOString()}] Missing user ID in webhook metadata`);
          return res.status(400).send('Missing user ID in metadata');
        }
        
        const depositAmount = amount / 100; // Convert cents to dollars
        
        console.log(`[${new Date().toISOString()}] Processing webhook deposit of ${depositAmount} ${currency} for user ${mongoUserId}`);
        
        // Find the user
        const user = await User.findById(mongoUserId);
        
        if (!user) {
          console.error(`[${new Date().toISOString()}] User not found: ${mongoUserId}`);
          return res.status(404).send('User not found');
        }
        
        // Process the deposit
        await processDeposit(
          mongoUserId,
          event.data.id, // Receipt ID
          depositAmount,
          {
            eventId: event.id,
            eventType: event.type,
            confirmedVia: 'webhook',
            originalMetadata: metadata,
            transactionId: metadata.transactionId
          }
        );
      }
    }
    
    // Acknowledge receipt of the webhook
    res.status(200).send('Webhook processed successfully');
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Webhook error:`, error);
    res.status(500).send('Webhook processing failed');
  }
});

module.exports = router;