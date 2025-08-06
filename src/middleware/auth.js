// API Key middleware for MongoDB server
const apiKeyAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized: Invalid API key'
        });
    }
    
    // If key is valid, proceed to the next middleware/route handler
    next();
};

module.exports = { apiKeyAuth };