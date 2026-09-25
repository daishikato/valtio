# v3 PR a: Sync-only Notifications and `batch()`

**Status: design note, not implemented.** This is the first PR of the split described in [v3-o1-subscription.md](./v3-o1-subscription.md#delivery-plan). It targets `v3`.

**Decided so far:**

- Notifications become synchronous, and the `notifyInSync` and `sync` options go away.
- `batch()` lands in vanilla, and `subscribeInAsync` in `valtio/utils`.
- In this PR, `useSnapshot` pays for a snapshot on every write that isn't batched. That cost is accepted until d5 removes it, with a `TODO` in the code and no workaround.

## Changes

### `valtio/vanilla`

**`subscribe(p, callback)`**

- The callback runs synchronously after each write. It receives `[op]`, or `[]` when ops are not enabled with `unstable_enableOp`.
- The third parameter is removed from the types. Passing a boolean throws (message 1 below). `false` throws too, because the asynchronous delivery it selected no longer exists.

**`batch(fn)` (new)**

- `fn` runs synchronously, and `batch` returns its result.
- Listeners are deferred until the outermost `batch` returns. Each subscription then runs once, with the ops of every write it would have heard, in write order. Nested `batch` calls join the outer one.
- Versions still move on every write, so reads and `snapshot()` inside the batch see the writes immediately.
- If `fn` throws, the pending notifications are still flushed, because the writes happened, and then the error propagates.
- A subscription removed during the batch is skipped at flush time.
- Writes made by a callback during the flush are delivered immediately, as outside a batch.
- Only the synchronous part of an `async` function is batched.

Implementation sketch: a module-level depth counter and a pending map from subscription to ops. The listener appends to the map while the depth is above zero, and calls the callback directly otherwise. `batch` flushes in a `finally` block when the depth returns to zero.

### `valtio/utils`

- **`subscribeKey(p, key, callback)`** is synchronous. Passing a boolean fourth argument throws.
- **`subscribeInAsync(p, callback)`** is new, and reproduces today's default delivery. Ops are accumulated and the callback runs once in a microtask, skipped if the subscription was removed. It is built on `subscribe`.
- **`devtools`** switches to `subscribeInAsync`, so a burst of writes stays one Redux DevTools message.
- **`proxyMap` and `proxySet`** wrap `set`, `add`, `delete` and `clear` in `batch()`. Each of these writes `data`, `index` and `epoch` separately, so without `batch` a listener would run up to three times and see an index and data that don't match yet.

### `valtio/react`

- **`useSnapshot(p)`** takes no options. Passing any second argument throws (message 2). Its internal subscription is synchronous.
- **`useProxy(p)`** in `valtio/react/utils` takes no options either, and throws the same way.
- `getSnapshot` is unchanged. It gets a `TODO` saying that it takes a snapshot on every notification, and that d5 replaces it with a per-hook counter.

## Migration

| Change                                                                                | Detection                           | Remedy                                                                        |
| ------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `subscribe` callbacks run synchronously on every write, instead of once per microtask | Docs                                | `batch()` around multi-write code, or `subscribeInAsync` for the old delivery |
| `subscribe(p, cb, true)` or `subscribe(p, cb, false)`                                 | TypeScript error; runtime error (1) | Drop the argument                                                             |
| `subscribeKey(p, key, cb, true)`                                                      | TypeScript error; runtime error (1) | Drop the argument                                                             |
| `useSnapshot(p, { sync })`, `useProxy(p, { sync })`                                   | TypeScript error; runtime error (2) | Drop the argument; updates are always synchronous                             |
| A loop of writes without `batch()` makes `useSnapshot` take one snapshot per write    | Silent, slower                      | `batch()`; d5 removes the cost                                                |
| `splice`, `sort` and other native array methods notify once per internal write        | Silent                              | `batch()`                                                                     |
| The "controlled inputs may lose caret position" gotcha                                | Goes away                           | —                                                                             |

The first row is the only silent semantic change, and it affects every `subscribe` user. It is the change #1177 asked for, so the migration guide should lead with it.

Runtime messages:

1. `notifyInSync has been removed. subscribe() is synchronous. Use batch() to group notifications, or subscribeInAsync() from valtio/utils.`
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
  - a thrown error
  - the return value
  - unsubscribing during the batch
  - `snapshot()` inside the batch
  - one callback with every op, in order
- `subscribeInAsync` coalesces a burst into one callback, and is silent after unsubscribing.
- Every removed argument throws its message.
- Each `proxyMap` and `proxySet` method notifies once, with the index and data already consistent.
- `devtools` sends one message per burst.

## Docs

- `api/advanced/subscribe.mdx`: synchronous delivery, `batch`, `subscribeInAsync`.
- New pages for `batch` and `subscribeInAsync`.
- `how-tos/some-gotchas.mdx`: remove the controlled-input caret section, since updates are always synchronous.
- The v3 migration guide.

## Open questions

1. Should `batch(fn)` return `fn`'s result? Proposed: yes.
2. If a callback throws during a flush, should the rest still run, with the first error rethrown afterwards? Proposed: yes, so that one failing subscriber doesn't silence the others.
3. Should `subscribeInAsync` keep the two-argument signature for now? Proposed: yes. d2 can add `{ keys }` to it along with `subscribe`.
