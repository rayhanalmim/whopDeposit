# Deposit Management API Postman Collection

## Importing the Collection

1. Open Postman
2. Click on "Import" in the top left corner
3. Choose the `postman_collection.json` file
4. Click "Import"

## Environment Variables

The collection uses a base URL variable:
- `base_url`: Set this to your server's base URL (default is `http://localhost:3000`)

## Available Endpoints

### 1. Get Pending Deposits
- **Method**: GET
- **Endpoint**: `/pending-deposits`
- **Description**: Retrieves all pending deposits created in the last 30 days

### 2. Check Deposit Status
- **Method**: GET
- **Endpoint**: `/check-deposit-status`
- **Query Parameters**:
  - `userId`: User's unique identifier
  - `depositAddress`: Wallet address for the deposit
- **Description**: Checks the status of a specific deposit

### 3. Get User Released Deposits
- **Method**: GET
- **Endpoint**: `/user-released-deposits/:userId`
- **Description**: Retrieves all released deposits for a specific user in the last 90 days

### 4. Verify Deposits
- **Method**: POST
- **Endpoint**: `/verify-deposits`
- **Description**: Manually trigger deposit validation process

### 5. Delete Deposit
- **Method**: DELETE
- **Endpoint**: `/api/deposit/:depositId`
- **Request Body**:
  ```json
  {
    "userId": "user123"
  }
  ```
- **Description**: Delete a specific pending deposit

## Notes
- Ensure your server is running before testing the endpoints
- Replace placeholder values (like `user123`) with actual data
- Check server logs for detailed information about each request