const express = require('express');
const router = express.Router();
const passport = require('passport');
const { syncUserWithWhop } = require('../services/whop-service');

// Auth middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ success: false, message: 'Authentication required' });
};

// Google OAuth login route
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

// Google OAuth callback
router.get('/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  async (req, res) => {
    try {
      res.redirect('http://localhost:3000');
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error in OAuth callback:`, error, res);
      res.redirect('http://localhost:3000');
    }
  }
);

// Check if user is authenticated
router.get('/status', (req, res) => {
  if (req.isAuthenticated()) {
    return res.json({ 
      authenticated: true, 
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        picture: req.user.picture,
        balance: req.user.balance
      }
    });
  }
  res.json({ authenticated: false });
});

// Logout route
router.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] Logout error:`, err);
      return res.status(500).json({ success: false, message: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

module.exports = { router, isAuthenticated };