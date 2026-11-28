import {
  useDebugValue,
  useLayoutEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from 'react'
import { isProxyObject, snapshot, subscribe } from './vanilla.js'
import type { Snapshot } from './vanilla.js'

type Key = string | symbol

// What a read saw, as an entry in the log of the node it was made on.
const VALUE = 0 // the own property of a key: its value, the proxy that its object stands for, a getter, or none
const IN = 1 // whether a key is in the node
const OWN = 2 // whether a key is an own key of the node
const KEYS = 3 // the list of own keys
const WHOLE = 4 // the whole node, whose snapshot must stay the same

type Entry = readonly [kind: number, key?: Key]

// A snapshot object, and the live proxy that it stands for. The reads made
// on it are kept for as long as the snapshot object is used, which is as long
// as nothing under it changes.
type Node = {
  s: object // snapshot object
  p: object // live proxy
  t: object // tracked object, which a component reads
  values: Map<Key, unknown>
  ins: Map<Key, boolean>
  owns: Map<Key, boolean>
  keys?: Key[]
  whole?: boolean
  kids: Map<Key, Node> // the nodes that its keys gave
  reached?: boolean // given by a key of another node
  log: Entry[]
  at: number // the installation that it was last part of
  done: number // the entries of its log that were installed then
}

type Sub = {
  keys: Set<Key>
  presence: [Node, Entry][] // the reads of whether keys are there
  whole: boolean
  offKeys?: (() => void) | undefined
  offPresence?: (() => void) | undefined
  offWhole?: (() => void) | undefined
}

type Hook = {
  counter: number
  notify?: (() => void) | undefined
  rerender: () => void
  listener: () => void
  subscribe: (notify: () => void) => () => void // for useSyncExternalStore
  nodes: WeakMap<object, Node>
  root?: Node // of the latest render
  committed?: Node | undefined // of the latest commit
  installs: number
  installed: number // the installation that the subscriptions are of, or -1
  subs: Map<object, Sub>
  dirty: Set<Node> // installed nodes that have entries that aren't
  queued?: boolean
  stale?: boolean // the counter moved for the reads of the latest render
}

const isObject = (x: unknown): x is object =>
  typeof x === 'object' && x !== null

const hasOwn = (obj: object, key: Key): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

// The brand of a snapshot is forwarded without a record. A snapshot that
// was just taken has no other own symbol that its proxy doesn't have, so the
// first render finds it there.
let brand: Key | undefined

// What an own getter is recorded as. It is never run to be compared.
const GETTER = Symbol()
// What a key that isn't an own key is recorded as, apart from one whose
// value is undefined.
const NONE = Symbol()

// Live state is read through descriptors, so that no getter of a proxy runs.
const ownValue = (obj: object, key: Key): unknown => {
  const desc = Reflect.getOwnPropertyDescriptor(obj, key)
  return desc ? ('value' in desc ? desc.value : GETTER) : NONE
}

const isStale = (node: Node, [kind, key]: Entry): boolean => {
  const p = node.p
  switch (kind) {
    case VALUE:
      return !Object.is(node.values.get(key!), ownValue(p, key!))
    case IN:
      return node.ins.get(key!) !== Reflect.has(p, key!)
    case OWN:
      return node.owns.get(key!) !== hasOwn(p, key!)
    case KEYS: {
      const prev = node.keys!
      const next = Reflect.ownKeys(p)
      return prev.length !== next.length || prev.some((k, i) => k !== next[i])
    }
    default:
      return snapshot(p) !== node.s
  }
}

const bump = (hook: Hook) => {
  ++hook.counter
  ;(hook.notify || hook.rerender)()
}

const record = (hook: Hook, node: Node, entry: Entry) => {
  node.log.push(entry)
  // A read on an installed node after its commit is subscribed in a
  // microtask, which also checks it.
  if (node.at === hook.installed) {
    hook.dirty.add(node)
    if (!hook.queued) {
      hook.queued = true
      queueMicrotask(() => {
        hook.queued = false
        if (hook.installed !== -1 && install(hook, [...hook.dirty], false)) {
          bump(hook)
        }
      })
    }
  }
}

const recordWhole = (hook: Hook, node: Node) => {
  if (!node.whole) {
    node.whole = true
    record(hook, node, [WHOLE])
  }
}

const trackedNodes = new WeakMap<object, [Hook, Node]>()

const getNode = (hook: Hook, s: object, p: object): Node => {
  let node = hook.nodes.get(s)
  if (node) {
    return node
  }
  const values = new Map<Key, unknown>()
  const ins = new Map<Key, boolean>()
  const owns = new Map<Key, boolean>()
  const t = new Proxy(s, {
    get(s, key, receiver) {
      if (key === brand) {
        return Reflect.get(s, key, receiver)
      }
      // The own property is recorded, also for a getter, which is recorded
      // as one, and for a key that is inherited, such as a method, which is
      // recorded as none. So replacing a getter or shadowing a method is seen.
      const own = ownValue(s, key)
      if (!values.has(key)) {
        const live = isObject(own) && ownValue(p, key)
        // An object stands for the proxy under the key if it is that proxy's
        // current snapshot. Anything else, such as a Date, an object marked
        // with ref, or the snapshot of a proxy that changed since, is
        // returned as it is, and the read is stale.
        const kid =
          own !== live &&
          isProxyObject(live) &&
          snapshot(live as object) === own
            ? getNode(hook, own as object, live as object)
            : undefined
        if (kid) {
          kid.reached = true
          node!.kids.set(key, kid)
        }
        values.set(key, kid ? kid.p : own)
        record(hook, node!, [VALUE, key])
      }
      if (own === GETTER || own === NONE) {
        // A getter runs with the tracked object as `this`, so its reads are
        // recorded too.
        return Reflect.get(s, key, receiver)
      }
      const kid = node!.kids.get(key)
      return kid ? kid.t : own
    },
    has(s, key) {
      const result = Reflect.has(s, key)
      if (!ins.has(key) && key !== brand) {
        ins.set(key, result)
        record(hook, node!, [IN, key])
      }
      return result
    },
    getOwnPropertyDescriptor(s, key) {
      const desc = Reflect.getOwnPropertyDescriptor(s, key)
      if (!owns.has(key) && key !== brand) {
        owns.set(key, !!desc)
        record(hook, node!, [OWN, key])
      }
      return desc
    },
    ownKeys(s) {
      if (!node!.keys) {
        node!.keys = Reflect.ownKeys(s).filter((key) => key !== brand)
        record(hook, node!, [KEYS])
      }
      return Reflect.ownKeys(s)
    },
  })
  node = {
    s,
    p,
    t,
    values,
    ins,
    owns,
    kids: new Map(),
    log: [],
    at: 0,
    done: 0,
  }
  hook.nodes.set(s, node)
  trackedNodes.set(t, [hook, node])
  return node
}

type Want = { keys: Set<Key>; presence: [Node, Entry][]; whole: boolean }

// Installs the entries of the nodes that `from` reaches, and checks the ones
// that weren't installed yet. Without `prune`, it only adds subscriptions,
// for late reads. It returns whether a check failed.
const install = (hook: Hook, from: Node[], prune: boolean): boolean => {
  const prev = hook.installed
  const id = prune ? ++hook.installs : prev
  const want = new Map<object, Want>()
  const fresh: [Node, Entry][] = []
  const seen = new Set<Node>()
  const visit = (node: Node) => {
    const installed = node.at === prev
    if (seen.has(node) || (!prune && installed && !hook.dirty.has(node))) {
      return
    }
    seen.add(node)
    // A node that is only passed on is used as a whole.
    if (node.reached && !node.log.length) {
      node.whole = true
      node.log.push([WHOLE])
    }
    // Without prune, only the entries that aren't installed yet are added.
    const start = installed ? node.done : 0
    for (let i = prune ? 0 : start; i < node.log.length; i++) {
      const entry = node.log[i]!
      let w = want.get(node.p)
      if (!w) {
        want.set(node.p, (w = { keys: new Set(), presence: [], whole: false }))
      }
      if (entry[0] === VALUE) {
        w.keys.add(entry[1]!)
      } else if (entry[0] === WHOLE) {
        w.whole = true
      } else {
        w.presence.push([node, entry])
      }
      if (i >= start) {
        fresh.push([node, entry])
      }
    }
    node.at = id
    node.done = node.log.length
    node.kids.forEach(visit)
  }
  from.forEach(visit)
  if (prune) {
    hook.subs.forEach((sub, p) => {
      if (!want.has(p)) {
        sub.offKeys?.()
        sub.offPresence?.()
        sub.offWhole?.()
        hook.subs.delete(p)
      }
    })
  }
  want.forEach((w, p) => {
    const sub: Sub = hook.subs.get(p) || {
      keys: new Set(),
      presence: [],
      whole: false,
    }
    hook.subs.set(p, sub)
    if (!prune) {
      sub.keys.forEach((key) => w.keys.add(key))
      w.presence = sub.presence.concat(w.presence)
      w.whole ||= sub.whole
    }
    if (
      w.keys.size !== sub.keys.size ||
      [...w.keys].some((key) => !sub.keys.has(key))
    ) {
      sub.offKeys?.()
      sub.offKeys = w.keys.size
        ? subscribe(p, hook.listener, { keys: [...w.keys] })
        : undefined
      sub.keys = w.keys
    }
    // Whether a key is there changes only with the own keys, which are
    // compared when they change. So reading it doesn't re-render for a new
    // value, and Object.keys(), which reads each key's descriptor, doesn't
    // subscribe to each key.
    sub.presence = w.presence
    if (!sub.presence.length !== !sub.offPresence) {
      sub.offPresence?.()
      sub.offPresence = sub.presence.length
        ? subscribe(
            p,
            () => {
              if (sub.presence.some(([node, entry]) => isStale(node, entry))) {
                bump(hook)
              }
            },
            { ownKeys: true },
          )
        : undefined
    }
    if (w.whole !== sub.whole) {
      sub.offWhole?.()
      sub.offWhole = w.whole ? subscribe(p, hook.listener) : undefined
      sub.whole = w.whole
    }
  })
  hook.installed = id
  hook.dirty.clear()
  return fresh.some(([node, entry]) => isStale(node, entry))
}

const uninstall = (hook: Hook) => {
  hook.subs.forEach((sub) => {
    sub.offKeys?.()
    sub.offPresence?.()
    sub.offWhole?.()
  })
  hook.subs.clear()
  hook.dirty.clear()
  hook.installed = -1
  hook.committed = undefined
}

// Checks the reads that aren't installed yet, of a render that hasn't
// committed, or late reads. It moves the counter if one is stale.
const checkPending = (hook: Hook) => {
  if (hook.stale || (hook.root === hook.committed && !hook.dirty.size)) {
    return
  }
  const seen = new Set<Node>()
  const visit = (node: Node): boolean => {
    if (seen.has(node)) {
      return false
    }
    seen.add(node)
    const start = node.at === hook.installed ? node.done : 0
    if (
      (node.reached && !node.log.length && snapshot(node.p) !== node.s) ||
      node.log.some((entry, i) => i >= start && isStale(node, entry))
    ) {
      return true
    }
    for (const kid of node.kids.values()) {
      if (visit(kid)) {
        return true
      }
    }
    return false
  }
  if ((hook.root && visit(hook.root)) || [...hook.dirty].some(visit)) {
    ++hook.counter
    hook.stale = true
  }
}

const createHook = (rerender: () => void): Hook => {
  const hook: Hook = {
    counter: 0,
    rerender,
    listener: () => bump(hook),
    subscribe: (notify) => {
      hook.notify = notify
      return () => {
        if (hook.notify === notify) {
          hook.notify = undefined
        }
      }
    },
    nodes: new WeakMap(),
    installs: 0,
    installed: -1,
    subs: new Map(),
    dirty: new Set(),
  }
  return hook
}

// Each render takes the current snapshot, which is the cached one unless
// something changed. So a key read for the first time has its current value,
// also in a render that the counter didn't cause.
const startRender = (hook: Hook, p: object): Node => {
  const s = snapshot(p) as object
  brand ??= Object.getOwnPropertySymbols(s).find((key) => !hasOwn(p, key))
  const root = getNode(hook, s, p)
  hook.root = root
  hook.stale = false
  return root
}

const commit = (hook: Hook, root: Node) => {
  hook.committed = root
  if (install(hook, [root], true)) {
    bump(hook)
  }
}

const listPaths = (root: Node): Key[][] => {
  const paths: Key[][] = []
  const seen = new Set<Node>()
  const walk = (node: Node, path: Key[]) => {
    if (seen.has(node)) {
      return
    }
    seen.add(node)
    if (node.whole || node.keys) {
      paths.push(path)
    }
    ;[
      ...new Set([
        ...node.values.keys(),
        ...node.ins.keys(),
        ...node.owns.keys(),
      ]),
    ].forEach((key) => {
      const kid = node.kids.get(key)
      if (kid) {
        walk(kid, [...path, key])
      } else {
        paths.push([...path, key])
      }
    })
  }
  walk(root, [])
  return paths
}

/**
 * useSnapshot
 *
 * Create a local tracked snapshot that catches changes. This hook actually returns a wrapped snapshot in a proxy for
 * render optimization instead of a plain object compared to `snapshot()` method.
 * Rule of thumb: read from tracked snapshots, mutate the source.
 * The component will only re-render when the parts of the state you access have changed, it is render-optimized.
 *
 * @example A
 * function Counter() {
 *   const tracked = useSnapshot(state)
 *   return (
 *     <div>
 *       {tracked.count}
 *       <button onClick={() => ++state.count}>+1</button>
 *     </div>
 *   )
 * }
 *
 * [Notes]
 * Every object inside your proxy also becomes a proxy (if you don't use "ref"), so you can also use them to create
 * the local snapshot as seen on example B.
 *
 * @example B
 * function ProfileName() {
 *   const tracked = useSnapshot(state.profile)
 *   return (
 *     <div>
 *       {tracked.name}
 *     </div>
 *   )
 * }
 *
 * Beware that you still can replace the child proxy with something else so it will break your snapshot. You can see
 * above what happens with the original proxy when you replace the child proxy.
 *
 * > console.log(state)
 * { profile: { name: "valtio" } }
 * > childState = state.profile
 * > console.log(childState)
 * { name: "valtio" }
 * > state.profile.name = "react"
 * > console.log(childState)
 * { name: "react" }
 * > state.profile = { name: "new name" }
 * > console.log(childState)
 * { name: "react" }
 * > console.log(state)
 * { profile: { name: "new name" } }
 *
 * `useSnapshot()` depends on the original reference of the child proxy so if you replace it with a new one, the
 * component that is subscribed to the old proxy won't receive new updates because it is still subscribed to
 * the old one.
 *
 * In this case we recommend the example C or D. On both examples you don't need to worry with re-render,
 * because it is render-optimized.
 *
 * @example C
 * const tracked = useSnapshot(state)
 * return (
 *   <div>
 *     {tracked.profile.name}
 *   </div>
 * )
 *
 * @example D
 * const { profile } = useSnapshot(state)
 * return (
 *   <div>
 *     {profile.name}
 *   </div>
 * )
 */
export function useSnapshot<T extends object>(proxyObject: T): Snapshot<T> {
  // eslint-disable-next-line prefer-rest-params
  if (arguments[1] !== undefined) {
    throw new Error(
      'useSnapshot() no longer accepts an options argument. Updates are synchronous.',
    )
  }
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [hook] = useState(() => createHook(rerender))
  let inRender = true
  useSyncExternalStore(
    hook.subscribe,
    () => {
      // React calls this twice during render, and wants the same result.
      if (!inRender) {
        checkPending(hook)
      }
      return hook.counter
    },
    () => hook.counter,
  )
  inRender = false
  const root = startRender(hook, proxyObject)
  useLayoutEffect(() => commit(hook, root))
  useLayoutEffect(() => () => uninstall(hook), [hook])
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useDebugValue(root, listPaths)
  }
  return root.t as Snapshot<T>
}

/**
 * Makes a component depend on the whole of an object that it read from
 * `useSnapshot`, as well as on the keys that it reads under it.
 *
 * Use it where the component depends on the identity of the object, for
 * example when it passes the object to a memoized function.
 *
 * @example
 * const tracked = useSnapshot(state)
 * const total = useMemo(() => sum(trackKey(tracked.items)), [tracked.items])
 */
export function trackKey<T>(obj: T): T {
  const found = trackedNodes.get(obj as object)
  if (found) {
    recordWhole(...found)
  }
  return obj
}
