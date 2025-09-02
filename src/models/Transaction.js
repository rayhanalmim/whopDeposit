const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['deposit', 'withdrawal', 'transfer']
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'usd'
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  receiptId: String,
  whopMetadata: mongoose.Schema.Types.Mixed,
  createdBy: String,
  updatedBy: String,
  notes: String
}, { timestamps: true });

module.exports = mongoose.model('Transaction', TransactionSchema);