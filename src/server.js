require('dotenv').config();
const app = require('./index');

const PORT = process.env.PORT || 3000;

// Start the Express server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});

module.exports = server; 