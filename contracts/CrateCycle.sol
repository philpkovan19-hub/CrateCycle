// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CrateCycle
 * @notice Deposit-return circulation on BOT Chain, for things meant to come back.
 *
 * An operator runs a fleet of reusable containers. Taking one out escrows a
 * deposit and pays a usage fee; bringing it back returns the deposit whole.
 *
 * The part that makes this more than a rental ledger is what happens in
 * between. A container does not have to come home before it can go out again.
 * The holder offers it on, the next person takes it over and pays the deposit,
 * and the previous holder's deposit is released in the same transaction. The
 * deposit rides with the crate instead of bouncing back to the depot, so escrow
 * holds exactly one deposit per crate in circulation, no matter how many hands
 * it passes through.
 *
 * Two clocks keep that from becoming a way to never return anything:
 *
 *  - Each holder gets a fresh `outWindow` to pass it on or bring it back.
 *  - Each crate gets a `hardDueAt` at checkout — `CIRCULATION_LIMIT` windows,
 *    and no handoff may push past it. The crate must come home eventually,
 *    however many people it visits.
 *
 * Miss your window and the operator can declare the crate lost and keep the
 * deposit. That is the only way a deposit is ever forfeited: a write-off for
 * damage refunds the holder in full, because a contract cannot inspect a crate
 * and should not pretend to. Wear is what the usage fee is for.
 */
