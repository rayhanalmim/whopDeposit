const Transaction = require('../models/Transaction');
const User = require('../models/User');

/**
 * Create a new transaction
 * @param {Object} transactionData - Transaction details
 * @returns {Promise<Object>} Created transaction
 */
async function createTransaction(transactionData) {
  try {
    const transaction = new Transaction({
      ...transactionData,
      createdAt: new Date()
    });
    
    await transaction.save();
    return transaction;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error creating transaction:`, error);
    throw error;
  }
}

/**
 * Update user balance based on transaction
 * @param {string} userId - User ID
 * @param {number} amount - Amount to adjust balance by
 * @returns {Promise<Object>} Updated user
 */
async function updateUserBalance(userId, amount) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    
    // Add the amount to user's balance
    user.balance = (user.balance || 0) + amount;
    
    // Save the updated user
    await user.save();
    
    return user;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error updating user balance:`, error);
    throw error;
  }
}

/**
 * Process a completed deposit
 * @param {string} userId - User ID
 * @param {string} receiptId - Receipt ID
 * @param {number} amount - Deposit amount
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<Object>} Updated user and transaction
 */
async function processDeposit(userId, receiptId, amount, metadata = {}) {
  try {
    // Create transaction record
    const transaction = await createTransaction({
      userId,
      type: 'deposit',
      amount,
      currency: 'usd',
      status: 'completed',
      receiptId,
      whopMetadata: metadata,
      createdBy: 'whop-system',
      notes: 'Deposit via Whop'
    });
    
    // Update user balance
    const user = await updateUserBalance(userId, amount);
    
    return { user, transaction };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error processing deposit:`, error);
    throw error;
  }
}

module.exports = {
  createTransaction,
  updateUserBalance,
  processDeposit
};