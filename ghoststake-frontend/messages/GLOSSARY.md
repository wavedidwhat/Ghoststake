# GhostStake glossary

The words the app uses for its own ideas. Every string in `en.json` is
checked against this list as its screen is migrated (GHO-115), so the same
thing gets the same name on every screen. If new copy needs a term that isn't
here, add it here first.

**Status:** everything marked *proposed* is a suggestion taken from the
current copy and hasn't been decided. Settle it before migrating the first
screen that uses it.

## Money in the vault

| Use | Not | Means |
|---|---|---|
| **stake** (noun), **stake** (verb) | deposit (as a noun), savings | What you've put in the vault. It earns yield from the moment it lands. "Deposit" is fine as the verb for putting it in: "Deposit into the vault". |
| **yield** | earnings, interest (for this) | What your stake earns. Simple interest, not compounded. |
| **withdraw** | unstake, redeem | Take stake out. Limited by any debt against it. |
| **shares** | units | Your claim on the vault. Shown beside the stake, never in its place. |

## Borrowing

| Use | Not | Means |
|---|---|---|
| **borrow against your stake** | draw, leverage (in UI copy) | Take a loan with your stake as collateral. The stake stays in the vault. |
| **debt** | loan balance, owed | What you owe: principal plus interest. Grows every second. |
| **lien** | — | The claim a loan places on your stake. Use it only where the mechanism matters (Terms, the landing page). Elsewhere say **debt**. *Proposed.* |
| **collateral** | security | What secures a loan: your stake, or the stock you deposit. |
| **health factor** | safety, safety factor, health | Collateral against debt. At or below **1.00**, the position can be liquidated. |
| **LTV ceiling** | borrow limit, borrowing capacity, max borrow | The most you can borrow. A borrow past it is refused. *Proposed:* the stock-loan screen says "Borrow limit", and the borrow and market screens say "borrowing capacity", for the same idea. |
| **liquidation threshold** | liquidation line | Where the health factor reaches 1.00. Sits above the LTV ceiling on purpose. *Proposed:* the borrow, market and stock-loan screens say "liquidation line". |
| **liquidate**, **liquidation** | seize, sell off | Anyone may repay part of an unhealthy loan and take collateral at a discount. |
| **liquidation bonus** | discount (alone), reward | The discount a liquidator gets, paid out of the borrower's position. |
| **write off** | bad debt, close out | Ending a position that owes more than it holds. The loss goes to reserves, then to lenders. |

## Lending pool

| Use | Not | Means |
|---|---|---|
| **lend**, **supply** | deposit (here) | Put funds in the pool for borrowers. *Proposed:* both appear today ("Lend", "Your supply"). Pick one verb. |
| **lending pool** | the pool (alone, on screens that also show a round's pool) | Where borrowed funds come from. |
| **supply rate**, **borrow rate** | APY | Simple and annualised, so this is **APR**, not APY. Never show a compounded figure. |
| **utilization** | usage | The fraction of the pool that is out on loan. |
| **reserves** | treasury (in user copy) | The protocol's cushion, which absorbs bad debt before lenders do. |

## Markets and rounds

| Use | Not | Means |
|---|---|---|
| **market** | — | One thing to take a view on (an asset price, or a question). It has many rounds. |
| **round** | game, epoch | One time window in a market: open, then locked, then closed and settled. |
| **question** | — | A market settled by a claimed outcome rather than a price feed. It's also a category tab. |
| **position** | bet, wager | What you hold in a round. |
| **take a position** | take a side, stake a side, take a view, bet, back your call | Put money on one side of a round. *Proposed:* six phrasings are in use today (see below). |
| **side** | — | Yes/no (questions) or up/down (prices). |
| **stake** (in a round) | — | ⚠ **Conflict.** The same word as vault stake. See the open questions. |
| **rake** | fee (for this) | Taken from the losing pool at settlement, so it's already inside the odds shown. |
| **entry cutoff** | entry window (for the cutoff) | How long before lock entry closes. The **entry window** is the period while entry is open. |
| **strike** | target, level | The price a round is measured against. |
| **settle** | resolve (in user copy) | A round is decided and paid out. The operator screen may say "resolve" for the transaction. |
| **void**, **refund** | cancel | A round with no winner. Every stake comes back in full. |
| **winnings** | payout, earnings | What a winning position can claim. |
| **claim** | collect, withdraw (for this) | Pull winnings from the contract. Debt is settled first. *Proposed:* "Collected" appears after a claim. |

## People and roles

| Use | Not | Means |
|---|---|---|
| **operator** | owner (in user copy) | Whoever opens rounds and publishes the demo price. The contract calls it `owner`. Say *operator* unless you're naming the contract check. |
| **keeper** | bot | The automated service that opens rounds and liquidates. |

## Kept as is, not translated

`GhostStake`, `Chainlink`, `Robinhood`, token symbols, contract and function
names (`treasury()`), environment variable names, and Linear IDs.

## Open questions

1. **"Stake" means two things.** Vault stake ("Your stake keeps earning") and
   the amount put on a side of a round ("Staked", "every stake refunded",
   "Nothing staked yet") share the word. In a sentence like "Voided — every
   stake refunded" a reader can't tell whether their vault deposit was
   touched. One candidate is **stake** for the vault and **amount in** or
   **position size** for a round.
2. **Placing a position** is called "take a position" (app description),
   "take a side" (OG image, Terms), "stake a side" (landing, the market
   page's link-preview description), "take a view" (how-it-works, landing,
   the markets subtitle), "backs your call" (OG image) and "riding on a
   market" (portfolio, money strip).
   Pick one verb for the action. The others can stay as voice in marketing
   copy, but never as a button or label.
3. **Health factor** is also "Safety" (the money strip, and the title of the
   notification in `lib/alerts.ts`) and "safety factor" (the notification
   bell). Keep **health factor**: it's the term in the
   contract, in Terms, and in every other DeFi app.
4. **LTV ceiling vs borrow limit vs borrowing capacity.** Three names for
   one idea across the borrow, market and stock-loan screens.
5. **Copy outside JSX.** Notification titles (`lib/alerts.ts`), toasts, the
   PWA manifest and the link-preview text are plain strings in `.ts` files,
   which the lint rule cannot see. They are migrated with their screen, and
   found by reading the code, not by the linter.
