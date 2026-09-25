# v3 subscription

Status: proposal, revised after review on the design PRs. Nothing here is implemented as the agreed design.

The implementation will land on `v3-o1-subscription` and merge into `v3`. This document is only the proposal. The goal is fast in-place updates for large state. A break should show up as a TypeScript error or a runtime error when that is practical.

## Problem

Two updates look similar and are not:

```js
state.nested.count = 1
state.nested = { count: 1 }
```

The first writes one property. The second replaces a subtree. v2 spends the same kind of work on both: every `useSnapshot` on an ancestor subscribes to the whole proxy, and `proxy-compare` decides whether that component's reads changed.

[Discussion 1160](https://github.com/pmndrs/valtio/discussions/1160) is N components each doing `useSnapshot(items)[id]`. That cost is three separate things:

1. **Fan-out.** One item write wakes every subscriber of the parent.
2. **Who subscribes.** A component that called `useSnapshot(items)` and read one id still listens to the whole object.
3. **Building the snapshot.** The one component that does wake calls `snapshot` on the wide node and copies every key.

(1) and (2) are this branch. (3) is not. On the existing subscription candidate, `snapshot(root)` is about 4.3 ms at 5,000 keys and about 89 ms at 50,000, and almost all of that is the copy. The version walk is the small part. Lazy parent links, below, remove the walk. They do not remove the copy.

Where the hook is called decides the rest. If each item calls `useSnapshot(state.items[id])` and the list parent only reads `Object.keys`, an item write snapshots that item and the list parent stays quiet. That is O(depth + one item), and the docs should recommend it for large collections. The root-hook pattern, `useSnapshot(state).items[id]`, still pays the wide copy once per write.

Skipping that copy means the value a render read stays live. A later read then sees a newer value, with no TypeScript or runtime error. That is a follow-up, with its own migration note, if a profile of the root-hook pattern still shows the copy.

[PR 1161](https://github.com/pmndrs/valtio/pull/1161) is where the "O(1)" name comes from. [Discussion 1177](https://github.com/pmndrs/valtio/discussions/1177) is the v3 list this branch follows. [Issue 1162](https://github.com/pmndrs/valtio/issues/1162) is the other side: after `state.nested = { count: 0 }` while `count` is already `0`, v2 skips the render, and the next `state.nested.count++` must still be visible.

## Proposal

`valtio/vanilla` grows per-key listeners and a subtree listener that registers in O(1). `valtio/react` subscribes only to what the committed render read, and re-renders when one of those subscriptions fires. It does not compare leaves.

`valtio/vanilla` does not know about React. `valtio/react` is built on public vanilla `subscribe`, `snapshot`, and `isProxyObject`. `proxy-compare` is removed. That also removes the vanilla dependency that existed so React could track snapshots.

Compatibility with `valtio-reactive` is out of scope.

## Vanilla listeners

Each proxy has:

- subtree listeners
- direct-key listeners
- an own-keys listener

A direct-key listener hears `set` and `delete` of that key on that object. It does not hear a sibling, and it does not hear a write under a child. An own-keys listener hears an own key added, removed, or reordered. It does not hear a value write. A subtree listener hears every write in the subtree.

Registering any of the three is O(1). A subtree listener does not attach itself to current children at subscribe time. Each proxy records its parents the first time something needs the subtree: `snapshot`, `getVersion`, or a subtree `subscribe`. A write then walks that parent chain. The first snapshot already pays for the linking pass. Listeners left on a replaced child stay silent. The render that hears the parent key drops them.

`set` of an `Object.is` value notifies nobody. `delete` of a missing own property notifies nobody. An index write that changes `length` notifies that index and `'length'`. Replacing a child notifies the parent key, the parent's own-keys listener, and the parent's subtree listeners.

```js
subscribe(proxyObject, callback)
subscribe(proxyObject, callback, { keys, ownKeys })
```

`keys` are direct properties of `proxyObject`. One registration can name several keys. `ownKeys: true` adds the own-keys listener. The callback runs synchronously. The third-argument boolean throws:

`notifyInSync has been removed. subscribe() is synchronous. Use batch() to group notifications, or subscribeInAsync() from valtio/utils.`

`subscribeKey` becomes this primitive plus an `Object.is` filter on the property value. A nested write that keeps the same property identity still does not call the `subscribeKey` callback. `subscribeKey` stays in utils. React cannot use it, because the `Object.is` filter hides an `undefined` property appearing or disappearing, and because React must not depend on utils for the primitive it subscribes with.

### Versions

`getVersion(proxy)` stays one argument. It is the subtree version: it changes exactly when `snapshot(proxy)` would. This branch does not add `getVersion(proxy, key)`.

React does not use `getVersion` for the gap check. A container records the snapshot object the render saw, and the check is `snapshot(child) === seen`. A version taken at read time can already include a write that the held snapshot does not show, so comparing versions would miss it. `snapshot(child)` is a cache hit when the child is unchanged. A per-key clock is the same information as the leaf and path checks, plus a new public argument.

### `batch`

Sync notifications and `batch` land in `v3` before the subscription commit, as their own PR if that is easier to review. On-demand subscription does not depend on them. They go together because the boolean third argument of `subscribe` is the slot `{ keys }` uses, and a later major is the wrong time to remove `notifyInSync`.

```js
batch(() => {
  state.a = 1
  state.b = 2
})
```

State updates inside `batch` are visible to later reads immediately. Subscription callbacks run once, after the outermost `batch` returns. Nested `batch` calls join the outer one. Ops for one subscription are concatenated.

`subscribeInAsync` in `valtio/utils` is the old default: coalesce one subscription into a microtask. Devtools uses it so one burst of writes is one Redux DevTools message. It belongs in that same sync-notification change.

`proxyMap` and `proxySet` call `batch()` around one logical change and flush only after the index and the data are both updated. Listeners snapshot at the end of `batch`, so an `epoch` bump after the flush would be invisible to that snapshot.

Native `splice` and `sort` keep notifying per internal write. A `get` trap on every array read, only to detect those methods, is the wrong cost. Callers that need one notification wrap the call in `batch()`.

### `isProxyObject` and `unstable_isRef`

Both land in the subscription branch.

```js
isProxyObject(value) // boolean, stable
unstable_isRef(value) // boolean
```

`isProxyObject` is a `proxyStateMap` lookup. It does not allocate a version and it does not walk children. `getVersion(proxy) !== undefined` stays a version read, not the supported predicate. Snapshots, plain objects, and ref'd non-proxies are `false`. A proxy passed through `ref()` is still a proxy: `isProxyObject` is `true` and `unstable_isRef` is `true`.

`unstable_isRef` reads the current global ref mark. The name stays unstable because scoped ref ([#1230](https://github.com/pmndrs/valtio/issues/1230)) is not in this branch and may change what "is a ref" means.

## Snapshots

Snapshots stay plain objects with the original prototype. Data properties are non-writable. Own getters are copied as accessors and run on each read, with the snapshot or the tracking proxy as `this`. Results are not cached. Own setters are omitted. `Object.preventExtensions` stays out, for Hermes ([#1220](https://github.com/pmndrs/valtio/pull/1220)).

A getter that reads `state.count` through a closure reads live state and is not tracked. That is a migration note. There is no dev warning in this branch: it also fires for a getter that really has no dependencies, and computed helpers are out of scope.

Every snapshot object carries a non-enumerable, non-exported symbol. Assigning a snapshot into a proxy throws, including during `proxy()` initialization:

`Cannot assign a Valtio snapshot into a proxy. Mutate the proxy in place, or copy it with deepClone() first.`

`proxy(snapshot)` throws the same way. On v3 today that call is already not a usable proxy: a top-level write is dropped, and `proxy(snapshot).nested.count = 2` throws `Cannot assign to read only property`. Copying would be new behavior. `deepClone` strips the symbol and returns a value that can be passed to `proxy`.

The tracking proxy forwards symbol keys. It records an enumerable symbol, because symbol keys are state (`tests/vanilla/proxy.test.ts`). It does not record a non-enumerable own symbol. That covers the brand, so the `in` check during assignment does not become a subscription. `deepClone` and `applyChanges` read the symbol from `unstable_getInternalStates`. It is not a public export.

`ref(snapshot)` stays allowed, for storing history.

## `applyChanges`

```js
applyChanges(state.nested, next)
```

`next` may be a plain object, an array, or a `snapshot()`. No snapshot symbol is required. `applyChanges` never stores `next`. The first argument must satisfy `isProxyObject`. `applyChanges(snapshot(state), next)` throws.

For each own enumerable key of `next`:

- Skip when `Object.is` holds. Also skip when `next`'s value is a snapshot and `snapshot(current) === next`'s value, so an unchanged subtree of an immutable update is O(1).
- Skip accessors. A snapshot of state that has getters carries them, and the proxy already has its own. `applyChanges(state, snapshot(state))` has to work. Accessors are not deleted either.
- Throw when the value is a `proxyMap` or `proxySet` snapshot, and tell the caller to build a new collection from the entries. A clone would keep methods that close over the source index.
- Recurse when the current value is a proxy and both sides share a prototype.
- Otherwise build a plain object or array by recursing into a fresh object. Input objects are not adopted as proxy targets. A snapshot nested inside new data would hit the brand error on the way through `set`.
- `deepClone` any other snapshot. The clone keeps the prototype, shares `ref` values, and drops the brand.
- Assign anything else the way `set` would. A `Date`, a `ref`, a class instance, or a live `proxyMap` stays the caller's object.

Missing own data properties are deleted. The writes run inside `batch()`.

## Collections

`proxyMap` and `proxySet` are in this branch for two reasons beyond `batch()`.

v3 keeps the copied index in a `WeakMap` keyed by the receiver. `size` registers it under the snapshot, then `get` on a wrapper misses and uses the live index. React's tracking proxy is that wrapper. A kept tracked map can report `size === 1` and `get('a') === undefined` after a later write. The same miss happens for `new Proxy(snapshot(map), {})`.

The index lives in the collection as a proxied lookup, the approach from `v3-o1-subscription-versioned-index`, with the global `lookup.version` read removed. A snapshot then carries its own lookup, and a wrapper reads it by property access. That needs no `WeakMap` keyed by `this` and no special case in `snapshot`.

`lookup`, `data`, and `index` stay non-enumerable, so they do not appear in `Object.keys` or a spread of the collection. `has(k)` and a missing `get(k)` read that key's lookup entry. A present `get(k)` also reads `data[i]`. A value-only `set` writes `data[i]` only, so `has` readers stay quiet. Object keys use enumerable symbols on the lookup. Iteration has to walk those symbols. `Object.keys` on the lookup would miss them.

A structural change copies the lookup on the next snapshot, which is the same order as copying `data`. Writes to the lookup go through the proxy, so listeners see them. The branch's `lookup.version` read is what made every lookup subscribe to every structural change. It stays out.

`proxy(proxy(x))` stays a distinct wrapper.

## React

`useSnapshot(proxy)` takes no options. An extra argument throws: `useSnapshot() no longer accepts an options argument. Updates are synchronous.`

The tracking proxy records reads during render and does not subscribe. `useSyncExternalStore`'s `subscribe` is a stable function. The hook installs and drops listeners in its own layout effect, from the records of the render that committed. A render that never commits never subscribes. Strict Mode's extra render, an aborted render, and a suspended render do not need a finalization registry.

| Read | Recorded at read time | Subscription |
| --- | --- | --- |
| nothing | | none |
| `tracked.count` when the value is not a child proxy | the value | key `count` |
| `tracked.nested.count` | the child proxy at `nested`, and the value of `count` | key `nested` on the parent, and key `count` on that child |
| `tracked.nested` and no property of it | the child snapshot | key `nested` on the parent, and a subtree listener on the child |
| `trackKey(tracked.obj)` while also reading a leaf | the child snapshot, plus the leaf | subtree listener on `obj`, plus the leaf's key |
| getter | the reads it makes through `this` | those reads, not the owning object |
| `'k' in tracked`, `hasOwn` | whether the key is present | key listener for `k` |
| `Object.keys`, `for...in` | the own-key list | `{ ownKeys: true }` |
| object spread | the own-key list and each value | `{ ownKeys: true }` and a key listener per own key |

`for...in` also walks enumerable prototype keys. The listener is own keys only. Prototype changes are out of scope.

The parent key in `tracked.nested.count` is what makes replacement work. `state.nested = { count: 1 }` notifies `nested`. The component re-renders and subscribes to `count` on the new child. `state.nested.count = 1` notifies `count` only. A sibling write notifies neither.

`trackKey(node)` is the migration for proxy-compare's `trackMemo(node)`. It marks that tracked node as a container and returns it. Reading `t.obj.x` must not subscribe to the rest of `obj`, or a leaf reader wakes up on siblings. An object read with no further key only covers the call sites that do not also read a leaf. `useEffect(..., [tracked.obj])` after `trackMemo` is the call site that does both. `useDebugValue` lists the recorded keys.

An accessor is not value-compared. An object-returning getter has a new identity on each access, so comparing it would re-render on every check. The subscription is the reads the getter makes through `this`.

No read installs no listener. `useSnapshot(state.obj)` used only as a boolean does not re-render.

Reads from children in the same pass, before this hook's layout effect, belong to this render's records. A later read on the same tracked proxy is a late read: a memoized child that renders on its own, an effect, or an event handler. React has no public way to tell those apart. A microtask subscribes a late read and runs the same check. Late reads only add subscriptions. The next commit of this hook rebuilds the set from that render's reads, so a key read only in a handler costs at most one extra render and is then dropped.

The microtask subscribes only for a hook that has committed. A read during a render that is still in progress is part of that render's records, and a render that never commits leaves no listener. Same-pass children are that case. The microtask is for a read that happens after the layout effect.

### `getSnapshot`

`getSnapshot` returns the snapshot reference the render used, until a recorded listener fires. It then calls `snapshot(root)` and replaces the held reference. Returning `snapshot(root)` on every call would change identity whenever the root version moves, so React's consistency check would re-render on an unrelated write and pay the wide copy.

Keys from earlier commits are already listening through this render. Two writes happen before the new keys have a listener, and the layout effect handles them after it installs the new keys:

- A child layout effect runs before the parent's, so it can write a key this render read for the first time.
- A layout effect registered before `useSnapshot` in the same component runs first for the same reason.

The check compares only those newly recorded facts, against the raw proxy:

- a leaf value, with `Object.is`
- a path, by whether `P[k]` is still the child proxy recorded at read time
- a container, by whether `snapshot(child) ===` the snapshot the render saw
- presence, for `in` and `hasOwn`
- own keys, by the key list

The comparison does not read through the tracking proxy, and it does not compare a snapshot object with a proxy. Those two are unequal even when nothing was written. A write that has been reverted to the recorded value leaves the rendered output unchanged, so the check ignores it.

If any new record moved, the layout effect notifies the store subscription. That update is flushed before paint. A layout effect registered after `useSnapshot` writes into a listener that is already installed, so the listener sees it directly.

Already-subscribed keys are not part of this comparison. Their listeners are the check. An unrelated key does not change the recorded facts and does not fire those listeners, which is what stops a layout effect that writes some other key on every render from looping.

### The break against 1162

v2 does not re-render this:

```js
const tracked = useSnapshot(state)
tracked.nested.count
state.nested = { count: 0 } // count was already 0
```

The component then still has to see a later `state.nested.count++`. v2 does both by comparing leaves and keeping the subscription on the new child without rendering.

This design re-renders on the replacement, because the child proxy at `nested` changed. The render subscribes to the new child. The following increment works because of that render.

That extra render is the immutable replacement this branch does not optimize. `applyChanges(state.nested, next)` is the quiet path: equal leaves do not notify, and child identity is preserved when the shape matches.

`'count' in tracked` and `hasOwn` re-render when the value changes, because they use the key listener. v2 could ignore the value. `Object.keys` does not re-render on a value write.

These existing tests describe the v2 bailout and will change:

- `should not rerender if the leaf value does not change`
- `in` and `hasOwn` tests that ignore value-only writes

Enumeration tests that ignore value-only writes stay, because of `{ ownKeys: true }`. Tests that a leaf reader ignores a sibling, that a replaced object keeps receiving later writes, and that a suspended render keeps its previous subscriptions stay as correctness tests.

### Same snapshot, new snapshot

Records follow the snapshot identity that produced them, which is the v2 `affected` rule. The render writes them on an object that render created. Only the layout effect of the render that committed copies them into the subscribed set.

- A new snapshot starts a fresh read set. A component that stops reading `a` and reads `b` drops `a`.
- A React re-render that sees the same snapshot accumulates. A prop change or a local `setState` must not forget keys read on that snapshot.
- A suspended render does not replace the committed read set.

## Public API

From `valtio` / `valtio/vanilla`:

| Export | Status |
| --- | --- |
| `subscribe(proxy, callback, { keys, ownKeys }?)` | third argument is this options object; boolean removed |
| `batch(fn)` | added with the sync-notification change |
| `isProxyObject(value)` | added |
| `unstable_isRef(value)` | added |
| `getVersion(proxy)` | unchanged, one argument; React does not call it |

From `valtio/react`:

| Export | Status |
| --- | --- |
| `useSnapshot(proxy)` | options argument removed |
| `trackKey(proxy)` | added, replaces `trackMemo` |

From `valtio/utils`:

| Export | Status |
| --- | --- |
| `applyChanges(proxy, next)` | added |
| `subscribeInAsync(proxy, callback, options?)` | added with the sync-notification change |
| `subscribeKey` | implemented on `{ keys }`, `notifyInSync` argument removed |

Not added: a key argument on `getVersion`, a public snapshot symbol, a sentinel own-keys key, a `recursive` flag, scoped ref, a replacement for `unstable_replaceInternalFunction`.

## Out of scope

- the wide-node snapshot copy, and any tracked value that stays live after render
- `valtio-reactive` interop, including `effect` and computed caching
- a dev warning for closure getters
- scoped ref
- replacing `unstable_replaceInternalFunction`
- `use(store)`
- branded proxy types

## Migration that users can see

| v2 | v3 |
| --- | --- |
| `subscribe(proxy, cb, true)` | throws; `subscribe` is synchronous; use `batch` or `subscribeInAsync` |
| `useSnapshot(proxy, { sync: true })` | throws |
| `subscribeKey(proxy, key, cb, true)` | throws |
| `state.foo = snapshot`, `proxy(snapshot)`, or `state.foo = tracked` | throws; `deepClone` then `proxy`, or `applyChanges`, or `ref` |
| `useSnapshot` with no property read | no subscription and no re-render |
| replace a subtree whose read leaves are equal | re-renders; `applyChanges` to keep the child and skip equal leaves |
| `delete state.missing` when `missing` is not own | no notification |
| getter reads `state.count` through a closure | untracked; read through `this` |
| `trackMemo` from proxy-compare | `trackKey` |
| `Object.keys` / `for...in` on a list parent | still ignores value writes |
| `'k' in tracked` | also re-renders when the value changes |
| a key read only from an event handler | at most one extra render, then the subscription is dropped |
