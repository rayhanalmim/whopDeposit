const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  name: {
    type: String,
    trim: true
  },
  googleId: {
    type: String,
    unique: true,
    sparse: true
  },
  whopUserId: {
    type: String,
    unique: true,
    sparse: true
  },
  picture: String,
  balance: {
    type: Number,
    default: 0
  },
  deposits: [{
    amount: Number,
    currency: String,
    receiptId: String,
    timestamp: Date,
    status: String
  }],
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: Date
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);