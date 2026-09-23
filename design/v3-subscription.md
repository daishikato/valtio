# v3 subscription

Status: proposal. Nothing in this document is implemented as the agreed design.

The implementation will land on `v3-o1-subscription` and merge into `v3`. This document is only the proposal. The goal is fast in-place updates for large state, with breaks that show up as a TypeScript error or a runtime error when that is practical.

## Problem

Two updates look similar and are not:

```js
state.nested.count = 1
state.nested = { count: 1 }
```

The first writes one property. The second replaces a subtree. v2 spends the same kind of work on both: every `useSnapshot` on an ancestor subscribes to the whole proxy, and `proxy-compare` decides whether that component's reads changed.

That loses on a large collection. [Discussion 1160](https://github.com/pmndrs/valtio/discussions/1160) is N components each doing `useSnapshot(items)[id]`. One item write wakes all N subscribers, and each subscriber compares. A per-key listener map makes the *notify* of one key O(1), and it still does not fix 1160 if every component registered a listener on the whole object.

1160 needs **on-demand subscription**: a listener is installed for a property only after a render reads it. The component that read `items[id]` is the only one notified when `items[id]` changes.

[PR 1161](https://github.com/pmndrs/valtio/pull/1161) is the source of the "O(1)" name. [Discussion 1177](https://github.com/pmndrs/valtio/discussions/1177) is the v3 list this branch follows. [Issue 1162](https://github.com/pmndrs/valtio/issues/1162) is the other side of the trade: after `state.nested = { count: 0 }` while `count` is already `0`, v2 skips the render, and the next `state.nested.count++` must still be visible.

## Proposal

Vanilla grows a per-key listener list and tells the truth about which object changed. React subscribes only to what the render read, and re-renders whenever one of those subscriptions fires. It does not compare leaf values.

`valtio/vanilla` does not know about React. `valtio/react` is built on vanilla `subscribe`. `proxy-compare` is removed, which also removes the vanilla dependency that existed for React's tracking.

Compatibility with `valtio-reactive` is out of scope. `batch` below is defined for valtio itself.

## Vanilla

Each proxy has:

- whole-object listeners
- a map of direct-key listeners

A direct-key listener hears `set` and `delete` of that key on that object. It does not hear a sibling key, and it does not hear a write under a child. Whole-object listeners hear every direct change. They also hear descendant changes, because a whole listener attaches to current child proxies and the child calls the parent listener. Key listeners do not attach to children.

`set` of an `Object.is` value notifies nobody. `delete` of a missing own property notifies nobody. An index write that changes `length` notifies that index and `'length'`. Replacing a child object notifies the parent key and the parent's whole listeners. Listeners still attached to the abandoned child stay silent. The render that hears the parent key drops them.

```js
subscribe(proxyObject, callback)
subscribe(proxyObject, callback, { keys })
```

`keys` are direct properties of `proxyObject`. The callback runs synchronously. The third-argument boolean throws:

`notifyInSync has been removed. subscribe() is synchronous. Use batch() to group notifications, or subscribeInAsync() from valtio/utils.`

`subscribeKey` becomes this primitive plus an `Object.is` filter on the property value. A nested write that keeps the same property identity still does not call the `subscribeKey` callback.

### `batch`

```js
batch(() => {
  state.a = 1
  state.b = 2
})
```

State updates inside `batch` are visible to later reads immediately. Subscription callbacks run once, after the outermost `batch` returns. Nested `batch` calls join the outer one. Ops for one subscription are concatenated.

This is independent of on-demand subscription. React already folds store notifications into one render. The reason to include it here is the v3 break: the default microtask batch and the `notifyInSync` flag go away together, and a later major is the wrong time to do that again. Land it in this branch, in its own commit, and merge the branch into `v3`.

`subscribeInAsync` in `valtio/utils` is the old default: coalesce one subscription into a microtask. Devtools uses it so one burst of writes is one Redux DevTools message.

### `isProxyObject` and `unstable_isRef`

Both are in this branch.

```js
isProxyObject(value) // boolean, stable
unstable_isRef(value) // boolean
```

`isProxyObject` is a `proxyStateMap` lookup. It does not allocate a version and it does not walk children. `getVersion(proxy) !== undefined` stays a version read, not the supported predicate. Snapshots, plain objects, and ref'd non-proxies are `false`. A proxy passed through `ref()` is still a proxy: `isProxyObject` is `true` and `unstable_isRef` is `true`.

`unstable_isRef` reads the current global ref mark. The name stays unstable because scoped ref ([#1230](https://github.com/pmndrs/valtio/issues/1230)) is not in this branch and may change what "is a ref" means.

`getVersion` keeps a single argument. React does not need per-key versions if it does not compare leaves.

### Snapshot assignment

Snapshots carry a non-enumerable, non-exported symbol. Assigning a snapshot into a proxy throws, including during `proxy()` initialization:

`Cannot assign a Valtio snapshot into a proxy. Mutate the proxy in place, or copy it with deepClone() first.`

`proxy(snapshot)` copies the plain tree and proxies the copy, so existing `proxy(snapshot(state))` keeps working. `deepClone` strips the symbol and returns a value that can be assigned.

This is a migration error for `state.nested = useSnapshot(...)`. It is not required for `applyChanges`.

### `applyChanges`

```js
applyChanges(state.nested, next)
```

`next` may be a plain object, an array, or a `snapshot()`. No snapshot symbol is required.

`applyChanges` never stores `next`. It reads `next` and writes into the proxy that is already there. A snapshot of a plain object or array is itself a plain object or array whose nested proxies were copied into nested plain objects. Matching object and array children are merged in place. Equal leaves are skipped, so a key listener on an unchanged leaf does not run. Missing keys are deleted. A non-mergeable value (class instance, `Date`, ref, `proxyMap`) is assigned by identity.

The first argument must satisfy `isProxyObject`. `applyChanges(snapshot(state), next)` throws. That check is the proxy predicate, not a snapshot brand.

A symbol on the snapshot would not change this. `applyChanges` does not look for one. `Object.getOwnPropertyNames` does not see it. The merge decision is the prototype (`Object.prototype`, `Array.prototype`, or `null`), which is already what a snapshot of plain state has.

## React

`useSnapshot(proxy)` takes no options. An extra argument throws: `useSnapshot() no longer accepts an options argument. Updates are synchronous.`

The tracking proxy records reads during render. After the read, the hook subscribes only to those records. A notification re-renders the component. There is no `isChanged` and no comparison of previous and next leaf values.

| Read | Subscription |
| --- | --- |
| nothing | none |
| `tracked.count` | key `count` on that proxy |
| `tracked.nested.count` | key `nested` on the parent, and key `count` on the current child |
| `tracked.nested` and no property of it | key `nested` on the parent, and the whole child |
| getter | whole object that owns the getter |
| `in`, `hasOwn`, `Object.keys`, object spread | whole object |

The intermediate key in `tracked.nested.count` is what makes replacement work without a leaf walk. `state.nested = { count: 1 }` notifies the `nested` key. The component re-renders and subscribes to `count` on the new child. `state.nested.count = 1` notifies `count` only. A sibling write notifies neither subscription.

No read installs no listener. `useSnapshot(state.obj)` used only as a boolean does not re-render. That is the on-demand rule, and it is the v3 change for the v2 behavior that treated an empty affected map as "everything".

A getter subscribes to the whole object, so any change there re-renders. Getter results are not cached and not compared. Precise computed dependencies are left for later.

`proxyMap` / `proxySet` are not special in React. Their methods write ordinary proxy properties, and those writes notify whatever the render subscribed to.

### The break against 1162

v2 does not re-render this:

```js
const tracked = useSnapshot(state)
tracked.nested.count
state.nested = { count: 0 } // count was already 0
```

The component then still has to see a later `state.nested.count++`. v2 does both by comparing leaves and keeping the subscription on the new child without rendering.

This design re-renders on the replacement, then the render subscribes to the new child. The following increment works because of that render. The skipped render does not.

That extra render is uncommon for the in-place style this branch optimizes. It shows up for immutable replacement of a subtree whose displayed leaves happen to be equal, which is the 1162 test and `state.data = await fetch()` only when the fetched leaves match what was already on screen. `applyChanges(state.nested, next)` is the quiet path: equal leaves do not notify, and child identity is preserved when the shape matches.

The same simplicity applies to enumeration and `in`. A value-only write re-renders a component that used `Object.keys` or `'count' in tracked`, because those reads subscribe to the whole object. v2 could ignore the value. Depending on that bailout is the same class of break.

These existing tests describe the v2 bailout and will change:

- `should not rerender if the leaf value does not change`
- enumeration tests that ignore value-only writes
- own-key and `in` tests that ignore value-only writes

Tests that a leaf reader ignores a sibling, that a replaced object keeps receiving later writes, and that a suspended render keeps its previous subscriptions stay as correctness tests.

### Subscription lifetime

On-demand records follow the snapshot identity that produced them, which is the v2 `affected` rule:

- A new snapshot starts a fresh read set. A component that stops reading `a` and reads `b` drops `a`.
- A React re-render that sees the same snapshot accumulates. A prop change, a bailout, or a local `setState` must not forget keys read on that snapshot.
- Listeners for keys read during render are installed during that read, so a `useLayoutEffect` in the same component is visible.
- A suspended render does not replace the committed read set.

## Public API

From `valtio` / `valtio/vanilla`:

| Export | Status |
| --- | --- |
| `subscribe(proxy, callback, { keys }?)` | `keys` added, boolean third argument removed |
| `batch(fn)` | added |
| `isProxyObject(value)` | added |
| `unstable_isRef(value)` | added |
| `getVersion(proxy)` | unchanged |

From `valtio/utils`:

| Export | Status |
| --- | --- |
| `applyChanges(proxy, next)` | added |
| `subscribeInAsync(proxy, callback, options?)` | added |
| `subscribeKey` | implemented on `{ keys }`, `notifyInSync` argument removed |

Not added: a key argument on `getVersion`, a public snapshot symbol, `trackKey`, a `recursive` flag, scoped ref, a replacement for `unstable_replaceInternalFunction`.

## Out of scope

- `valtio-reactive` interop, including `effect` and computed caching
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
| `state.foo = snapshot` or `state.foo = tracked` | throws; `applyChanges` or `deepClone` |
| `useSnapshot` with no property read | no subscription and no re-render |
| replace a subtree whose read leaves are equal | re-renders; `applyChanges` to keep the child and skip equal leaves |
| `delete state.missing` when `missing` is not own | no notification |

## Confirm

1. React re-renders on every on-demand notification and does not compare leaves. The 1162 equal-replacement skip becomes a re-render.
2. `batch`, removal of `notifyInSync`, and `subscribeInAsync` land in this branch even though on-demand subscription does not depend on them.
3. `isProxyObject` and `unstable_isRef` land here. `getVersion` stays one argument.
4. `applyChanges` accepts a snapshot with no snapshot symbol. The symbol remains only so assigning a snapshot throws.
