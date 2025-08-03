const ethers = require("ethers");
const { TREASURY_ADDRESS, SWEEP_GAS_LIMIT, SWEEP_GAS_PRICE_GWEI } = require("./config");

// Use HTTP provider for sweep operations
const HTTP_PROVIDERS = [
    "https://bsc-dataseed1.binance.org/",
    "https://bsc-dataseed2.binance.org/",
    "https://bsc-dataseed3.binance.org/"
];

let currentProviderIndex = 0;

function getProvider() {
    const url = HTTP_PROVIDERS[currentProviderIndex];
    return new ethers.JsonRpcProvider(url);
}

async function switchProvider() {
    currentProviderIndex = (currentProviderIndex + 1) % HTTP_PROVIDERS.length;
    console.log(`🔄 Sweep: switching to provider ${currentProviderIndex + 1}`);
}

async function sweepToTreasury(privateKey) {
    let provider = getProvider();
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
            const wallet = new ethers.Wallet(privateKey, provider);
            const balance = await provider.getBalance(wallet.address);

            console.log(`💰 Current balance: ${ethers.formatEther(balance)} BNB`);

            if (balance === 0n) {
                console.log(`⚠️ No balance to sweep in ${wallet.address}`);
                return;
            }

            // Calculate gas cost
            const gasPrice = ethers.parseUnits(SWEEP_GAS_PRICE_GWEI, "gwei");
            const gasLimit = BigInt(SWEEP_GAS_LIMIT);
            const txCost = gasPrice * gasLimit;
            
            console.log(`⛽ Gas cost: ${ethers.formatEther(txCost)} BNB`);

            if (balance <= txCost) {
                console.log(`⚠️ Balance too low to cover gas fees`);
                return;
            }

            const amountToSend = balance - txCost;
            console.log(`💸 Amount to sweep: ${ethers.formatEther(amountToSend)} BNB`);

            const tx = await wallet.sendTransaction({
                to: TREASURY_ADDRESS,
                value: amountToSend,
                gasLimit: gasLimit,
                gasPrice: gasPrice
            });

            console.log(`📤 Sweep transaction sent: ${tx.hash}`);
            
            // Wait for confirmation
            const receipt = await tx.wait();
            console.log(`✅ Sweep confirmed in block ${receipt.blockNumber}`);
            console.log(`🏦 Swept ${ethers.formatEther(amountToSend)} BNB to treasury`);
            
            return receipt;

        } catch (err) {
            attempts++;
            console.error(`❌ Sweep error (attempt ${attempts}/${maxAttempts}):`, err.message);
            
            if (attempts < maxAttempts) {
                await switchProvider();
                provider = getProvider();
                console.log(`🔄 Retrying sweep in 2 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                console.error(`❌ Sweep failed after ${maxAttempts} attempts`);
                throw err;
            }
        }
    }
}

module.exports = { sweepToTreasury };