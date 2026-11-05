const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();

  // Self-evidencing log: network name AND chain id, so the deploy record
  // never has to be inferred later.
  console.log("Network:  ", hre.network.name);
  console.log("Chain ID: ", net.chainId.toString());
  console.log("Deployer: ", deployer.address);
  console.log("Balance:  ", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "BOT");

  const Factory = await hre.ethers.getContractFactory("CrateCycle");
  const c = await Factory.deploy();
  await c.waitForDeployment();

  const addr = await c.getAddress();
  console.log("");
  console.log("CrateCycle deployed to:", addr);
  console.log("");
  console.log("Next: paste this into CONTRACT_ADDRESS in frontend/index.html");
  if (net.chainId === 677n) {
    console.log("Explorer: https://scan.botchain.ai/address/" + addr);
  } else {
    console.log("Explorer: https://scan.bohr.life/address/" + addr);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
