# CrateCycle

Deposit-return circulation on BOT Chain, for things meant to come back.

An operator runs a **fleet** of reusable containers. Taking one out escrows a
deposit and pays a usage fee; bringing it back returns the deposit whole.

## The deposit rides with the crate

The part that makes this more than a rental ledger is what happens in between.
A container does not have to come home before it can go out again. The holder
offers it on, the next person takes it over and pays the deposit, and the
previous holder's deposit is released **in the same transaction**.

So escrow holds exactly one deposit per crate in circulation, no matter how many
hands it passes through. Three holders in a row and the contract has still only
ever been holding a single deposit for that crate — `lockedTotal` does not move
on a handoff at all.

## Two clocks

Letting a crate circulate freely would otherwise be a way to never return
anything, so there are two deadlines rather than one:

- Each holder gets a fresh `outWindow` to pass it on or bring it back.
- Each crate gets a `hardDueAt` fixed at checkout — `CIRCULATION_LIMIT` (three)
  windows — and **no handoff may push past it**. Near the limit a new holder
  inherits only what is left of it, and once it passes, nobody new may take the
  crate on at all.

You get a fair window; the crate still has to come home.

## Who loses what, and when

Only one route forfeits a deposit, and it is time-triggered:

- **Miss your window** and the operator can declare the crate lost and keep the
  deposit. That is the teeth.
- **A write-off refunds the holder in full.** A contract cannot inspect a crate,
  so it does not get to decide whose fault damage was. The usage fee is what
  pays for wear — not somebody's deposit. The operator eats the loss of the
  container, which is also what stops write-offs being used as a revenue line.
- **An operator who will not accept a return** does not get to sit on the money.
  Seven days after a return is filed, the holder forces it through themselves.

A forced return puts the crate back at the depot without laundering its age: a
crate that has used all its cycles still reads as worn out and cannot be checked
out again.

## Contract surface

| Call | Who | What it does |
|---|---|---|
| `openFleet(name, deposit, usageFee, outWindow, maxCycles)` | anyone | Fee ≤ deposit, window 1–365 days, cycles ≤ 10,000 |
| `addCrates(fleetId, count)` | operator | Up to 200 a call, 10,000 a fleet |
| `checkout(crateId)` | anyone but the operator | Deposit **plus** usage fee; starts both clocks |
| `offer(crateId, to)` / `cancelOffer` | holder | Name the next holder — they pay, you do not push |
| `takeOver(crateId)` | the named recipient | Their deposit in, yours out, same call |
| `returnCrate(crateId)` | holder | Files the return |
| `acceptReturn(crateId)` | operator | Releases the deposit; retires a worn crate |
| `writeOff(crateId)` | operator | Retires it and **still refunds in full** |
| `forceReturn(crateId)` | holder, after 7 days | Return without the operator |
| `declareLost(crateId)` | operator, once overdue | Deposit forfeited |
| `withdraw()` | anyone owed | Pull payment, works while paused |

Useful views: `quoteCheckout`, `quoteUsageFee`, `timeLeft`, `isOverdue`,
`returnForceable`, `availableCrates`, `getCratesByFleet`, `getRecent`.

`onlyOwner` covers pause/unpause, `setProtocolFeeBps` (1% default, capped 5%)
and `withdrawFees`, bounded by `accumulatedFees`. The protocol cut comes from
the usage fee only — a deposit is never shaved. A pause blocks opening fleets,
adding crates, checkouts and handoffs, but never a return, an acceptance or a
withdrawal.

## Build and deploy

```bash
npm install
npx hardhat test          # 23 tests
npm run deploy:testnet    # BOT Chain testnet, chain 968
npm run deploy:mainnet    # BOT Chain mainnet, chain 677
```

Create `.env` from `.env.example` with your `PRIVATE_KEY` first. The deploy
script prints the network name **and** the chain id.

After deploying, paste the address into `CONTRACT_ADDRESS` in
`frontend/index.html`. For mainnet also swap the five network values flagged in
the comment block directly above it, and set `label` to `"MAINNET"`.

## Frontend

Single file, no build step, ethers v6 from cdnjs. **Isometric 3D**: a warm
concrete-cream yard ruled on the isometric diagonal, with chunky slabs that
carry hard offset shadows and no blur. The depot is drawn as a genuine
**isometric yard in SVG** — every crate is a cube built from a top rhombus and
two side faces, laid on an iso grid and painted by state (timber at depot, blue
out with a holder, amber awaiting the operator, grey retired, red lost), with a
flag on the ones that are overdue and a marker on the one you have selected.
Cubes are drawn back to front so the near ones overlap correctly, and clicking
one opens its detail in the side panel. A crate that is out shows **two stacked
bars** — this holder's window and the whole trip's remaining time — so the
difference between the two clocks is visible rather than explained. Fleets are
chunky tabs along the top; the operator console sits under the detail panel.

The page ends with the BOT Chain ecosystem footer, carrying links to
**botchain.ai** and the **block explorer**. The explorer href is read from the
`NETWORK` config at the top of the file, so the five-value mainnet swap updates
it too. No chain ID is printed anywhere on the page — these sites move from
testnet to mainnet, so a rendered chain ID would be wrong half the time.
