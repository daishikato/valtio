# Valtio v3 O(1) Subscription — Design Proposal

**Status: proposal for maintainer review.** Nothing in this document is agreed, and nothing is implemented. It merges two agent drafts: this one and #2, which is now closed. Where the drafts disagreed, the review threads on #2 and #3 settled the point, and this document states the result.

**How to read it.** Start with [At a glance](#at-a-glance) and [Questions for you](#questions-for-you), which together fit on about two screens. The later sections give the detail for each layer, and the appendix holds the measurements.

## At a glance

The goal is fast atomic mutation. A write like `state.items[5].count++` should cost work proportional to that item's readers and ancestors, not to its siblings or to unrelated subscribers.

- **Vanilla**
  - `subscribe(p, cb, { keys, ownKeys })` listens to direct keys, or to own keys being added or removed.
  - A write pushes versions up to linked parents, so `snapshot()` stops walking the whole tree.
  - New exports: `batch`, `isProxyObject`, `unstable_isRef`.
- **React**
  - `useSnapshot` subscribes to the keys read against the committed snapshot: in its layout effect for reads made during render, and in a microtask for reads made later.
  - Keys read for the first time are checked against live state before paint.
  - There is no leaf comparison otherwise. React needs only `snapshot`, `subscribe` and `isProxyObject` from vanilla, and proxy-compare is removed.
- **Snapshots**
  - Getters are live, not cached.
  - Every snapshot carries an unexported brand, so assigning a snapshot into state, or calling `proxy(snapshot)`, throws with a hint.
- **Utils**
  - `applyChanges(proxy, next)` is the quiet path for replacing data.
  - `subscribeInAsync` keeps today's microtask delivery.
  - `proxyMap` and `proxySet` keep their index in state, which fixes stale reads through wrappers.
- **Delivery**
  - A precursor PR into `v3` makes notifications sync-only and adds `batch()`.
  - This branch then lands in eight reviewable commits.

## Questions for you

These are the decisions the design needs from you. Each one states the proposed answer.

1. **What "on-demand subscription" means.** The proposal reads it as "subscribe only to what a committed render read". Lazy parent links also remove the version walk. The wide-node snapshot copy stays; see Q2.
2. **The wide-node copy.** With `useSnapshot(state)` at the root, a write still copies the O(N) object that holds the items.
   - Proposed: accept this for now, and document the [item-hook pattern](#the-item-hook-pattern), which costs O(depth + one item) per write.
   - Removing the copy for the root-hook pattern is a follow-up with a silent behavior change ([Not proposed](#not-proposed-on-demand-materialization)).
3. **Breaking changes.** Each is proposed as listed in [Migration](#migration):
   - Replacing a read object with an equal one re-renders (#1162); `applyChanges` is the quiet path.
   - `'k' in snap` and `hasOwn` readers re-render when `k`'s value changes.
   - Getters are live and uncached. A getter that reads state through a closure is untracked, documented only.
   - Assigning a snapshot into state, or calling `proxy(snapshot)`, throws.
   - A key read only in an event handler subscribes until the snapshot changes: at most one extra render, as in v2.
4. **New public API, for your strict review:**
   - vanilla: `subscribe` options, `batch`, `isProxyObject`, `unstable_isRef`
   - utils: `subscribeInAsync`, `applyChanges`
   - react: `trackKey`
   - Also one new entry in `unstable_getInternalStates`, the brand, which `deepClone` and `applyChanges` need.
   - See [Public API](#public-api).
5. **Names:** `trackKey`, `ownKeys`, `subscribeInAsync`, `unstable_isRef`.
6. **Delivery:** should lazy parent links ship as their own PR first? They are vanilla-only, change no API, and make `snapshot()` faster today.
7. **Collections:** keep the index in state, following the `versioned-index` branch? This is proposed over a private-symbol copy of the index.
8. **Your remaining preferences**, major and minor.

**Assumptions from your earlier messages, to confirm:**

- `notifyInSync` goes away, with `batch()` added, preferably in a precursor PR merged into `v3` first.
- `isProxyObject` and `unstable_isRef` land in this branch.
- A `useSnapshot` that reads nothing may stop subscribing. That change is silent but harmless.
- Getter result caching may go, since `valtio-reactive` covers computed values.
- A symbol on snapshots is acceptable for the runtime migration error.
- valtio-reactive compatibility is ignored for now.
- Simple "re-render on any subscribed change" is preferred if the breaks it causes are uncommon.

## Goals and requirements

| #   | Requirement                                                                                            | Consequence for this design                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| R1  | A leaf write is cheap in the #1160 scenario: N item components, one item changes                       | Fan-out, change detection and version bookkeeping must all avoid O(N)                                           |
| R2  | A migrating v2 user notices breaking changes through a TypeScript or runtime error, for most use cases | Silent breaks are allowed only when harmless (extra renders) or rare (docs only)                                |
| R3  | `valtio/react` is built on `valtio/vanilla`; vanilla knows nothing about React                         | React uses public vanilla exports only, no `unstable_*` internals; vanilla never unwraps or marks React objects |

R3 fixes a v2 violation. `src/vanilla.ts` imports `markToTrack` and `getUntracked` from proxy-compare: it marks snapshots for React's tracking, and unwraps React's proxies on assignment.

`state.nested.count = 1` is the fast path. `state.nested = { count: 1 }` replaces a subtree and may cost more; `applyChanges(state.nested, { count: 1 })` is its fast path.

## The problem: where #1160's O(N) lives

The #1160 shape is N components, each rendering `useSnapshot(state).items[id].count`, and one write that changes one item.

A leaf write in that shape costs three separate things:

1. **Fan-out.** The write wakes every component subscribed to `items`.
2. **Subscription scope.** A component that read one item still listens to the whole object.
3. **The snapshot.** The component that wakes calls `snapshot(root)`, which walks every descendant's version and copies the N-key node.

Key subscriptions and on-demand subscription fix 1 and 2. Lazy parent links fix the walk in 3. The copy in 3 remains, and it is the larger part.

| Per leaf write                                 | v3 today (v2 design) | WIP candidate |
| ---------------------------------------------- | -------------------- | ------------- |
| Components woken                               | N                    | 1             |
| Write to commit, N = 1,000                     | 5.1 ms               | 3.6 ms        |
| Write to commit, N = 5,000                     | 25.4 ms              | 9.5 ms        |
| `snapshot(root)`, N = 5,000: version walk only | 0.30 ms              | 0.35 ms       |
| `snapshot(root)`, N = 5,000: walk + copy       | 4.1 ms               | 4.3 ms        |
| `snapshot(root)`, N = 50,000: walk + copy      | 82 ms                | 89 ms         |

These are medians of 15 writes, measured with vitest and jsdom on a React 19 dev build. The WIP candidate is the `versioned-index` branch. The walk-only row writes to an unrelated proxy, so only the global clock moves.

**Where the hook is called decides the rest.** The table below is analysis, not measurement; the [validation plan](#validation-plan) measures it.

| Per leaf write                                                                                                                           | v3 today                                                                        | This design                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| **Root hook:** each item calls `useSnapshot(state)` and reads `items[id].count`                                                          | N components woken, one O(N) copy                                               | 1 component woken, one O(N) copy       |
| **Item hook:** each item subscribes to its own key and calls `useSnapshot` on that item; the list parent reads `Object.keys(snap.items)` | 2 components woken; the list parent snapshots `items` (O(N)) and then bails out | 1 component woken, O(keys of one item) |

### The item-hook pattern

Calling `useSnapshot(state.items[id])` alone is not enough. After `state.items[id] = next`, the hook still listens to the detached proxy. The list parent doesn't hear the replacement either, because the key list is unchanged. The item then keeps rendering the old object. v3 has the same gap today.

The item also has to follow its key on the parent. With `{ keys }`, public APIs are enough, and no new export is needed:

```js
const useItem = (parent, key) => {
  const item = useSyncExternalStore(
    useCallback((cb) => subscribe(parent, cb, { keys: [key] }), [parent, key]),
    () => parent[key],
  )
  return useSnapshot(item)
}
```

- A leaf write wakes only that item's hook and snapshots only that item.
- Replacing `state.items[id]` wakes only that item, which switches to the new proxy.
- Adding or removing a key wakes the list parent through `{ ownKeys: true }`, which takes one O(N) snapshot of `items`.

The parent must not pass `snap.items[id]` without reading it. Under the container rule, that subscribes the parent to the whole item and wakes it on every leaf write.

## Delivery plan

**PR 1, a precursor into `v3`: sync-only notifications**

- Remove `notifyInSync` from `subscribe` and `subscribeKey`, and `sync` from `useSnapshot` and `useProxy`. Each removal is a TypeScript error, and passing the old argument also throws at runtime (messages in [Migration](#migration)).
- Add `batch(fn)` to vanilla and `subscribeInAsync` to `valtio/utils`. `devtools` switches to `subscribeInAsync`.
- `proxyMap` and `proxySet` wrap each method in `batch()`.
- Native `splice` and `sort` keep notifying once per internal write, and callers wrap them in `batch()`. Batching them automatically would need a `get` trap on every array read.

**PR 2, the `v3-o1-subscription` branch into `v3`.** Each commit passes the suite on its own:

1. Vanilla: `isProxyObject` and `unstable_isRef`. Utils use them instead of reading `unstable_getInternalStates`.
2. Vanilla: lazy parent links. This is a speed-up with no API change.
3. Vanilla: the `subscribe` options. `subscribeKey` is rebuilt on them, and deleting an absent key no longer notifies.
4. Vanilla: snapshot semantics, meaning live getters, the brand, and the assignment error. `deepClone` skips the brand.
5. Utils: collections keep their index in state.
6. React: the new tracker and `trackKey`, and removal of proxy-compare.
7. Utils: `applyChanges`.
8. Docs: migration guide, API pages, and the item-hook pattern for large collections, including replacement.

Tests from the WIP branches are ported into the commit whose behavior they cover.

## Vanilla

### Versions and lazy parent links

Every write takes one number from a global clock. A proxy's version is the latest write anywhere in its subtree, so it changes exactly when `snapshot(p)` would. `getVersion(p)` stays single-argument, and there are no per-key versions.

- **Linking.** A parent links to its children the first time something needs its subtree:
  - `snapshot(p)`
  - `getVersion(p)`
  - a subtree `subscribe(p)`

  That first pass is O(subtree), which the first snapshot pays anyway.

- **Writes.** After that, a write pushes its version to every linked ancestor, in O(depth × parents), and notifies their subtree listeners on the way. A `snapshot` of an unchanged subtree is a cache hit, and registering a subtree listener is O(1).
- **Children.** A child assigned into a linked parent is linked immediately. Replacing or deleting a child unlinks it.
- **Cycles and shared children** need only a visited set per write. Versions are pushed rather than recomputed, so the WIP branches' Tarjan-style pass is unnecessary.

The alternative is linking every child at creation. It only makes a difference for state that is never snapshotted or subscribed, which would then pay O(depth) per write for nothing.

### Listeners

```js
subscribe(p, callback) // any write in p's subtree
subscribe(p, callback, { keys: ['a', 'b'] }) // direct set or delete of a or b on p
subscribe(p, callback, { ownKeys: true }) // an own key of p added or removed
```

| Listener  | Fires on                                                                                    | Does not fire on                                      | Registration      |
| --------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------- |
| Subtree   | Any write in `p`'s subtree                                                                  | —                                                     | O(1) once linked  |
| `keys`    | A direct set or delete of a listed key, including implicit ones such as `length`            | Sibling keys; writes under a child                    | O(number of keys) |
| `ownKeys` | An own key added or removed, including an index that appears or disappears through `length` | Value writes; replacing a child under an existing key | O(1)              |

- `keys` and `ownKeys` combine in one call. React makes one registration per proxy it read.
- Every listener is synchronous. Inside `batch()`, it is deferred until the outermost `batch` returns and then runs once with the accumulated ops. State is visible to reads immediately; nested `batch` calls join the outer one.
- A same-value `set`, or a `delete` of an absent key, notifies nobody.
- Replacing `state.child` notifies `state`'s `child` key and its subtree listeners. The old child's own listeners stay silent, because it was detached rather than mutated.
- `subscribeKey(p, key, cb)` in utils becomes a key subscription plus its existing `Object.is` value filter, so existing callers see no change. A nested write under `p[key]` still doesn't call it, now because the key listener doesn't fire rather than because of the filter. That makes it O(1), the goal of #1161. React does not use it: the filter hides an `undefined` key appearing or disappearing.

### `isProxyObject` and `unstable_isRef`

- **`isProxyObject(x)`** is a boolean `proxyStateMap` lookup, and deliberately not a type guard. It allocates no version and walks no children.
  - It is false for snapshots, plain objects, and ref'd non-proxies.
  - A proxy passed through `ref()` is still a proxy, so both predicates are true for it.
- **`unstable_isRef(x)`** reads today's global ref mark. It stays `unstable_` because scoped `ref` could change what "is a ref" means.

## Snapshots

Snapshots stay plain objects with read-only data properties and their original prototypes. `Object.preventExtensions` stays out, for Hermes (#1220).

**Live getters**

- An own getter is copied to the snapshot as an accessor, not evaluated. Each access runs it with the snapshot, or React's tracked snapshot, as `this`. The reads it makes through `this` are React's subscription, so a root `get total()` does not subscribe to the whole store.
- Results are not cached, so an object-returning getter returns a new identity on each access. Exceptions surface on access, not in `snapshot()`.
- A getter that reads `state.count` through a closure reads live state and is not tracked. This is documented, with no dev warning, because a warning would also fire for getters that have no dependencies.
- Own setters are left out of snapshots. Class accessors on the prototype behave as today.

**The brand and the assignment error**

- Each snapshot object carries a non-enumerable own symbol, which is not exported. Spread, `Object.assign`, JSON and `structuredClone` do not copy it.
- `proxy(x)` and the `set` trap throw when the incoming object carries it:

  `Cannot assign a Valtio snapshot into a proxy. Copy it with deepClone(), merge it with applyChanges(), or wrap it with ref() to store it as is.`

- That covers:
  - `state.x = snap`
  - `state.x = { child: snap.y }`
  - `arr.push(snap)`
  - `map.set(k, snap)`
  - `proxy(snap)`
  - `state.x = tracked.y`
- `ref(snap)` stays allowed, for storing history.
- React's tracker forwards reads of a snapshot's non-enumerable own symbols without recording them, so the brand check never becomes a subscription. User symbol keys are enumerable and stay tracked, as in v2.
- `deepClone` skips the brand. It and `applyChanges` read the symbol from `unstable_getInternalStates()`.

On v3 today, these cases already fail silently:

- after `state.b = snap.a`, the write `state.b.count = 2` leaves `count` at 1
- `proxy(snapshot(state))` drops top-level writes, and a nested write throws `Cannot assign to read only property`

Read-only uses, such as storing a snapshot for display, did work, which is why the message names `ref`.

## Collections: `proxyMap` and `proxySet`

On v3 today, two problems interact with key subscriptions:

1. **A snapshot read through a wrapper uses the live index.** The index copy is looked up in a `WeakMap` keyed by `this`, and a wrapper misses it. React's tracker is such a wrapper. After later writes, `new Proxy(snapshot(m), {}).get('first')` returns `undefined` while `size` still reports the snapshot's count.
2. **Every `has()` reader re-renders on every `set()`.** `set()` bumps `epoch` even on a value-only update, and `has()` reads `epoch`.

The proposal follows the `versioned-index` branch: the index lives in state, as a proxied lookup with one entry per key. A snapshot then carries its own lookup, and any wrapper reads it by ordinary property access. This needs no `WeakMap` keyed by `this` and no special case in `snapshot`.

- `has(k)` and a missing-key `get(k)` read that key's lookup entry. A present-key `get(k)` also reads `data[i]`.
- A value-only `set` writes only `data[i]`, so `has` readers and the list parent stay quiet.
- `size` reads a size entry. Iteration walks the slot entries (`slot → ref({ key })`), which keep Map insertion order across a delete and a re-add.
- Object keys map to per-object symbols on the lookup. These are enumerable, so the tracker records them like any user key.
- `lookup`, `data` and `index` are non-enumerable, so they don't appear in `Object.keys` or a spread of the collection.
- Lookup writes go through the proxy. The branch's global `lookup.version` read is dropped, because it made every lookup subscribe to every structural change.
- Cost: after a structural change, the next snapshot copies the lookup, which is the same order as copying `data`.

## React: `useSnapshot`

`useSnapshot(p)` takes no options, and returns a tracking proxy over a held snapshot `S` of `p`. Reads are recorded per snapshot. The hook's layout effect turns the committed snapshot's records into subscriptions and checks the newly read ones against live state.

### What a read records

Each tracked node wraps a snapshot object `Sₙ` and is bound to the live proxy `Pₙ` it stands for; the root is bound to `p`. A child binds to the live `Pₙ[k]` when `isProxyObject` holds for it. Otherwise the child is a leaf and is returned as is. Binding follows the live path, so there is no snapshot-to-source registry, and the check below makes a stale binding harmless.

| Read on node `(Sₙ, Pₙ)`                                   | Record                                              | Subscription        | Check for a newly read record |
| --------------------------------------------------------- | --------------------------------------------------- | ------------------- | ----------------------------- |
| `t.k`, own data value, or a missing key                   | Leaf: the snapshot value seen, or `undefined`       | Key `k` on `Pₙ`     | `Object.is(seen, Pₙ[k])`      |
| `t.k`, an object bound to `C = Pₙ[k]`                     | Path to `C`                                         | Key `k` on `Pₙ`     | `Pₙ[k] === C`                 |
| `t.k`, an accessor, own or inherited                      | Nothing for `k`; the getter runs with `t` as `this` | Its reads' records  | Its reads' checks             |
| `t.k`, an inherited non-accessor, such as `map`           | Nothing                                             | —                   | —                             |
| `'k' in t`, `Object.hasOwn(t, k)`                         | Presence seen                                       | Key `k` on `Pₙ`     | Same presence on `Pₙ`         |
| `Object.keys(t)`, `for...in`                              | Own-key list seen                                   | `{ ownKeys: true }` | Same list on `Pₙ`             |
| A bound node with no reads under it, or `trackKey(t.obj)` | Container: the snapshot seen                        | Subtree on `C`      | `snapshot(C) === seen`        |
| A snapshot's non-enumerable own symbol, such as the brand | Nothing                                             | —                   | —                             |

- **Seen values.** A record holds what the render saw from the snapshot, never a read of live state at that moment. A re-render caused by a prop change reuses the held snapshot, which may already be behind live state for keys nobody has subscribed to yet.
- **Spread, `Object.entries` and `JSON.stringify`** list the own keys and then get each value, so they record the key list plus one leaf or path per value.
- **Containers.** The "no reads under it" rule gives v2's identity semantics to a node that is only passed on, such as an effect dependency, or a prop to a memoized child that never rendered against this snapshot.
- **The container check** uses snapshot identity rather than `getVersion(C)`. A version read at render time can already include a write the held snapshot doesn't show. `snapshot(C)` is a cache hit when `C` is unchanged.
- **`trackKey(t.obj)`** forces a container record for `t.obj` and returns it. It is a drop-in for proxy-compare's `trackMemo(t.obj)`, where a component reads `t.obj.x` but also depends on the identity of `t.obj`.
- **Accessor keys** are never value-compared. An object-returning getter has a new identity on each access, so comparing it would re-render forever.
- **Tracked proxies** are cached per hook by snapshot object. An unchanged subtree keeps its identity across renders, so `memo` bails out.
- **Dev builds** list the recorded keys with `useDebugValue`.
- **A render that reads nothing** subscribes to nothing.

### Records are kept per snapshot

Every tracked node belongs to one root snapshot `S`. A read from any component goes into the record set for `S`. The set grows while `S` is the held snapshot, and a new snapshot starts an empty set.

- **A re-render on the same snapshot**, from a prop change or local state, keeps the keys read earlier. That includes keys read by memoized children that bail out this time.
- **A late read** is a read into a set that is already installed. Examples:
  - a child that calls no valtio hook and re-renders on its own
  - an effect
  - an event handler
  - a render on the committed snapshot that never commits
- **A render that took a new snapshot** records into that snapshot's set, which is installed only if the render commits.

### Commit: reconcile, then check

A layout effect in the hook runs after every commit. It does two things:

1. **Reconcile.** Install the set for the committed snapshot and remove subscriptions that are not in it. This is O(changed records), and key and own-key records are grouped into one `subscribe` call per proxy.
2. **Check** the records that were not installed before this commit. If one fails, mark the held snapshot stale and schedule a sync re-render, which React processes before paint.

Why this is enough:

- **Records installed by an earlier commit** were listening all along, so a write to them has already marked the snapshot stale.
- **Newly read records** are covered by the check. It runs after the children's layout effects, and after layout effects declared before `useSnapshot` in the same component. A write from any of those to a key read for the first time is therefore on screen before paint. Layout effects declared after `useSnapshot` write into listeners that are already installed.
- **A render that never commits** leaves nothing behind if it took a new snapshot. If it reused the committed snapshot, as Strict Mode's extra render or a suspended transition can, its reads are late reads. Every listener belongs to the mounted hook and is removed on unmount, so no finalization registry is needed.
- **A hidden `<Activity>`** drops all subscriptions. Showing it again reinstalls and checks every record, so writes made while it was hidden appear before the first paint.

After each commit, the held snapshot agrees with live state on every installed record. The check establishes this for new records, and listeners maintain it for the rest.

### Between commits

- **Listeners** mark the held snapshot stale and notify React. They go through `useSyncExternalStore`'s callback, or on mount, before that callback exists, through a state update.
- **`getSnapshot`** returns the held snapshot until it is stale, then takes `snapshot(p)` once. An unrelated write never changes what it returns, so React's consistency checks never copy the wide node.
- **Late reads** are subscribed in a microtask, which also runs the same check on them.
  - They only add subscriptions, and never narrow a container.
  - They are dropped when the snapshot changes.
  - React offers no public way to tell a render from an event handler, so a handler's read subscribes too. It costs at most one extra render: the next write to that key replaces the snapshot, and the new set drops the key. v2 behaves the same.

### Limits

- A write that is reverted before the check is missed. That is harmless, because the rendered value equals the live value.
- Values stored with `ref()`, and other non-proxied objects, compare by identity, so in-place mutation is invisible. This is the same as v2.
- An own property that later shadows an inherited one is not seen.

### Not proposed: on-demand materialization

React could stop calling `snapshot(p)` and instead read through views over live proxies, created per node on first read.

- **Gain.** A render would cost O(keys read), even with the root-hook pattern. The copy measured above disappears: 4.3 ms at N = 5,000 and 89 ms at N = 50,000.
- **Cost.** Views are not snapshots. A tracked value read in an event handler after a later write would return the newer value, where v2 returns the render-time value. That change is silent, so it needs its own R2 decision.
- **A cheaper eager copy** only changes constants. A plain `{ ...prev }` of a 50,000-key object takes 27 ms.

This needs no vanilla API beyond this proposal's, so it can be a follow-up.

## `applyChanges`

`applyChanges(proxy, next)` in `valtio/utils` merges `next` into an existing proxy, writing only what differs, inside one `batch()`.

- `next` can be plain data, a vanilla snapshot, or a React tracked snapshot.
- The first argument must be a proxy, so `applyChanges(snapshot(state), next)` throws.

For each own enumerable key of `next`, where `cur = proxy[k]` and `v = next[k]`:

1. Skip `v` if `Object.is(cur, v)`, or if `v` is a snapshot and `snapshot(cur) === v`. The second test skips unchanged subtrees of an immutable update in O(1).
2. Skip accessors. Snapshots of state with getters carry them, and the proxy already has its own. This keeps `applyChanges(state, snapshot(state))` working.
3. Throw on a `proxyMap` or `proxySet` snapshot, and suggest building a new collection from its entries. A clone would keep methods that close over the source's index.
4. Recurse if `cur` is a proxy and `v` is an object with the same prototype.
5. Build any other plain object or array by recursion into a fresh object. Input objects are never adopted as proxy targets, so a snapshot nested at any depth never reaches the `set` trap. Example: `[...snap.todos, { title: 'new', tags: snap.template.tags }]`.
6. Assign any other snapshot as a `deepClone`, which keeps its prototype, shares `ref` values and drops the brand.
7. Assign everything else as a normal `set` would, so a `Date`, a `ref`, a class instance or a live `proxyMap` stays the caller's object.

Then delete own data properties absent from `next`; accessors are never deleted.

A tracked snapshot passed as `next` from an event handler records late reads, and so can cause one extra render. The docs recommend `snapshot(state)` there.

## Public API

**`valtio` / `valtio/vanilla`**

| Export                       | Change                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `subscribe(p, cb, options?)` | The boolean third argument throws; `{ keys, ownKeys }` replaces it                  |
| `batch(fn)`                  | New, in PR 1                                                                        |
| `isProxyObject(x)`           | New                                                                                 |
| `unstable_isRef(x)`          | New                                                                                 |
| `getVersion(p)`              | Unchanged, single argument; React no longer calls it                                |
| `unstable_getInternalStates` | Gains the snapshot brand, for `deepClone` and `applyChanges`; other contents change |

**`valtio/react`**

| Export                                | Change                                                |
| ------------------------------------- | ----------------------------------------------------- |
| `useSnapshot(p)`                      | The options argument throws; proxy-compare is removed |
| `trackKey(node)`                      | New; replaces proxy-compare's `trackMemo(node)`       |
| `useProxy(p)` in `valtio/react/utils` | The `sync` option throws                              |

**`valtio/utils`**

| Export                           | Change                                                  |
| -------------------------------- | ------------------------------------------------------- |
| `applyChanges(proxy, next)`      | New                                                     |
| `subscribeInAsync(p, cb, opts?)` | New, in PR 1; today's microtask-batched delivery        |
| `subscribeKey(p, key, cb)`       | Built on `{ keys }`; the `notifyInSync` argument throws |

**Not added:**

- `getVersion(p, key)`
- a public snapshot symbol
- a sentinel key for own keys
- a `recursive` flag
- snapshot-to-source registries
- notifications to detached subtrees

## Migration

| v2 → v3 change                                                             | Detection                                  | Remedy                                       |
| -------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| `subscribe(p, cb, true)`, `subscribeKey(…, true)`                          | TypeScript error; runtime error (1)        | Drop it; use `batch()` or `subscribeInAsync` |
| `useSnapshot(p, { sync })`, `useProxy(p, { sync })`                        | TypeScript error; runtime error (2)        | Drop it                                      |
| A snapshot or tracked snapshot assigned into state, or passed to `proxy()` | Runtime error (3)                          | `deepClone`, `applyChanges`, or `ref`        |
| An own setter called on a snapshot                                         | Runtime `TypeError` in strict mode         | Write to the proxy                           |
| `Object.freeze` on a snapshot, then `useSnapshot`                          | Runtime error                              | Don't freeze snapshots                       |
| A getter reads state through a closure (`state.count`)                     | Docs                                       | Read through `this`                          |
| Snapshot getters aren't cached; object results get a new identity          | Docs                                       | `proxy-memoize` or `valtio-reactive`         |
| `trackMemo` and `getUntracked` from proxy-compare                          | Docs                                       | `trackKey`; read the proxy in callbacks      |
| Replacing a read object with equal leaves re-renders                       | Silent, harmless                           | `applyChanges`                               |
| `'k' in snap` and `hasOwn` re-render on value writes                       | Silent, harmless                           | —                                            |
| A key read only in an event handler                                        | Silent, harmless: at most one extra render | Read the proxy in callbacks                  |
| `useSnapshot` with no reads no longer subscribes                           | Silent, harmless                           | Read what you render                         |
| Deleting an absent key no longer notifies                                  | Silent, harmless                           | —                                            |

Runtime messages:

1. `notifyInSync has been removed. subscribe() is synchronous. Use batch() to group notifications, or subscribeInAsync() from valtio/utils.`
2. `useSnapshot() no longer accepts an options argument. Updates are synchronous.`
3. `Cannot assign a Valtio snapshot into a proxy. Copy it with deepClone(), merge it with applyChanges(), or wrap it with ref() to store it as is.`

The closure-getter row is the riskiest, because v2's computed-properties guide itself used `state.count` inside getters. The guide has to change in the same release.

## Tests

**Existing `v3` tests that change.** This list comes from reading the suite; an implementation will confirm it.

| Test                                                                     | Cause                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `optimization`: "should not rerender if the leaf value does not change"  | Equal-leaf replacement re-renders                      |
| `optimization`: "should track property existence with the in operator"   | A value-only write re-renders an `in` reader           |
| `optimization`: "should track own-property checks"                       | A value-only write re-renders a `hasOwn` reader        |
| `optimization`: "should unwrap nested snapshots assigned outside render" | The assignment now throws                              |
| `getter`: "simple object getters", "object getters returning object"     | The getter runs on every access, not once per snapshot |
| `vanilla/snapshot`: proxy-compare interop                                | proxy-compare is removed                               |
| Tests passing `notifyInSync` or `{ sync: true }`                         | They drop the argument                                 |

**Existing tests the design relies on**, which keep passing:

- "should track property enumeration"
- "should retain keys accessed before a prop change"
- "should detect a new-key mutation before passive subscription"
- "should keep committed subscriptions during a suspended render"
- "should grow committed subscriptions during a suspended render"

### Validation plan

Each item becomes a test in the commit it covers.

- **#1160 benchmark**, committed this time. It covers both component patterns at N = 1,000, 5,000 and 50,000, and reports components woken, write-to-commit time, and `snapshot` calls per write.
- **Render→commit gaps.** A child's layout effect, and a later sibling's, each write a key first read in this render. Both writes are in the DOM before the passive phase.
- **Renders that never commit**: Strict Mode, an interrupted transition, and a render that suspends. A render that took a new snapshot leaves no listener behind. A render on the committed snapshot adds only late reads, which are dropped when the snapshot changes.
- **Item-hook pattern**: replacing `state.items[id]` updates that item, and a leaf write wakes neither the list parent nor other items.
- **`<Activity>`**: hide, write, show. The first visible commit has the new value.
- **Memoized children.** Cover three cases, and no update may be missed in any of them:
  - reads in the same pass
  - a later render of the child alone that reads new keys
  - a parent re-render in which the child bails out
- **Event-handler reads**: at most one extra render, then the key is dropped with the snapshot.
- **Precision:**
  - A list parent stays quiet on item value writes.
  - `in` on a missing key re-renders when the key is added.
  - A getter re-renders only on its `this` reads.
  - An object-returning getter does not loop.
- **Brand**: every assignment path above throws; `ref(snap)` and `proxy(deepClone(snap))` work.
- **`applyChanges`:**
  - Equal leaves stay quiet.
  - One notification per call.
  - The identity skip works.
  - Accessors are skipped.
  - A collection snapshot throws.
- **Collections**: `get`, `has` and `size` agree through a wrapper after later writes, and a value-only `set` leaves `has` readers quiet.
- **Bundle**: report minified and gzipped sizes against `v3` plus proxy-compare (6,188 / 2,985 B) and the WIP candidate (10,533 / 4,431 B).

## Out of scope

- The wide-node snapshot copy for the root-hook pattern, and any tracked value that stays live after render
- Getter result caching; computed values belong to `valtio-reactive`
- `valtio-reactive` interop
- A dev warning for closure getters
- Scoped `ref`
- A replacement for `unstable_replaceInternalFunction`
- `use(store)`
- Branded proxy types

## Appendix: evidence and references

All measurements ran in this session's container: Node 22.22.2, vitest 4.1.5 with jsdom, and a React 19.2.5 dev build. `v3` is `fb594a1`; the WIP candidate is `v3-o1-subscription-versioned-index` at `1fec378`. The benchmark code is not committed yet; the validation plan commits it.

| Finding                                                                             | Result                                                                                               |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Version checks per `snapshot(root)` over 1,000 items, after an unrelated root write | 1,002 on both `v3` and the candidate                                                                 |
| Key listeners registered per render by the candidate's `useSnapshot`                | Re-registered on every render; `v3` registers its listeners once                                     |
| v2 (`main`): `state.b = snap.a; state.b.count = 2`                                  | `count` stays 1, no error                                                                            |
| `v3` `proxyMap`: `new Proxy(snapshot(m), {}).get('first')` after later writes       | `undefined`, expected 1                                                                              |
| Copying a 50,000-key node                                                           | 89 ms full snapshot; 38 ms per-key copy loop; 27 ms plain `{ ...prev }`                              |
| Bundle, minified / gzipped                                                          | Candidate 10,533 / 4,431 B, no dependencies; `v3` 3,561 / 1,734 B plus proxy-compare 2,627 / 1,251 B |

**Sources**

- [#1160 — useSnapshot is O(N) for a big Map](https://github.com/pmndrs/valtio/discussions/1160)
- [#1161 — O(1) subscribeKey and useSnapshot (closed PR)](https://github.com/pmndrs/valtio/pull/1161)
- [#1162](https://github.com/pmndrs/valtio/issues/1162): after an equal replacement, a later write must still render
- [#1177 — Ideas for v3](https://github.com/pmndrs/valtio/discussions/1177)
- [#1220 — remove `Object.preventExtensions` for Hermes](https://github.com/pmndrs/valtio/pull/1220)
- WIP branches: [baseline](https://github.com/pmndrs/valtio/tree/v3-o1-subscription-baseline), [proxied-index](https://github.com/pmndrs/valtio/tree/v3-o1-subscription-proxied-index), [versioned-index](https://github.com/pmndrs/valtio/tree/v3-o1-subscription-versioned-index)
- [jotai-valtio 0.6.0](https://www.npmjs.com/package/jotai-valtio): `src/atomWithProxy.ts` in the published package, including its `applyChanges`
- Review threads: [#3](https://github.com/daishikato/valtio/pull/3) and [#2](https://github.com/daishikato/valtio/pull/2)
