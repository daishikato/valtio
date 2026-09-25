# v3 PR a: Sync-only Notifications and `batch()`

**Status: design note, not implemented.** This is the first PR of the split described in [v3-o1-subscription.md](./v3-o1-subscription.md#delivery-plan). It targets `v3`.

**Decided so far:**

- Notifications become synchronous, and the `notifyInSync` and `sync` options go away.
- `batch()` lands in vanilla and returns `fn`'s result.
- When subscriber callbacks throw, the delivery still finishes, and then an `AggregateError` is thrown.
- `subscribeInAsync` is not added ([why](#not-added-subscribeinasync)).
- In this PR, `useSnapshot` pays for a snapshot on every write that isn't batched. That cost is accepted until d5 removes it, with a `TODO` in the code and no workaround.

## Changes

### `valtio/vanilla`

**`subscribe(p, callback)`**

- The callback runs synchronously, before the write that triggered it returns. It receives `[op]`, or `[]` when ops are not enabled with `unstable_enableOp`.
- The third parameter is removed from the types. Passing a boolean throws (message 1 below). `false` throws too, because the asynchronous delivery it selected no longer exists. `subscribe(p, cb, undefined)` stays valid.

**`batch(fn)` (new)**

- `fn` runs synchronously, and `batch` returns its result.
- Listeners are deferred until the outermost `batch` returns. Each subscription then runs once, with the ops of every write it would have heard, in write order. Nested `batch` calls join the outer one.
- Versions still move on every write, so reads and `snapshot()` inside the batch see the writes immediately.
- A subscription removed during the batch is skipped.
- Only the synchronous part of an `async` function is batched.

**Delivery order**

All notifications, batched or not, go through one delivery loop.

- **Rounds.** A round runs every pending subscription once, in the order each was first notified.
- **Writes made by callbacks** are queued for the next round, not delivered inside the current one. Every subscriber therefore sees writes in order, and a subscriber that hasn't received its batched ops yet can't see a later write first.
- **One loop at a time.** A `batch()` called from a callback joins the running loop instead of starting another. That `batch()` therefore returns before its listeners run. They run in the next round, still before the outermost write or `batch` returns.
- **Timing.** The loop ends when a round leaves nothing pending, still before the outermost write or `batch` returns.

**Errors**

- **Callback errors are collected.** The loop always finishes, so one failing subscriber doesn't silence the others.
- **After the loop,** if any callback threw, an `AggregateError` with every callback error is thrown. For an unbatched write, the assignment throws it after the write has taken effect.
- **Errors from `fn`:**
  - If only `fn` threw, `batch` rethrows that error unchanged, after delivering the notifications for the writes it made.
  - If `fn` and callbacks both threw, the `AggregateError` lists `fn`'s error first.

`AggregateError` is an ES2021 global. The repo's TypeScript `lib` is `ESNext` and Node is 20 or later, so neither is a concern. Support on Hermes should be confirmed before release.

**Implementation sketch.** Module-level state:

- `depth`: the number of open `batch` calls
- `delivering`: whether the loop is running
- `pending`: a map from subscription to ops

The pieces:

- **Listener:** records its subscription in `pending`, and appends the op only when ops are enabled. With ops off, the callback receives `[]`, never `[undefined]`. The listener runs the loop itself only when `depth` is 0 and no loop is running.
- **Loop:** swaps `pending` for a fresh map, runs each still-active subscription with its ops while collecting errors, and repeats until the fresh map stays empty. Then it throws as described above.
- **`batch`:** increments `depth`, runs `fn`, and decrements in `finally`. It runs the loop only when `depth` is back to 0 and no loop is running.

### `valtio/utils`

- **`subscribeKey(p, key, callback)`** is synchronous. Passing a boolean fourth argument throws.
- **`devtools`** coalesces a burst of writes into one Redux DevTools message with a private microtask helper, so its output doesn't change. It keeps calling `unstable_enableOp()`, which its action names depend on.
- **`proxyMap` and `proxySet`** wrap `set`, `add`, `delete` and `clear` in `batch()`. Each of these writes `data`, `index` and `epoch` separately. Without `batch`, a listener would run up to three times and see an index and data that don't match yet. A call that writes nothing, such as `add` of a value already present or `delete` of a missing key, doesn't notify.

### `valtio/react`

- **`useSnapshot(p)`** takes no options. A second argument that isn't `undefined` throws (message 2). The check is on the value, not on whether an argument was passed, because `useProxy` forwards its own `options` even when the caller omitted it. Its internal subscription is synchronous.
- **`useProxy(p)`** in `valtio/react/utils` takes no options either, and throws the same way when `options` isn't `undefined`.
- **`getSnapshot`** is unchanged. It gets a `TODO` saying that it takes a snapshot on every notification, and that d5 replaces it with a per-hook counter.

## Migration

| Change                                                                                   | Detection                           | Remedy                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `subscribe` callbacks run synchronously on every write, instead of once per microtask    | Docs                                | `batch()` around multi-write code, or coalesce in the callback (recipe) |
| A subscriber callback that throws now throws from the write, wrapped in `AggregateError` | The thrown error                    | Handle errors inside the callback                                       |
| `subscribe(p, cb, true)` or `subscribe(p, cb, false)`                                    | TypeScript error; runtime error (1) | Drop the argument                                                       |
| `subscribeKey(p, key, cb, true)`                                                         | TypeScript error; runtime error (1) | Drop the argument                                                       |
| `useSnapshot(p, { sync })`, `useProxy(p, { sync })`                                      | TypeScript error; runtime error (2) | Drop the argument; updates are always synchronous                       |
| A loop of writes without `batch()` makes `useSnapshot` take one snapshot per write       | Silent, slower                      | `batch()`; d5 removes the cost                                          |
| `splice`, `sort` and other native array methods notify once per internal write           | Silent                              | `batch()`                                                               |
| The "controlled inputs may lose caret position" gotcha                                   | Goes away                           | —                                                                       |

The first row is the main silent semantic change, and it affects every `subscribe` user. It is the change #1177 asked for, so the migration guide should lead with it. The guide gives this recipe for code that wants the old coalesced delivery:

```js
const subscribeCoalesced = (p, callback) => {
  const ops = []
  let scheduled = false
  let active = true
  const unsubscribe = subscribe(p, (newOps) => {
    ops.push(...newOps)
    if (!scheduled) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (active) callback(ops.splice(0))
      })
    }
  })
  return () => {
    active = false
    unsubscribe()
  }
}
```

The docs PR adds a test for this recipe.

Runtime messages:

1. `notifyInSync has been removed. subscribe() is synchronous. Use batch() to group notifications.`
2. `useSnapshot() no longer accepts an options argument. Updates are synchronous.`

`subscribeKey` and `useProxy` use the same messages with their own names.

## The accepted cost

This is what `sync: true` users pay on `v3` today, and what everyone pays after this PR until d5. A component reads only `snap.items.length`, and a handler marks every item done without `batch()`. The component never re-renders, so the whole cost is `getSnapshot` taking a snapshot on each write.

| Items | Today's default (async) | Sync delivery |
| ----- | ----------------------- | ------------- |
| 1,000 | 9 ms                    | 936 ms        |
| 5,000 | 28 ms                   | 26,278 ms     |

Measured on `v3` at `fb594a1` with vitest, jsdom and a React 19.2.5 dev build, using `useSnapshot(state, { sync })`. `v3` is unreleased, so this interim cost never ships.

## Tests

**Existing tests that change:**

- Tests that pass `true` as the third argument of `subscribe` or `subscribeKey` drop it: `vanilla/subscribe`, `vanilla/proxy`, `vanilla/detachment`, `utils/subscribeKey`.
- Tests that pass `{ sync: true }` drop it: `react/basic`, `react/gotchas`, `react/mapset`, `react/useProxy`.
- Tests that wait a microtask and expect one callback for several writes now see one callback per write. They either wrap the writes in `batch()` or assert the new count. An implementation will confirm the list.

**New tests:**

- `subscribe` delivers synchronously, with one op per write.
- `batch`:
  - nesting
  - the return value
  - unsubscribing during the batch
  - `snapshot()` inside the batch
  - one callback with every op, in order
- Delivery order:
  - A callback that writes doesn't let a later write reach another subscriber before its batched ops.
  - A `batch` inside a callback joins the running loop. It returns before its listeners run, and they run before the outermost write or `batch` returns.
- Errors:
  - Several throwing callbacks produce one `AggregateError`, and the remaining subscribers still run.
  - A throwing `fn` alone is rethrown unchanged.
  - When `fn` and a callback both throw, one `AggregateError` lists `fn`'s error first, and the other subscribers still ran.
- With ops disabled, callbacks receive `[]`.
- `subscribe(p, cb, undefined)`, `useSnapshot(p, undefined)` and `useProxy(p)` don't throw.
- Every removed argument throws its message.
- Each `proxyMap` and `proxySet` method that writes notifies once, after `data`, `index` and `epoch` all match. A call that writes nothing doesn't notify.
- `devtools` still sends one message per burst.

## Docs

- `api/advanced/subscribe.mdx`: synchronous delivery, `batch`, delivery order, errors, and the coalescing recipe.
- A new page for `batch`.
- `how-tos/some-gotchas.mdx`: remove the controlled-input caret section, since updates are always synchronous.
- The v3 migration guide.

## Not added: `subscribeInAsync`

Decided: `subscribeInAsync` is not added.

- **Its only in-repo user is `devtools`,** which coalesces with a private helper.
- **Application code has other remedies.** It can wrap multi-write code in `batch()`, or coalesce inside its callback with the recipe above.
- **It can be added later without breaking anything,** but it could not be removed later without breaking users.
