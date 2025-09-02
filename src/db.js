const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`[${new Date().toISOString()}] MongoDB connected`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] MongoDB connection error:`, error);
    process.exit(1);
  }
};

module.exports = connectDB;