contract CrateCycle is Ownable, Pausable, ReentrancyGuard {
    enum CrateState {
        AtDepot,
        Out,
        ReturnPending,
        Retired,
        Lost
    }

    struct Fleet {
        address operator;
        uint256 deposit;
        uint256 usageFee;
        uint64 outWindow;
        uint32 maxCycles;
        uint32 crateCount;
        uint32 outCount;
        bool open;
        string name;
    }

    struct Crate {
        uint32 fleetId;
        address holder;
        address offeredTo;
        uint32 cycles;
        uint64 dueAt;
        uint64 hardDueAt;
        CrateState state;
    }

    /// @notice How many holder windows a single trip out may span, at most.
    uint64 public constant CIRCULATION_LIMIT = 3;
    /// @notice How long an operator has to accept a return before the holder can force it.
    uint64 public constant CONFIRM_WINDOW = 7 days;
    uint64 public constant MIN_OUT_WINDOW = 1 days;
    uint64 public constant MAX_OUT_WINDOW = 365 days;
    uint256 public constant MAX_DEPOSIT = 100 ether;
    uint256 public constant MAX_NAME = 64;
    uint32 public constant MAX_CRATES_PER_FLEET = 10_000;
    uint32 public constant MAX_MINT_PER_CALL = 200;
    uint32 public constant MAX_CYCLES = 10_000;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 500;

    /// @notice Taken from the usage fee only. A deposit is never shaved.
    uint16 public protocolFeeBps = 100;

    uint256 public accumulatedFees;
    /// @notice Exactly one deposit per crate in circulation or awaiting acceptance.
    uint256 public lockedTotal;

    Fleet[] private _fleets;
    Crate[] private _crates;
    mapping(uint256 => uint256[]) private _cratesByFleet;
    mapping(address => uint256[]) private _fleetsByOperator;
    mapping(uint256 => uint64) private _returnedAt;
    mapping(address => uint256) private _credits;

    event FleetOpened(uint256 indexed fleetId, address indexed operator, string name, uint256 deposit, uint256 usageFee);
    event CratesAdded(uint256 indexed fleetId, uint256 firstCrateId, uint32 count);
    event CheckedOut(uint256 indexed crateId, address indexed holder, uint256 deposit, uint256 usageFee, uint64 dueAt);
    event Offered(uint256 indexed crateId, address indexed from, address indexed to);
    event OfferCancelled(uint256 indexed crateId);
    event TakenOver(uint256 indexed crateId, address indexed from, address indexed to, uint64 dueAt);
    event ReturnStarted(uint256 indexed crateId, address indexed holder);
    event ReturnAccepted(uint256 indexed crateId, address indexed holder, uint256 depositReturned, bool retired);
    event ReturnForced(uint256 indexed crateId, address indexed holder, uint256 depositReturned);
    event WrittenOff(uint256 indexed crateId, address indexed holder, uint256 depositReturned);
    event DeclaredLost(uint256 indexed crateId, address indexed holder, uint256 depositForfeited);
    event FleetClosed(uint256 indexed fleetId);
    event Withdrawn(address indexed who, uint256 amount);
    event ProtocolFeeUpdated(uint16 feeBps);
    event FeesWithdrawn(address indexed to, uint256 amount);

    constructor() Ownable(msg.sender) {}

    // ------------------------------------------------------------- fleets

    function openFleet(
        string calldata name,
        uint256 deposit,
        uint256 usageFee,
        uint64 outWindow,
        uint32 maxCycles
    ) external whenNotPaused returns (uint256 fleetId) {
        require(bytes(name).length > 0 && bytes(name).length <= MAX_NAME, "bad name");
        require(deposit > 0 && deposit <= MAX_DEPOSIT, "bad deposit");
        require(usageFee <= deposit, "fee above deposit");
        require(outWindow >= MIN_OUT_WINDOW && outWindow <= MAX_OUT_WINDOW, "bad out window");
        require(maxCycles > 0 && maxCycles <= MAX_CYCLES, "bad cycle cap");

        fleetId = _fleets.length;
        _fleets.push(
            Fleet({
                operator: msg.sender,
                deposit: deposit,
                usageFee: usageFee,
                outWindow: outWindow,
                maxCycles: maxCycles,
                crateCount: 0,
                outCount: 0,
                open: true,
                name: name
            })
        );
        _fleetsByOperator[msg.sender].push(fleetId);
        emit FleetOpened(fleetId, msg.sender, name, deposit, usageFee);
    }

    function addCrates(uint256 fleetId, uint32 count) external whenNotPaused returns (uint256 firstCrateId) {
        Fleet storage f = _fleet(fleetId);
        require(f.operator == msg.sender, "not operator");
        require(count > 0 && count <= MAX_MINT_PER_CALL, "bad count");
        require(f.crateCount + count <= MAX_CRATES_PER_FLEET, "fleet full");

        firstCrateId = _crates.length;
        for (uint32 i = 0; i < count; i++) {
            uint256 id = _crates.length;
            _crates.push(
                Crate({
                    fleetId: uint32(fleetId),
                    holder: address(0),
                    offeredTo: address(0),
                    cycles: 0,
                    dueAt: 0,
                    hardDueAt: 0,
                    state: CrateState.AtDepot
                })
            );
            _cratesByFleet[fleetId].push(id);
        }
        f.crateCount += count;
        emit CratesAdded(fleetId, firstCrateId, count);
    }

    function closeFleet(uint256 fleetId) external {
        Fleet storage f = _fleet(fleetId);
        require(f.operator == msg.sender, "not operator");
        require(f.open, "already closed");
        f.open = false;
        emit FleetClosed(fleetId);
    }

    // -------------------------------------------------------- circulation

    /// @notice Take a crate out. Escrows the deposit and pays the usage fee.
    function checkout(uint256 crateId) external payable nonReentrant whenNotPaused {
        Crate storage c = _crate(crateId);
        Fleet storage f = _fleets[c.fleetId];
        require(f.open, "fleet closed");
        require(c.state == CrateState.AtDepot, "not at depot");
        require(c.cycles < f.maxCycles, "crate worn out");
        require(msg.sender != f.operator, "operator cannot check out");
        require(msg.value == f.deposit + f.usageFee, "send deposit plus fee");

        c.holder = msg.sender;
        c.state = CrateState.Out;
        c.cycles += 1;
        c.dueAt = uint64(block.timestamp) + f.outWindow;
        c.hardDueAt = uint64(block.timestamp) + f.outWindow * CIRCULATION_LIMIT;
        f.outCount += 1;

        lockedTotal += f.deposit;
        _takeFee(f, f.usageFee);
        emit CheckedOut(crateId, msg.sender, f.deposit, f.usageFee, c.dueAt);
    }

    /// @notice Line up the next holder. They pay; you are not pushing it on them.
    function offer(uint256 crateId, address to) external {
        Crate storage c = _crate(crateId);
        require(c.holder == msg.sender, "not holder");
        require(c.state == CrateState.Out, "not out");
        require(to != address(0) && to != msg.sender, "bad recipient");
        require(block.timestamp < c.hardDueAt, "past its circulation limit");

        c.offeredTo = to;
        emit Offered(crateId, msg.sender, to);
    }

    function cancelOffer(uint256 crateId) external {
        Crate storage c = _crate(crateId);
        require(c.holder == msg.sender, "not holder");
        require(c.offeredTo != address(0), "no offer");
        c.offeredTo = address(0);
        emit OfferCancelled(crateId);
    }

    /**
     * @notice Take a crate on from its current holder. Your deposit goes in,
     *         theirs comes out, and escrow still holds exactly one.
     * @dev Your window starts now, but it cannot run past the crate's hard due
     *      date — near the limit you inherit only what is left of it.
     */
    function takeOver(uint256 crateId) external payable nonReentrant whenNotPaused {
        Crate storage c = _crate(crateId);
        Fleet storage f = _fleets[c.fleetId];
        require(c.state == CrateState.Out, "not out");
        require(c.offeredTo == msg.sender, "not offered to you");
        require(block.timestamp < c.hardDueAt, "past its circulation limit");
        require(msg.value == f.deposit, "send the exact deposit");

        address from = c.holder;
        c.holder = msg.sender;
        c.offeredTo = address(0);

        uint64 want = uint64(block.timestamp) + f.outWindow;
        c.dueAt = want < c.hardDueAt ? want : c.hardDueAt;

        // One deposit in, one deposit out. `lockedTotal` does not move.
        _credits[from] += f.deposit;
        emit TakenOver(crateId, from, msg.sender, c.dueAt);
    }

    /// @notice Hand the crate back. The operator then accepts it into the depot.
    function returnCrate(uint256 crateId) external {
        Crate storage c = _crate(crateId);
        require(c.holder == msg.sender, "not holder");
        require(c.state == CrateState.Out, "not out");

        c.state = CrateState.ReturnPending;
        c.offeredTo = address(0);
        _returnedAt[crateId] = uint64(block.timestamp);
        emit ReturnStarted(crateId, msg.sender);
    }

    /// @notice Accept a returned crate, release the deposit, and retire it if worn.
    function acceptReturn(uint256 crateId) external nonReentrant {
        Crate storage c = _crate(crateId);
        Fleet storage f = _fleets[c.fleetId];
        require(f.operator == msg.sender, "not operator");
        require(c.state == CrateState.ReturnPending, "no return pending");

        bool retired = c.cycles >= f.maxCycles;
        address holder = c.holder;
        uint256 back = f.deposit;

        c.state = retired ? CrateState.Retired : CrateState.AtDepot;
        c.holder = address(0);
        c.dueAt = 0;
        c.hardDueAt = 0;
        f.outCount -= 1;

        lockedTotal -= back;
        _credits[holder] += back;
        emit ReturnAccepted(crateId, holder, back, retired);
    }

    /**
     * @notice Take your deposit back when the operator will not accept the
     *         return. A silent operator cannot sit on anybody's money.
     */
    function forceReturn(uint256 crateId) external nonReentrant {
        Crate storage c = _crate(crateId);
        Fleet storage f = _fleets[c.fleetId];
        require(c.holder == msg.sender, "not holder");
        require(c.state == CrateState.ReturnPending, "no return pending");
        require(block.timestamp > uint256(_returnedAt[crateId]) + CONFIRM_WINDOW, "too early");

        uint256 back = f.deposit;
        c.state = CrateState.AtDepot;
        c.holder = address(0);
        c.dueAt = 0;
        c.hardDueAt = 0;
        f.outCount -= 1;

        lockedTotal -= back;
        _credits[msg.sender] += back;
        emit ReturnForced(crateId, msg.sender, back);
    }

    /**
     * @notice Retire a crate that came back damaged — and refund the holder in
     *         full. A contract cannot inspect a crate, so it does not get to
     *         decide whose fault the damage was. The usage fee covers wear.
     */
    function writeOff(uint256 crateId) external nonReentrant {
        Crate storage c = _crate(crateId);
        Fleet storage f = _fleets[c.fleetId];
        require(f.operator == msg.sender, "not operator");
        require(c.state == CrateState.ReturnPending, "no return pending");

        address holder = c.holder;
        uint256 back = f.deposit;

        c.state = CrateState.Retired;
        c.holder = address(0);
        c.dueAt = 0;
        c.hardDueAt = 0;
        f.outCount -= 1;

        lockedTotal -= back;
        _credits[holder] += back;
        emit WrittenOff(crateId, holder, back);
    }

    /// @notice A crate past its window is lost, and the deposit is the operator's.
    function declareLost(uint256 crateId) external nonReentrant {
        Crate storage c = _crate(crateId);
        Fleet storage f = _fleets[c.fleetId];
        require(f.operator == msg.sender, "not operator");
        require(c.state == CrateState.Out, "not out");
        require(block.timestamp > c.dueAt, "not overdue");

        address holder = c.holder;
        uint256 forfeited = f.deposit;

        c.state = CrateState.Lost;
        c.holder = address(0);
        c.offeredTo = address(0);
        f.outCount -= 1;

        lockedTotal -= forfeited;
        _credits[f.operator] += forfeited;
        emit DeclaredLost(crateId, holder, forfeited);
    }

    /// @dev Allowed while paused. Money owed to someone is never held hostage.
    function withdraw() external nonReentrant {
        uint256 amount = _credits[msg.sender];
        require(amount > 0, "nothing to withdraw");
        _credits[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
    }

    // --------------------------------------------------------------- views

    function fleetCount() external view returns (uint256) {
        return _fleets.length;
    }

    function crateCount() external view returns (uint256) {
        return _crates.length;
    }

    function getFleet(uint256 fleetId) external view returns (Fleet memory) {
        return _fleet(fleetId);
    }

    function getCrate(uint256 crateId) external view returns (Crate memory) {
        return _crate(crateId);
    }

    function balanceOf(address who) external view returns (uint256) {
        return _credits[who];
    }

    function getFleetsByOperator(address who) external view returns (uint256[] memory) {
        return _fleetsByOperator[who];
    }

    function getCratesByFleet(uint256 fleetId, uint32 from, uint32 limit)
        external
        view
        returns (uint256[] memory ids)
    {
        _fleet(fleetId);
        uint256[] storage all = _cratesByFleet[fleetId];
        uint32 n = uint32(all.length);
        if (from >= n) return new uint256[](0);
        uint32 end = from + limit;
        if (end > n || end < from) end = n;
        ids = new uint256[](end - from);
        for (uint32 i = from; i < end; i++) ids[i - from] = all[i];
    }

    /// @notice Crates in this fleet that could be checked out right now.
    function availableCrates(uint256 fleetId, uint32 from, uint32 limit)
        external
        view
        returns (uint256[] memory ids)
    {
        Fleet storage f = _fleet(fleetId);
        uint256[] storage all = _cratesByFleet[fleetId];
        uint32 n = uint32(all.length);
        if (from >= n) return new uint256[](0);
        uint32 end = from + limit;
        if (end > n || end < from) end = n;

        uint256[] memory buf = new uint256[](end - from);
        uint32 found;
        for (uint32 i = from; i < end; i++) {
            Crate storage c = _crates[all[i]];
            if (c.state == CrateState.AtDepot && c.cycles < f.maxCycles) buf[found++] = all[i];
        }
        ids = new uint256[](found);
        for (uint32 i = 0; i < found; i++) ids[i] = buf[i];
    }

    function isOverdue(uint256 crateId) external view returns (bool) {
        Crate storage c = _crate(crateId);
        return c.state == CrateState.Out && block.timestamp > c.dueAt;
    }

    /// @notice Seconds left on this holder's window, and on the crate's whole trip.
    function timeLeft(uint256 crateId) external view returns (uint64 holderWindow, uint64 circulation) {
        Crate storage c = _crate(crateId);
        if (c.state != CrateState.Out) return (0, 0);
        uint64 now_ = uint64(block.timestamp);
        holderWindow = c.dueAt > now_ ? c.dueAt - now_ : 0;
        circulation = c.hardDueAt > now_ ? c.hardDueAt - now_ : 0;
    }

    /// @notice Whether a pending return can be forced through yet.
    function returnForceable(uint256 crateId) external view returns (bool) {
        Crate storage c = _crate(crateId);
        if (c.state != CrateState.ReturnPending) return false;
        return block.timestamp > uint256(_returnedAt[crateId]) + CONFIRM_WINDOW;
    }

    function quoteCheckout(uint256 fleetId) external view returns (uint256 deposit, uint256 usageFee, uint256 total) {
        Fleet storage f = _fleet(fleetId);
        return (f.deposit, f.usageFee, f.deposit + f.usageFee);
    }

    /// @notice How the usage fee splits between the operator and the protocol.
    function quoteUsageFee(uint256 fleetId) external view returns (uint256 toOperator, uint256 protocolFee) {
        Fleet storage f = _fleet(fleetId);
        protocolFee = (f.usageFee * protocolFeeBps) / 10_000;
        toOperator = f.usageFee - protocolFee;
    }

    /// @notice Newest-first page of fleet ids.
    function getRecent(uint256 limit) external view returns (uint256[] memory ids) {
        uint256 n = _fleets.length;
        if (limit > n) limit = n;
        ids = new uint256[](limit);
        for (uint256 i = 0; i < limit; i++) ids[i] = n - 1 - i;
    }

    // --------------------------------------------------------------- admin

    function setProtocolFeeBps(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_PROTOCOL_FEE_BPS, "fee too high");
        protocolFeeBps = newFeeBps;
        emit ProtocolFeeUpdated(newFeeBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Bounded by `accumulatedFees`. Deposits are unreachable from here.
    function withdrawFees(address payable to) external onlyOwner nonReentrant {
        require(to != address(0), "bad recipient");
        uint256 amount = accumulatedFees;
        require(amount > 0, "nothing to withdraw");
        accumulatedFees = 0;
        emit FeesWithdrawn(to, amount);
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    // ------------------------------------------------------------ internal

    function _takeFee(Fleet storage f, uint256 fee) private {
        if (fee == 0) return;
        uint256 proto = (fee * protocolFeeBps) / 10_000;
        accumulatedFees += proto;
        _credits[f.operator] += fee - proto;
    }

    function _fleet(uint256 fleetId) private view returns (Fleet storage) {
        require(fleetId < _fleets.length, "no such fleet");
        return _fleets[fleetId];
    }

    function _crate(uint256 crateId) private view returns (Crate storage) {
        require(crateId < _crates.length, "no such crate");
        return _crates[crateId];
    }

    receive() external payable {
        accumulatedFees += msg.value;
    }
}
