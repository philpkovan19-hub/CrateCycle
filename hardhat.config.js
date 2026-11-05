require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // BOT Chain testnet
    botchain_testnet: {
      url: "https://rpc.bohr.life",
      chainId: 968,
      accounts,
    },
    // BOT Chain mainnet
    botchain: {
      url: "https://rpc.botchain.ai",
      chainId: 677,
      accounts,
    },
  },
};
