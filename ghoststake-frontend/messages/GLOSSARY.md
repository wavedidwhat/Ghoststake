# GhostStake glossary

The words the app uses for its own ideas. Every message in `en.json` uses
these, so the same thing has the same name on every screen. If new copy
needs a term that isn't here, add it here first.

**Status:** decided (GHO-121, 2026-09-28). Each decision says why, and what
comparable products do, so it can be revisited with evidence rather than
taste.

## The four decisions

### 1. Money in the vault is a **deposit**. Money on a round is a **position**.

| Use | Not | Means |
|---|---|---|
| **deposit** (noun and verb) | stake, savings | Money in the vault. It earns from the moment it lands. |
| **position** | stake, bet | Money on one side of one round. |

**Why:** in everyday English "stake" means money bet on an outcome
(Wiktionary: "that which is laid down as a wager"), but crypto uses it for
locking assets to earn (Lido, Coinbase staking). The app used it both ways,
so "Voided — every stake refunded" could read as a deposit being touched.
Earning products say "deposit" (Coinbase: "deposit your USDC, start
earning"); prediction markets say "position" (Kalshi, Robinhood). "Stake"
now appears only in the brand name.

**Not "savings":** a deposit here secures loans and can be liquidated.
"Savings" promises a safety it doesn't have.

The page URL stays `/stake`, and code keys like `stake.title` stay. Those are
identifiers, not copy, and renaming them would break links.

### 2. Putting money on a side is **backing** it.

| Use | Not | Means |
|---|---|---|
| **back** (a side, your call) | take a side, take a view, stake a side, take a position, riding on, bet, buy | Put money on Yes or No. Buttons: "Back Yes · 20.00 mUSDC". |

**Why:** "back" is the standard word. Betfair, the largest betting exchange,
labels its main button **Back**, and parimutuel pools describe winners as
the selection "fewer people backed". It says money goes in, which "pick" or
"make a choice" don't. Polymarket, Kalshi and Robinhood say "Buy Yes", but
that's wrong here: nobody buys shares at a price; money joins a shared pool.

**Knock-on:** "back" now means betting, so nothing else says it. A deposit
**secures** a loan; it doesn't back one.

### 3. The number that says how close a loan is to liquidation is **loan health**.

| Use | Not | Means |
|---|---|---|
| **loan health** | health factor, safety, safety factor, health | Collateral against debt. At or below **1.00** the loan can be liquidated. |

**Why:** Coinbase uses "loan health" for exactly this. Aave keeps "health
factor" but has to explain it as "the safety of a borrow position", which
is the plain word showing through. The number itself is unchanged.

### 4. The most you can borrow is your **borrow limit**.

| Use | Not | Means |
|---|---|---|
| **borrow limit** | LTV ceiling, borrowing capacity, capacity | The most you can borrow. A borrow past it is refused. |
| **max LTV** | — | Only in Terms, as the percentage behind the borrow limit, explained the first time it appears. |

**Why:** plain words for a plain idea. GOV.UK's rule: technical terms are
fine where needed, but "explain what they mean the first time you use them".

## Words that followed from those

| Use | Not | Means |
|---|---|---|
| **loan** | lien, position (for the vault loan) | What you owe against your deposit. Borrow-against-crypto products say collateral or pledge; nobody says lien to consumers. |
| **liquidation line** | liquidation threshold | Where loan health reaches 1.00. It was already "line" on three screens. |
| **collateral** | — | What secures a loan. Kept where it's accurate and a deposit isn't: stock loans, the liquidator's table, the shared loan-health card. |
| **your money** | your positions (in reassurances) | "Nothing about your money has changed" covers deposits and positions. |
| **your account** | your position (portfolio) | Everything at one address. |
| **void**, **refund** | cancel | A round with no winner; every position comes back in full. Sportsbooks use the same words. |
| **withdraw** | unstake, redeem | Take a deposit out. |
| **yield** | earnings, interest (for this) | What a deposit earns. Simple, not compounded. |

## Lending pool

| Use | Not | Means |
|---|---|---|
| **lend**, **supply** | deposit (here) | Put money in the pool for borrowers. Both still appear; not yet settled. |
| **lending pool** | the pool (alone, beside a round's pool) | Where borrowed money comes from. |
| **supply rate**, **borrow rate** | APY | Simple and annualised: APR, never a compounded figure. |
| **utilization** | usage | The share of the pool out on loan. Explained on the Lend page. |
| **reserves** | treasury (in user copy) | The protocol's cushion, which takes bad debt before lenders do. |

## Markets and rounds

| Use | Not | Means |
|---|---|---|
| **market** | — | One thing to back a side on. It has many rounds. |
| **round** | game, epoch | One time window: open, locked, closed, settled. |
| **question** | — | A market settled by a claimed outcome rather than a price feed. |
| **side** | — | Yes or No. |
| **rake** | fee (for this) | Taken from the losing pool at settlement; already inside the odds shown. |
| **entry cutoff** | entry window (for the cutoff) | How long before lock entry closes. |
| **strike** | target, level | The price a round is measured against. |
| **settle** | resolve (in user copy) | A round is decided and paid out. The operator screen says "resolve" for the transaction. |
| **winnings** | payout | What a winning position can claim. |
| **claim** | collect | Pull winnings from the contract. Debt is repaid first. |

## People and roles

| Use | Not | Means |
|---|---|---|
| **operator** | owner (in user copy) | Opens rounds and publishes the demo price. The contract calls it `owner`. |
| **keeper** | bot | The automated service that opens rounds and liquidates. |

## Kept as is, not translated

`GhostStake`, `Chainlink`, `Robinhood`, token symbols and tickers, contract
and function names, environment variable names, Linear IDs.

## Still open

- **Lend vs supply** on the Lend page.
- **Plain-English sweep.** "Accrue", "parimutuel" and similar are accurate
  but not plain. GOV.UK's rule applies: keep a technical term only where
  it's needed, and explain it the first time. That's part of the voice pass.

## Sources

- Wiktionary, [stake](https://en.wiktionary.org/wiki/stake)
- Coinbase, [Earn](https://www.coinbase.com/earn), [USDC loan health](https://help.coinbase.com/en/coinbase/trading-and-funding/loan/loan-health)
- Kalshi, [help centre](https://help.kalshi.com/); Robinhood, [event contracts](https://robinhood.com/us/en/support/articles/event-contracts-overview/)
- Polymarket, [what is Polymarket](https://help.polymarket.com/en/articles/13364060-what-is-polymarket); Myriad, [getting started](https://tech.yahoo.com/general/articles/getting-started-myriad-185819616.html)
- Betfair, [back and lay explained](https://betting.betfair.com/how-to-use-betfair-exchange/beginner-guides/exchange-explainers-310120-6.html)
- Parimutuel betting, [Wikipedia](https://en.wikipedia.org/wiki/Parimutuel_betting)
- Void bets, [Covers](https://www.covers.com/industry/why-are-bets-voided)
- Aave, [health factor and liquidations](https://aave.com/help/borrowing/liquidations)
- GOV.UK, [A to Z style guide](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/)
