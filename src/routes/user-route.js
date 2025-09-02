const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { isAuthenticated } = require('./auth-rotues');
const { syncUserWithWhop } = require('../services/whop-service');

// Get user profile
router.get('/profile', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        balance: user.balance,
        whopSynced: !!user.whopUserId
      }
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching profile:`, error);
    res.status(500).json({ success: false, message: 'Failed to fetch user profile' });
  }
});

// Get user transactions
router.get('/transactions', isAuthenticated, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(20);
      
    res.json({ success: true, transactions });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching transactions:`, error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

// Manually sync user with Whop
router.post('/sync-with-whop', isAuthenticated, async (req, res) => {
  try {
    if (req.user.whopUserId) {
      return res.json({ success: true, message: 'User already synced with Whop', whopUserId: req.user.whopUserId });
    }
    
    const result = await syncUserWithWhop(req.user);
    res.json({ success: true, whopUserId: result.whopUserId });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error syncing with Whop:`, error);
    res.status(500).json({ success: false, message: 'Failed to sync user with Whop' });
  }
});

module.exports = router;