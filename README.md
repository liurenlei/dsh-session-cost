# Session cost

Adds a cost reading to the composer dock, after the shipped token statistics:
`≈¥0.42` (or `≈$0.06`) for the current session. Click the reading for a
per-model breakdown of input (cache miss), input (cache hit), cache write, and
output tokens and cost, plus the price update time.

## Where it shows

The reading is a third `conversation.composer.dock` entry (id `cost`, order 2),
beside the existing `activity` and `usage` pills (the context ring is a
separate control). It is hidden until a session has provider-reported token
usage.

## How the cost is computed

- A host-side `sessionCost` projection folds every settlement's
  provider-reported usage (`assistant/message` and failed `assistant/attempt`
  samples) into per-route token buckets. Route changes come from
  `model/selection` and `request/context`, so sessions that switch models are
  priced per model instead of at one blended rate.
- DeepSeek's official Chinese pricing page is fetched as Markdown and parsed
  for the peak and idle CNY rates. Peak/idle is chosen per message from the
  message timestamp (Beijing time, weekdays 09:00-12:00 and 14:00-18:00), so a
  session that spans both periods is priced correctly. Holidays are not
  detected automatically; add them to `holidays` if exactness matters.
- Every other provider is priced from the models.dev public catalog (USD per
  1M tokens, converted to the display currency at `usdToCny`).
- Both prices are refreshed in the background at startup and every
  `refreshHours`. A failed fetch keeps the previous values; before the first
  successful fetch a built-in copy of the DeepSeek table is used.
- Manual `overrides` win over everything else.

No session content is sent anywhere: the plugin only downloads the two public
price documents.

## Configuration

The bundle inserts the row; override its config in the profile's own patch
layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`) with a matching id:

```yaml
- id: session-cost
  name: '@local/dsh-session-cost'
  config:
    currency: CNY
```

| Field | Default | Meaning |
|---|---|---|
| `currency` | `CNY` | `CNY` or `USD` display currency |
| `usdToCny` | `7.1` | Conversion rate when a price and the display currency differ |
| `autoUpdate` | `true` | Fetch prices in the background |
| `refreshHours` | `12` | Hours between refreshes |
| `holidays` | `[]` | Beijing dates (`YYYY-MM-DD`) treated as DeepSeek idle |
| `providerMap` | `{}` | Map a Harness provider id to a price-source provider id, e.g. `{"my-api":"deepseek"}` |
| `overrides` | `{}` | `"provider/model"` prices per 1M tokens in the display currency; win over both sources |

A matching id replaces the whole `config`, so repeat only the fields you need
and let the defaults fill the rest. Example price override:

```yaml
config:
  currency: CNY
  overrides:
    openrouter/deepseek-v4-pro:
      input: 6
      cacheRead: 0.3
      cacheWrite: 0
      output: 18
```

## Accuracy

The reading is an estimate, not an invoice:

- It uses list prices, not account discounts or free tiers.
- DeepSeek peak/idle follows each message's time, but statutory holidays are
  only honored when listed in `holidays`.
- models.dev may lag a provider's current list price; use `overrides` to pin a
  route.
- Failed attempts are priced from the route in force when the attempt started.
- After a price refresh, an open session's reading updates on its next token
  event; reopening the session shows the new prices immediately.

Turn the bundle off (or remove it) to stop the unit and the fetch; nothing else
in DSH changes.

## 中文说明

在输入框下方的 token 统计旁增加一个花费读数（如 `≈¥0.42`），点击可查看按模型的
明细。DeepSeek 走官方价格（含高峰/空闲，按消息时间区分），其他 provider 走
models.dev 的 USD 价目表；启动时和每隔 N 小时后台刷新，失败时沿用上次价格。
手动 `overrides` 优先级最高。金额是估算值，不含账户折扣；法定节假日需要在
`holidays` 里手动填写。
