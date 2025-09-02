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
 * Create a Whop user record for your application user
 * @param {Object} user - Your application user object
 * @param {string} user.id - Your user's ID in your system
 * @param {string} user.email - User's email address
 * @returns {Promise<string>} - The Whop user ID
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
            metadata: {
                tahweelUserId: user.id,
                syncedBy: "rayhanalmimgo",
                syncedAt: new Date().toISOString()
            }
        });


        console.log(`[${new Date().toISOString()}] Successfully created Whop user: ${whopUser.id}`);

        // Return the Whop user ID
        return whopUser.id;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to sync user with Whop:`, error);
        throw error;
    }
}

/**
 * Update your database with the Whop user ID
 * @param {string} yourUserId - Your user ID
 * @param {string} whopUserId - The Whop user ID to store
 */
async function updateUserInDatabase(yourUserId, whopUserId) {
    try {
        // Example using MongoDB
        // Replace this with your actual database code
        /*
        await db.collection('users').updateOne(
          { _id: yourUserId },
          { $set: { whopUserId, whopSyncedAt: new Date() } }
        );
        */

        console.log(`[${new Date().toISOString()}] Updated user ${yourUserId} with Whop ID ${whopUserId}`);
        return true;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to update user in database:`, error);
        throw error;
    }
}

/**
 * Complete process to sync a user
 * @param {Object} user - Your user object
 */
async function completeUserSync(user) {
    try {
        // 1. Create Whop user
        const whopUserId = await syncUserWithWhop(user);

        // 2. Store the Whop user ID in your database
        await updateUserInDatabase(user.id, whopUserId);

        return {
            success: true,
            userId: user.id,
            whopUserId: whopUserId,
            syncedAt: new Date().toISOString()
        };
    } catch (error) {
        return {
            success: false,
            userId: user.id,
            error: error.message
        };
    }
}

module.exports = {
    syncUserWithWhop,
    updateUserInDatabase,
    completeUserSync
};