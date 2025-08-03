const { ethers } = require("ethers");
const { findDepositByAddress, creditUser } = require("./db");
const { BSC_WS } = require("./config");
const { sweepToTreasury } = require("./sweep");

// Updated syntax for ethers v6+
const provider = new ethers.WebSocketProvider(BSC_WS);

provider.on("pending", async (txHash) => {
    try {
        const tx = await provider.getTransaction(txHash);
        if (!tx || !tx.to) return;

        const deposit = findDepositByAddress(tx.to);
        if (deposit) {
            // Updated syntax for formatEther in v6+
            const amountBNB = ethers.formatEther(tx.value);
            console.log(`📥 Incoming deposit: ${amountBNB} BNB from ${tx.from}`);

            creditUser(deposit.userId, amountBNB);

            // Sweep after confirmation
            provider.once(txHash, async () => {
                console.log(`✅ Confirmed deposit from ${tx.from}`);
                await sweepToTreasury(deposit.privateKey);
            });
        }
    } catch (err) {
        console.error(err);
    }
});