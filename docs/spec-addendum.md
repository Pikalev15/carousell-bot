# Spec Addendum: Word Blacklists And Bad Pricer Filters

This section extends the original Carousell bot spec with stronger user-controlled filtering.

## Blocked Words And Phrases

The app should reject or down-rank listings containing phrases that usually mean the post is not a clean personal sale. These phrases live in `filter_config` and are editable in the UI.

Default groups:

- Bait/non-selling: `WTB`, `want to buy`, `looking to buy`, `anyone selling`, `looking for`, `searching for`, `does anyone have`
- Spam/scam: `fast cash`, `urgent cash`, `need money now`, `trading bot`, `forex`, `crypto`, `NFT`, `referral`, `affiliate`
- Annoying seller tactics: `no lowball`, `lowball ignored`, `don't bother if`, `no time wasters`, `serious buyers only`, `fixed price only`
- Marketplace noise: `dropship`, `bulk order`, `reseller`, `commission`, `join my team`, `work from home`, `side hustle`

## Stupid Pricer Detection

"Stupid pricers" are listings where the price behavior makes the post low-value even when the title looks relevant. The app should classify these separately from spam so the user can tune strictness.

Default rules:

- Reject prices that are obvious bait: `$0`, `$1`, `$8,888`, `$9,999`, `$12,345`, `$99,999`
- Reject price-placeholder language: `offer me`, `PM offer`, `price to be discussed`, `POA`, `testing water`
- Flag listings priced above a configurable category ceiling or above `1.35x` the rolling category median
- Flag listings that pair high prices with hostile text such as `no lowball`, `don't waste my time`, or `price firm`
- Keep the reason code visible in the listing card and filter stats

## Data Model

Add `type = 'bad_pricer'` to `filter_config` and include pricer-specific settings in app config:

```json
{
  "badPricer": {
    "enabled": true,
    "overMedianMultiplier": 1.35,
    "baitPrices": [0, 1, 8888, 9999, 12345, 99999]
  }
}
```

## UI Requirements

Settings must include:

- Phrase blacklist management
- Bad pricer toggle
- Over-median multiplier input
- Bait price list
- Seller blacklist management
- Filter stats showing blocked words, bad pricers, spam, and blocked sellers
