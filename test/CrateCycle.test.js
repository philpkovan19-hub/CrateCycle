const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const ZERO = ethers.ZeroAddress;

const DAY = 86400;
const WEEK = 7 * DAY;

const AT_DEPOT = 0n;
const OUT = 1n;
const RETURN_PENDING = 2n;
const RETIRED = 3n;
const LOST = 4n;

describe("CrateCycle", function () {
  let cc, owner, op, a, b, c;

  const DEPOSIT = E(2);
  const USAGE = E("0.2");

  beforeEach(async () => {
    [owner, op, a, b, c] = await ethers.getSigners();
    const F = await ethers.getContractFactory("CrateCycle");
    cc = await F.deploy();
    await cc.waitForDeployment();
  });

  async function openFleet(opts = {}) {
    const {
      from = op,
      name = "Returnable produce crates, depot 2",
      deposit = DEPOSIT,
      usage = USAGE,
      window = WEEK,
      maxCycles = 3,
    } = opts;
    await cc.connect(from).openFleet(name, deposit, usage, window, maxCycles);
    return (await cc.fleetCount()) - 1n;
  }

  async function addCrates(fleetId, n, from = op) {
    const before = Number(await cc.crateCount());
    await cc.connect(from).addCrates(fleetId, n);
    return Array.from({ length: n }, (_, i) => before + i);
  }

  /// Every wei held is either a locked deposit, owed to someone, or a fee.
  async function assertSolvent(accounts) {
    const held = await ethers.provider.getBalance(await cc.getAddress());
    let owed = 0n;
    for (const s of accounts) owed += await cc.balanceOf(s.address);
    expect(held).to.equal((await cc.lockedTotal()) + owed + (await cc.accumulatedFees()));
  }

  // -------------------------------------------------------------- fleets

  it("opens a fleet with its deposit, fee and clocks", async () => {
    const id = await openFleet();
    const f = await cc.getFleet(id);
    expect(f.operator).to.equal(op.address);
    expect(f.name).to.equal("Returnable produce crates, depot 2");
    expect(f.deposit).to.equal(DEPOSIT);
    expect(f.usageFee).to.equal(USAGE);
    expect(f.outWindow).to.equal(WEEK);
    expect(f.maxCycles).to.equal(3);
    expect(f.open).to.equal(true);

    const q = await cc.quoteCheckout(id);
    expect(q.total).to.equal(E("2.2"));
    const u = await cc.quoteUsageFee(id);
    expect(u.protocolFee).to.equal(E("0.002")); // 1% of the fee
    expect(u.toOperator).to.equal(E("0.198"));
  });

  it("refuses a fleet with bad terms", async () => {
    await expect(cc.connect(op).openFleet("", DEPOSIT, USAGE, WEEK, 3)).to.be.revertedWith("bad name");
    await expect(cc.connect(op).openFleet("x".repeat(65), DEPOSIT, USAGE, WEEK, 3)).to.be.revertedWith("bad name");
    await expect(cc.connect(op).openFleet("x", 0, 0, WEEK, 3)).to.be.revertedWith("bad deposit");
    await expect(cc.connect(op).openFleet("x", E(101), USAGE, WEEK, 3)).to.be.revertedWith("bad deposit");
    // A fee above the deposit would make losing the crate cheaper than using it.
    await expect(cc.connect(op).openFleet("x", E(1), E(2), WEEK, 3)).to.be.revertedWith("fee above deposit");
    await expect(cc.connect(op).openFleet("x", DEPOSIT, USAGE, 3600, 3)).to.be.revertedWith("bad out window");
    await expect(cc.connect(op).openFleet("x", DEPOSIT, USAGE, 400 * DAY, 3)).to.be.revertedWith("bad out window");
    await expect(cc.connect(op).openFleet("x", DEPOSIT, USAGE, WEEK, 0)).to.be.revertedWith("bad cycle cap");
    await expect(cc.getFleet(0)).to.be.revertedWith("no such fleet");
  });

  it("mints crates into the depot, operator only", async () => {
    const id = await openFleet();
    await expect(cc.connect(a).addCrates(id, 3)).to.be.revertedWith("not operator");
    await expect(cc.connect(op).addCrates(id, 0)).to.be.revertedWith("bad count");
    await expect(cc.connect(op).addCrates(id, 500)).to.be.revertedWith("bad count");

    const ids = await addCrates(id, 3);
    expect(ids).to.deep.equal([0, 1, 2]);
    expect((await cc.getFleet(id)).crateCount).to.equal(3);
    expect(await cc.crateCount()).to.equal(3);
    expect((await cc.getCrate(0)).state).to.equal(AT_DEPOT);
    expect((await cc.getCrate(0)).holder).to.equal(ZERO);
    expect((await cc.getCratesByFleet(id, 0, 10)).map(Number)).to.deep.equal([0, 1, 2]);
    expect((await cc.availableCrates(id, 0, 10)).map(Number)).to.deep.equal([0, 1, 2]);
    await expect(cc.getCrate(9)).to.be.revertedWith("no such crate");
  });

  // --------------------------------------------------------- circulation

  it("takes a crate out, escrowing the deposit and splitting the fee", async () => {
    const id = await openFleet();
    await addCrates(id, 2);

    await expect(cc.connect(a).checkout(0, { value: E(2) })).to.be.revertedWith("send deposit plus fee");
    await expect(cc.connect(op).checkout(0, { value: E("2.2") })).to.be.revertedWith("operator cannot check out");
    await cc.connect(a).checkout(0, { value: E("2.2") });

    const cr = await cc.getCrate(0);
    expect(cr.holder).to.equal(a.address);
    expect(cr.state).to.equal(OUT);
    expect(cr.cycles).to.equal(1);
    expect(cr.hardDueAt - cr.dueAt).to.equal(2n * BigInt(WEEK)); // three windows in all

    expect(await cc.lockedTotal()).to.equal(DEPOSIT); // the fee is not escrow
    expect(await cc.balanceOf(op.address)).to.equal(E("0.198"));
    expect(await cc.accumulatedFees()).to.equal(E("0.002"));
    expect((await cc.getFleet(id)).outCount).to.equal(1);
    expect((await cc.availableCrates(id, 0, 10)).map(Number)).to.deep.equal([1]);
    await assertSolvent([a, b, c, op]);

    await expect(cc.connect(b).checkout(0, { value: E("2.2") })).to.be.revertedWith("not at depot");
  });

  it("will not let a crate out of a closed fleet", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await expect(cc.connect(a).closeFleet(id)).to.be.revertedWith("not operator");
    await cc.connect(op).closeFleet(id);
    await expect(cc.connect(op).closeFleet(id)).to.be.revertedWith("already closed");
    await expect(cc.connect(a).checkout(0, { value: E("2.2") })).to.be.revertedWith("fleet closed");
  });

  it("circulates the deposit on a handoff, keeping exactly one in escrow", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });

    await expect(cc.connect(b).offer(0, b.address)).to.be.revertedWith("not holder");
    await expect(cc.connect(a).offer(0, ZERO)).to.be.revertedWith("bad recipient");
    await expect(cc.connect(a).offer(0, a.address)).to.be.revertedWith("bad recipient");
    await expect(cc.connect(b).takeOver(0, { value: DEPOSIT })).to.be.revertedWith("not offered to you");

    await expect(cc.connect(a).offer(0, b.address)).to.emit(cc, "Offered").withArgs(0, a.address, b.address);
    // An offer names one person, and they pay the deposit to the wei.
    await expect(cc.connect(c).takeOver(0, { value: DEPOSIT })).to.be.revertedWith("not offered to you");
    await expect(cc.connect(b).takeOver(0, { value: E(1) })).to.be.revertedWith("send the exact deposit");
    await expect(cc.connect(b).takeOver(0)).to.be.revertedWith("send the exact deposit");
    expect(await cc.lockedTotal()).to.equal(DEPOSIT); // nothing changed hands
  });

  it("hands a crate on without the deposit ever returning to the depot", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    await cc.connect(a).offer(0, b.address);

    const before = await cc.lockedTotal();
    await expect(cc.connect(b).takeOver(0, { value: DEPOSIT })).to.emit(cc, "TakenOver");

    const cr = await cc.getCrate(0);
    expect(cr.holder).to.equal(b.address);
    expect(cr.offeredTo).to.equal(ZERO);
    expect(cr.cycles).to.equal(1); // a handoff is not a new cycle
    expect(cr.state).to.equal(OUT);

    // One deposit in, one out — escrow is unchanged and a has theirs back.
    expect(await cc.lockedTotal()).to.equal(before);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT);
    expect((await cc.getFleet(id)).outCount).to.equal(1);
    await assertSolvent([a, b, c, op]);

    // The new holder cannot immediately take it over from themselves.
    await expect(cc.connect(b).offer(0, b.address)).to.be.revertedWith("bad recipient");
    await cc.connect(b).offer(0, c.address);
    await cc.connect(b).cancelOffer(0);
    expect((await cc.getCrate(0)).offeredTo).to.equal(ZERO);
    await expect(cc.connect(b).cancelOffer(0)).to.be.revertedWith("no offer");
    await expect(cc.connect(c).takeOver(0, { value: DEPOSIT })).to.be.revertedWith("not offered to you");
  });

  it("gives each holder a fresh window, but never past the crate's hard due date", async () => {
    const id = await openFleet({ window: DAY, maxCycles: 5 });
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    const hard = (await cc.getCrate(0)).hardDueAt; // three days out

    // Two and a half days in, a full fresh day would overshoot the limit.
    await time.increase(2.5 * DAY);
    await cc.connect(a).offer(0, b.address);
    await cc.connect(b).takeOver(0, { value: DEPOSIT });

    const cr = await cc.getCrate(0);
    expect(cr.dueAt).to.equal(hard); // clamped — b inherits only what is left
    expect(cr.hardDueAt).to.equal(hard);

    // Past the limit, nobody new may take it on; it has to come home.
    await time.increase(DAY);
    await expect(cc.connect(b).offer(0, c.address)).to.be.revertedWith("past its circulation limit");
    await cc.connect(b).returnCrate(0);
    await cc.connect(op).acceptReturn(0);
    expect((await cc.getCrate(0)).state).to.equal(AT_DEPOT);
  });

  // ----------------------------------------------------------- returning

  it("returns a crate, releases the deposit and puts it back in service", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });

    await expect(cc.connect(b).returnCrate(0)).to.be.revertedWith("not holder");
    await expect(cc.connect(op).acceptReturn(0)).to.be.revertedWith("no return pending");
    await expect(cc.connect(a).returnCrate(0)).to.emit(cc, "ReturnStarted").withArgs(0, a.address);
    expect((await cc.getCrate(0)).state).to.equal(RETURN_PENDING);

    // While it is pending it is nobody's to pass on, and still not available.
    await expect(cc.connect(a).offer(0, b.address)).to.be.revertedWith("not out");
    expect((await cc.availableCrates(id, 0, 10)).length).to.equal(0);

    await expect(cc.connect(a).acceptReturn(0)).to.be.revertedWith("not operator");
    await expect(cc.connect(op).acceptReturn(0))
      .to.emit(cc, "ReturnAccepted")
      .withArgs(0, a.address, DEPOSIT, false);

    expect((await cc.getCrate(0)).state).to.equal(AT_DEPOT);
    expect((await cc.getCrate(0)).holder).to.equal(ZERO);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT);
    expect(await cc.lockedTotal()).to.equal(0);
    expect((await cc.getFleet(id)).outCount).to.equal(0);
    expect((await cc.availableCrates(id, 0, 10)).map(Number)).to.deep.equal([0]);
    await assertSolvent([a, b, c, op]);

    await expect(cc.connect(a).withdraw()).to.changeEtherBalance(a, DEPOSIT);
    await expect(cc.connect(a).withdraw()).to.be.revertedWith("nothing to withdraw");
  });

  it("retires a crate once it has done its cycles", async () => {
    const id = await openFleet({ maxCycles: 2 });
    await addCrates(id, 1);

    await cc.connect(a).checkout(0, { value: E("2.2") });
    await cc.connect(a).returnCrate(0);
    await cc.connect(op).acceptReturn(0);
    expect((await cc.getCrate(0)).state).to.equal(AT_DEPOT);

    await cc.connect(b).checkout(0, { value: E("2.2") });
    await cc.connect(b).returnCrate(0);
    await expect(cc.connect(op).acceptReturn(0))
      .to.emit(cc, "ReturnAccepted")
      .withArgs(0, b.address, DEPOSIT, true);

    expect((await cc.getCrate(0)).state).to.equal(RETIRED);
    expect((await cc.getCrate(0)).cycles).to.equal(2);
    await expect(cc.connect(c).checkout(0, { value: E("2.2") })).to.be.revertedWith("not at depot");
    expect((await cc.availableCrates(id, 0, 10)).length).to.equal(0);
    await assertSolvent([a, b, c, op]);
  });

  it("lets a holder force a return the operator will not accept", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    await cc.connect(a).returnCrate(0);

    expect(await cc.returnForceable(0)).to.equal(false);
    await expect(cc.connect(a).forceReturn(0)).to.be.revertedWith("too early");
    await time.increase(WEEK + 1);
    expect(await cc.returnForceable(0)).to.equal(true);
    await expect(cc.connect(b).forceReturn(0)).to.be.revertedWith("not holder");

    await expect(cc.connect(a).forceReturn(0)).to.emit(cc, "ReturnForced").withArgs(0, a.address, DEPOSIT);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT);
    expect(await cc.lockedTotal()).to.equal(0);
    expect((await cc.getCrate(0)).state).to.equal(AT_DEPOT);
    await assertSolvent([a, b, c, op]);
  });

  it("does not quietly put a worn-out crate back in service after a forced return", async () => {
    const id = await openFleet({ maxCycles: 1 });
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    await cc.connect(a).returnCrate(0);
    await time.increase(WEEK + 1);
    await cc.connect(a).forceReturn(0);

    // Back at the depot, but it has used its cycle and the cap still binds.
    expect((await cc.getCrate(0)).state).to.equal(AT_DEPOT);
    await expect(cc.connect(b).checkout(0, { value: E("2.2") })).to.be.revertedWith("crate worn out");
    expect((await cc.availableCrates(id, 0, 10)).length).to.equal(0);
  });

  it("refunds the holder in full on a write-off, because damage is not on-chain", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    await expect(cc.connect(op).writeOff(0)).to.be.revertedWith("no return pending");
    await cc.connect(a).returnCrate(0);
    await expect(cc.connect(a).writeOff(0)).to.be.revertedWith("not operator");

    await expect(cc.connect(op).writeOff(0)).to.emit(cc, "WrittenOff").withArgs(0, a.address, DEPOSIT);
    expect((await cc.getCrate(0)).state).to.equal(RETIRED);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT); // whole, not shaved
    expect(await cc.balanceOf(op.address)).to.equal(E("0.198")); // the usage fee, and only that
    expect(await cc.lockedTotal()).to.equal(0);
    await assertSolvent([a, b, c, op]);
  });

  it("forfeits the deposit on a crate that never came back", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });

    expect(await cc.isOverdue(0)).to.equal(false);
    await expect(cc.connect(op).declareLost(0)).to.be.revertedWith("not overdue");
    await time.increase(WEEK + 1);
    expect(await cc.isOverdue(0)).to.equal(true);
    await expect(cc.connect(b).declareLost(0)).to.be.revertedWith("not operator");

    await expect(cc.connect(op).declareLost(0)).to.emit(cc, "DeclaredLost").withArgs(0, a.address, DEPOSIT);
    expect((await cc.getCrate(0)).state).to.equal(LOST);
    expect(await cc.balanceOf(a.address)).to.equal(0);
    expect(await cc.balanceOf(op.address)).to.equal(E("2.198")); // fee plus the forfeited deposit
    expect(await cc.lockedTotal()).to.equal(0);
    expect((await cc.getFleet(id)).outCount).to.equal(0);
    await expect(cc.connect(a).returnCrate(0)).to.be.revertedWith("not holder");
    await assertSolvent([a, b, c, op]);
  });

  it("lets an overdue crate be rescued by a handoff before it is written off", async () => {
    const id = await openFleet({ window: DAY, maxCycles: 5 });
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    await time.increase(DAY + 1);

    // Overdue, so the operator could declare it lost — but passing it on puts
    // it back in circulation and gives the next holder a clean window.
    expect(await cc.isOverdue(0)).to.equal(true);
    await cc.connect(a).offer(0, b.address);
    await cc.connect(b).takeOver(0, { value: DEPOSIT });

    expect(await cc.isOverdue(0)).to.equal(false);
    await expect(cc.connect(op).declareLost(0)).to.be.revertedWith("not overdue");
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT); // a is out clean
    const left = await cc.timeLeft(0);
    expect(left.holderWindow).to.be.greaterThan(0);
    expect(left.circulation).to.be.greaterThan(0);
    await assertSolvent([a, b, c, op]);
  });

  // ---------------------------------------------------------------- views

  it("reports clocks as zero for a crate that is not out", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    let left = await cc.timeLeft(0);
    expect(left.holderWindow).to.equal(0);
    expect(left.circulation).to.equal(0);
    expect(await cc.isOverdue(0)).to.equal(false);
    expect(await cc.returnForceable(0)).to.equal(false);

    await cc.connect(a).checkout(0, { value: E("2.2") });
    left = await cc.timeLeft(0);
    expect(left.holderWindow).to.be.greaterThan(0);
    expect(left.circulation).to.be.greaterThan(left.holderWindow);
  });

  it("pages crates and shows only what can actually go out", async () => {
    const id = await openFleet();
    await addCrates(id, 4);
    await cc.connect(a).checkout(1, { value: E("2.2") });

    expect((await cc.availableCrates(id, 0, 10)).map(Number)).to.deep.equal([0, 2, 3]);
    expect((await cc.availableCrates(id, 2, 10)).map(Number)).to.deep.equal([2, 3]);
    expect((await cc.availableCrates(id, 9, 10)).length).to.equal(0);
    expect((await cc.getCratesByFleet(id, 1, 2)).map(Number)).to.deep.equal([1, 2]);
    expect((await cc.getCratesByFleet(id, 0, 500)).map(Number)).to.deep.equal([0, 1, 2, 3]); // limit clamps
    expect((await cc.getCratesByFleet(id, 9, 2)).length).to.equal(0);
  });

  it("indexes fleets by operator and newest-first for the board", async () => {
    await openFleet();
    await openFleet({ name: "Pallet pool, north yard" });
    await openFleet({ from: a, name: "Keg rotation" });

    expect((await cc.getFleetsByOperator(op.address)).map(Number)).to.deep.equal([0, 1]);
    expect((await cc.getFleetsByOperator(a.address)).map(Number)).to.deep.equal([2]);
    expect((await cc.getRecent(2)).map(Number)).to.deep.equal([2, 1]);
    expect((await cc.getRecent(99)).map(Number)).to.deep.equal([2, 1, 0]);
    expect(await cc.fleetCount()).to.equal(3);
  });

  // ---------------------------------------------------------------- admin

  it("runs a fleet with no usage fee at all", async () => {
    const id = await openFleet({ usage: 0 });
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: DEPOSIT });

    expect(await cc.accumulatedFees()).to.equal(0);
    expect(await cc.balanceOf(op.address)).to.equal(0);
    expect(await cc.lockedTotal()).to.equal(DEPOSIT);
    await cc.connect(a).returnCrate(0);
    await cc.connect(op).acceptReturn(0);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT);
    await assertSolvent([a, b, c, op]);
  });

  it("takes its cut of the usage fee only, never of a deposit", async () => {
    await expect(cc.connect(a).setProtocolFeeBps(100)).to.be.revertedWithCustomError(
      cc,
      "OwnableUnauthorizedAccount"
    );
    await expect(cc.connect(owner).setProtocolFeeBps(600)).to.be.revertedWith("fee too high");
    await cc.connect(owner).setProtocolFeeBps(500);

    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });

    expect(await cc.accumulatedFees()).to.equal(E("0.01")); // 5% of 0.2, and nothing more
    expect(await cc.balanceOf(op.address)).to.equal(E("0.19"));
    await cc.connect(a).returnCrate(0);
    await cc.connect(op).acceptReturn(0);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT); // deposit back whole

    await expect(cc.connect(owner).withdrawFees(owner.address)).to.changeEtherBalance(owner, E("0.01"));
    await expect(cc.connect(owner).withdrawFees(owner.address)).to.be.revertedWith("nothing to withdraw");
    await expect(cc.connect(owner).withdrawFees(ZERO)).to.be.revertedWith("bad recipient");
    await assertSolvent([a, b, c, op]);
  });

  it("pauses checkouts and handoffs but never a return or a withdrawal", async () => {
    const id = await openFleet();
    await addCrates(id, 2);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    await cc.connect(a).offer(0, b.address);
    await cc.connect(owner).pause();

    await expect(cc.connect(b).checkout(1, { value: E("2.2") })).to.be.revertedWithCustomError(cc, "EnforcedPause");
    await expect(cc.connect(b).takeOver(0, { value: DEPOSIT })).to.be.revertedWithCustomError(cc, "EnforcedPause");
    await expect(cc.connect(op).addCrates(id, 1)).to.be.revertedWithCustomError(cc, "EnforcedPause");
    await expect(openFleet()).to.be.revertedWithCustomError(cc, "EnforcedPause");

    // Getting a crate back and getting paid out never stops.
    await cc.connect(a).returnCrate(0);
    await cc.connect(op).acceptReturn(0);
    await expect(cc.connect(a).withdraw()).to.changeEtherBalance(a, DEPOSIT);

    await cc.connect(owner).unpause();
    await cc.connect(b).checkout(1, { value: E("2.2") });
  });

  it("keeps a stray transfer out of the deposits and in the fee pot", async () => {
    const id = await openFleet();
    await addCrates(id, 1);
    await cc.connect(a).checkout(0, { value: E("2.2") });
    await owner.sendTransaction({ to: await cc.getAddress(), value: E(5) });

    expect(await cc.accumulatedFees()).to.equal(E("5.002"));
    expect(await cc.lockedTotal()).to.equal(DEPOSIT);
    await assertSolvent([a, b, c, op]);

    // The deposit is still there to be returned, untouched by the stray send.
    await cc.connect(a).returnCrate(0);
    await cc.connect(op).acceptReturn(0);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT);
    expect(await cc.lockedTotal()).to.equal(0);
  });

  it("stays solvent across a crate that circulates through three hands and comes home", async () => {
    const id = await openFleet({ maxCycles: 4 });
    await addCrates(id, 2);

    await cc.connect(a).checkout(0, { value: E("2.2") });
    await cc.connect(a).offer(0, b.address);
    await cc.connect(b).takeOver(0, { value: DEPOSIT });
    await cc.connect(b).offer(0, c.address);
    await cc.connect(c).takeOver(0, { value: DEPOSIT });

    // Three holders in, and escrow has still only ever held one deposit.
    expect(await cc.lockedTotal()).to.equal(DEPOSIT);
    expect((await cc.getCrate(0)).cycles).to.equal(1);
    expect(await cc.balanceOf(a.address)).to.equal(DEPOSIT);
    expect(await cc.balanceOf(b.address)).to.equal(DEPOSIT);

    await cc.connect(c).returnCrate(0);
    await cc.connect(op).acceptReturn(0);

    // A second crate lost on the same fleet, to mix the two outcomes.
    await cc.connect(b).checkout(1, { value: E("2.2") });
    await time.increase(WEEK + 1);
    await cc.connect(op).declareLost(1);

    expect(await cc.lockedTotal()).to.equal(0);
    expect(await cc.balanceOf(c.address)).to.equal(DEPOSIT);
    expect(await cc.balanceOf(op.address)).to.equal(E("2.396")); // two fees of 0.198, plus 2 forfeited
    expect(await cc.accumulatedFees()).to.equal(E("0.004"));
    await assertSolvent([a, b, c, op]);

    // And every credit is actually payable.
    for (const s of [a, b, c, op]) await cc.connect(s).withdraw();
    await cc.connect(owner).withdrawFees(owner.address);
    expect(await ethers.provider.getBalance(await cc.getAddress())).to.equal(0);
  });
});
