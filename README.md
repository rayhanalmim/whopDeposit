# BNB Deposit Tracker

## Overview
A robust deposit tracking system for cryptocurrency deposits, supporting BNB and USDT on the Binance Smart Chain (BSC).

## Features
- Generate unique deposit addresses
- Track BNB and USDT deposits
- Automatic token conversion
- Token release mechanism

## Prerequisites
- Node.js (v14+ recommended)
- MongoDB Atlas account
- Binance Smart Chain RPC endpoints

## Installation

1. Clone the repository
```bash
git clone https://github.com/yourusername/bnb-deposit-tracker.git
cd bnb-deposit-tracker
```

2. Install dependencies
```bash
npm install
```

3. Create a `.env` file in the root directory
```
MONGODB_URI=your_mongodb_connection_string
PORT=3000
```

## API Endpoints

### Generate Deposit Address
`POST /generate-deposit`
- Request Body:
  ```json
  {
    "userId": "unique_user_id",
    "expectedAmount": 100 // Optional expected USDT amount
  }
  ```

### Check Deposit Details
`GET /deposit-details/:userId`

### Credit USDT (Testing)
`POST /credit-usdt`
- Request Body:
  ```json
  {
    "userId": "unique_user_id",
    "amount": 50
  }
  ```

### Release Tokens
`POST /release-tokens`
- Request Body:
  ```json
  {
    "userId": "unique_user_id"
  }
  ```

## Configuration

### Environment Variables
- `MONGODB_URI`: MongoDB connection string
- `PORT`: Server port (default: 3000)

## Running the Application

### Development
```bash
npm start
```

### Production
```bash
NODE_ENV=production npm start
```

## Deposit Flow
1. Generate deposit address
2. User sends BNB and USDT to address
3. System tracks deposits
4. When both deposits meet requirements, tokens are prepared
5. User can release tokens

## Security Considerations
- Use strong MongoDB credentials
- Implement additional authentication
- Rotate RPC endpoints
- Add rate limiting

## Monitoring
- Check console logs for transaction details
- Monitor MongoDB for deposit statuses

## Contributing
1. Fork the repository
2. Create your feature branch
3. Commit changes
4. Push to the branch
5. Create a Pull Request

## License
MIT License 