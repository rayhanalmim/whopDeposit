const User = require('../models/User');
const { WhopServerSdk } = require('@whop/api');
require('dotenv').config();

// Initialize Whop SDK
const whopSdk = WhopServerSdk({
  appId: process.env.WHOP_APP_ID,
  appApiKey: process.env.WHOP_API_KEY,
  onBehalfOfUserId: process.env.WHOP_AGENT_USER_ID,
  companyId: process.env.WHOP_COMPANY_ID,
});

/**
 * Synchronize a user with Whop's system
 * @param {Object} user - Mongoose user document
 * @returns {Promise<Object>} Result of the sync operation
 */
async function syncUserWithWhop(user) {
  try {
    console.log(`[${new Date().toISOString()}] Syncing user ${user.email} to Whop`);

    const user = await whopSdk.users.getUser({
        userId: user.email,
    });


    console.log("user form the app : ", user);
    
    // Create a new user in Whop's system
    const whopUser = await whopSdk.users.create({
      email: user.email,
      name: user.name || user.email.split('@')[0],
      metadata: { 
        mongoUserId: user.id,
        googleId: user.googleId,
        syncedBy: "rayhanalmim",
        syncedAt: new Date().toISOString()
      }
    });
    
    console.log(`[${new Date().toISOString()}] Successfully created Whop user: ${whopUser.id}`);
    
    // Update user with Whop ID
    user.whopUserId = whopUser.id;
    await user.save();
    
    return {
      success: true,
      userId: user.id,
      whopUserId: whopUser.id,
      syncedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to sync user with Whop:`, error);
    throw error;
  }
}

/**
 * Get a Whop user by ID or email
 * @param {string} identifier - User ID or email
 * @returns {Promise<Object>} Whop user object
 */
async function getWhopUser(identifier) {
  try {
    // Try to get by ID first
    try {
      const user = await whopSdk.users.get(identifier);
      return user;
    } catch (error) {
      // If not found, try by email
      if (identifier.includes('@')) {
        const users = await whopSdk.users.list({
          filter: { email: identifier }
        });
        if (users && users.length > 0) {
          return users[0];
        }
      }
      throw new Error('User not found in Whop');
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error getting Whop user:`, error);
    throw error;
  }
}

module.exports = {
  syncUserWithWhop,
  getWhopUser,
  whopSdk
};