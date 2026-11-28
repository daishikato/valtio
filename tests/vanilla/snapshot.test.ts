import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { proxy, ref, snapshot, subscribe } from 'valtio'
import type { Snapshot } from 'valtio'
import { deepClone, proxyMap, proxySet } from 'valtio/utils'

describe('snapshot', () => {
  it('should return correct snapshots without subscribe', async () => {
    const child = proxy({ count: 0 })
    const state = proxy({ child })

    expect(snapshot(state)).toEqual({ child: { count: 0 } })

    ++child.count
    expect(snapshot(state)).toEqual({ child: { count: 1 } })
  })

  it('should not change snapshot with assigning same object', async () => {
    const obj = {}
    const state = proxy({ obj })

    const snap1 = snapshot(state)
    state.obj = obj
    const snap2 = snapshot(state)
    expect(snap1).toBe(snap2)
  })

  it('should keep snapshot properties configurable', async () => {
    const state = proxy({ foo: 1 })
    const snap1 = snapshot(state)
    // A non-configurable, non-writable property would make useSnapshot's
    // tracking proxy copy the object, and we don't want that perf overhead.
    expect(Object.getOwnPropertyDescriptor(snap1, 'foo')).toEqual({
      configurable: true,
      enumerable: true,
      value: 1,
      writable: false,
    })
  })

  it('should not change snapshot with modifying the original proxy', async () => {
    const state = proxy({ obj1: {}, obj2: { nested: { count: 1 } } })
    const snap1 = snapshot(state)
    expect(snap1.obj1).toBeDefined()
    state.obj2.nested.count++
    const snap2 = snapshot(state)
    expect(snap1.obj2.nested.count).toBe(1)
    expect(snap2.obj2.nested.count).toBe(2)
  })

  it('should return stable nested snapshot object', async () => {
    const state = proxy({ count: 0, obj: {} })
    const snap1 = snapshot(state)
    state.count++
    const snap2 = snapshot(state)
    expect(snap2.obj).toBe(snap1.obj)
  })

  it('[DEV-ONLY] should warn and throw for a non-proxy object', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => snapshot({} as any)).toThrow()
    expect(consoleWarn).toHaveBeenCalledWith('Please use proxy object')

    consoleWarn.mockRestore()
  })

  it('should evaluate getters that read ancestor properties in cyclic graphs', () => {
    type Root = {
      child: {
        parent: Root
        readonly selected: number
      }
      value: number
    }
    const root = {} as Root
    root.child = {
      parent: root,
      get selected() {
        return this.parent.value
      },
    }
    root.value = 1

    const snap = snapshot(proxy(root))

    expect(snap.child.selected).toBe(1)
  })

  it('should keep the length of an array that ends in holes', () => {
    const state = proxy([1])
    state.length = 3
    const snap = snapshot(state)
    expect(snap.length).toBe(3)
    expect(Object.keys(snap)).toEqual(['0'])
  })

  it('should reuse the snapshot while the state is unchanged', () => {
    const state = proxy({ count: 0 })
    expect(snapshot(state)).toBe(snapshot(state))

    const snap1 = snapshot(state)
    state.count += 1
    expect(snapshot(state)).not.toBe(snap1)
  })

  it('should produce read-only properties', () => {
    const state = proxy({ count: 0 })
    const snap = snapshot(state)

    expect(() => {
      ;(snap as any).count = 1
    }).toThrow()
    expect(snap.count).toBe(0)
  })

  describe('snapshot typings', () => {
    it('converts object properties to readonly', () => {
      type A = Snapshot<{
        string: string
        number: number
        null: null
        undefined: undefined
        bool: boolean
        someFunction(): number
        ref: { x: unknown } & { $$valtioSnapshot: { x: unknown } }
      }>
      type B = {
        readonly string: string
        readonly number: number
        readonly null: null
        readonly undefined: undefined
        readonly bool: boolean
        readonly someFunction: () => number
        readonly ref: { x: unknown }
      }

      expectTypeOf<A>().toEqualTypeOf<B>()
    })

    it('converts arrays to readonly arrays', () => {
      type A = Snapshot<number[]>
      type B = readonly number[]

      expectTypeOf<A>().toEqualTypeOf<B>()
    })

    it('keeps builtin objects from SnapshotIgnore as-is', () => {
      type A = Snapshot<{
        date: Date
        map: Map<string, unknown>
        set: Set<string>
        regexp: RegExp
        error: Error
        weakMap: WeakMap<any, any>
        weakSet: WeakSet<any>
      }>
      type B = {
        readonly date: Date
        readonly map: Map<string, unknown>
        readonly set: Set<string>
        readonly regexp: RegExp
        readonly error: Error
        readonly weakMap: WeakMap<any, any>
        readonly weakSet: WeakSet<any>
      }

      expectTypeOf<A>().toEqualTypeOf<B>()
    })

    it('converts collections to readonly', () => {
      type A = Snapshot<{ key: string }[]>
      type B = readonly { readonly key: string }[]

      expectTypeOf<A>().toEqualTypeOf<B>()
    })

    it('converts object properties to readonly recursively', () => {
      type A = Snapshot<{
        prevPage: number | null
        nextPage: number | null
        rows: number
        items: {
          title: string
          details: string | null
          createdAt: Date
          updatedAt: Date
        }[]
      }>
      type B = {
        readonly prevPage: number | null
        readonly nextPage: number | null
        readonly rows: number
        readonly items: readonly {
          readonly title: string
          readonly details: string | null
          readonly createdAt: Date
          readonly updatedAt: Date
        }[]
      }

      expectTypeOf<A>().toEqualTypeOf<B>()
    })

    it('turns class fields to readonly', () => {
      class User {
        firstName!: string
        lastName!: string
        role!: string

        hasRole(role: string): boolean {
          return this.role === role
        }
      }

      type A = Snapshot<typeof user>
      type B = {
        readonly firstName: string
        readonly lastName: string
        readonly role: string
        readonly hasRole: (role: string) => boolean
      }

      const user = new User()
      expect(user).toBeDefined()

      expectTypeOf<A>().toEqualTypeOf<B>()
    })

    it('ignores primitive types that have been branded/tagged', () => {
      const symbolTag = Symbol()

      type A = Snapshot<{
        brandedWithStringKey: string & { __brand: 'Brand' }
        brandedWithSymbolKey: number & { [symbolTag]: 'Tag' }
      }>
      type B = {
        readonly brandedWithStringKey: string & { __brand: 'Brand' }
        readonly brandedWithSymbolKey: number & { [symbolTag]: 'Tag' }
      }

      expectTypeOf<A>().toEqualTypeOf<B>()
    })
  })
})

describe('snapshot getters', () => {
  it('should run a getter on each read, with the snapshot as this', () => {
    const compute = vi.fn((count: number) => count * 2)
    const state = proxy({
      count: 1,
      get doubled() {
        return compute(this.count)
      },
    })
    const snap = snapshot(state)
    expect(compute).not.toHaveBeenCalled()

    expect(snap.doubled).toBe(2)
    expect(snap.doubled).toBe(2)
    expect(compute).toHaveBeenCalledTimes(2)

    state.count = 2
    expect(snap.doubled).toBe(2)
    expect(snapshot(state).doubled).toBe(4)
  })

  it('should give an object from a getter a new identity on each read', () => {
    const state = proxy({
      count: 1,
      get box() {
        return { count: this.count }
      },
    })
    const snap = snapshot(state)
    expect(snap.box).toEqual({ count: 1 })
    expect(snap.box).not.toBe(snap.box)
  })

  it('should throw from a getter on read, not from snapshot()', () => {
    const state = proxy({
      get failing(): number {
        throw new Error('failed')
      },
    })
    const snap = snapshot(state)
    expect(() => snap.failing).toThrow('failed')
  })

  it('should leave the setter out', () => {
    const state = proxy({
      count: 1,
      get doubled() {
        return this.count * 2
      },
      set doubled(value: number) {
        this.count = value / 2
      },
    })
    const snap = snapshot(state) as { doubled: number }
    expect(() => {
      snap.doubled = 4
    }).toThrow(TypeError)
    state.doubled = 4
    expect(state.count).toBe(2)
  })

  it('should keep a key with only a setter as an accessor without a getter', () => {
    const state = proxy({
      set value(_value: number) {},
    })
    const snap = snapshot(state) as { value?: number }
    const desc = Object.getOwnPropertyDescriptor(snap, 'value')!
    expect('value' in desc).toBe(false)
    expect(desc.get).toBeUndefined()
    expect(desc.set).toBeUndefined()
    expect(snap.value).toBeUndefined()
  })

  it('[DEV-ONLY] should warn once when a getter reads a proxy while it runs on a snapshot', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = proxy({
      count: 1,
      get closure(): number {
        return state.count * 2
      },
      get viaThis(): number {
        return this.count * 2
      },
    })
    expect(state.closure).toBe(2)
    expect(consoleWarn).not.toHaveBeenCalled()

    const snap = snapshot(state)
    expect(snap.viaThis).toBe(2)
    expect(consoleWarn).not.toHaveBeenCalled()

    expect(snap.closure).toBe(2)
    expect(snap.closure).toBe(2)
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(consoleWarn.mock.calls[0]![0]).toContain('closure')
    consoleWarn.mockRestore()
  })

  it('[DEV-ONLY] should name ref when a getter reads a proxy marked with ref through this', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = proxy({
      child: ref(proxy({ count: 1 })),
      get count() {
        return this.child.count
      },
    })
    expect(snapshot(state).count).toBe(1)
    const messages = consoleWarn.mock.calls.map(([message]) => message)
    consoleWarn.mockRestore()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('an object marked with `ref`')
  })

  it('[DEV-ONLY] should not warn for a getter that a copy of a snapshot takes into state', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = proxy({
      count: 1,
      get doubled(): number {
        return this.count * 2
      },
    })
    const desc = Object.getOwnPropertyDescriptor(snapshot(source), 'doubled')!
    const destination = proxy(
      Object.defineProperty({ count: 2 }, 'doubled', desc) as {
        count: number
        doubled: number
      },
    )
    expect(destination.doubled).toBe(4)
    expect(consoleWarn).not.toHaveBeenCalled()
    consoleWarn.mockRestore()
  })
})

describe('snapshot brand', () => {
  const message =
    'Cannot assign a Valtio snapshot into a proxy. Copy it with deepClone(), merge it with applyChanges(), or wrap it with ref() to store it as is.'

  it('throws for proxy(snapshot)', () => {
    const snap = snapshot(proxy({ count: 0 }))
    expect(() => proxy(snap)).toThrow(message)
  })

  it('throws for a snapshot assigned into state, directly or nested', () => {
    const state = proxy<{ value?: object; list: object[] }>({ list: [] })
    const snap = snapshot(proxy({ child: { count: 0 } }))

    expect(() => {
      state.value = snap
    }).toThrow(message)
    expect(() => {
      state.value = { child: snap.child }
    }).toThrow(message)
    expect(() => state.list.push(snap)).toThrow(message)
    expect(state.value).toBeUndefined()
    expect(state.list).toEqual([])
  })

  it('throws again when a rejected object is used again', () => {
    const value = { nested: { child: snapshot(proxy({ count: 0 })) } }
    expect(() => proxy(value)).toThrow(message)
    expect(() => proxy(value)).toThrow(message)

    const state = proxy<{ value?: object }>({})
    expect(() => {
      state.value = value
    }).toThrow(message)
    expect(state.value).toBeUndefined()
  })

  it('gives a rejected object one proxy once it is fixed', () => {
    type Value = { child: { parent?: Value }; bad: { count: number } }
    const value: Value = { child: {}, bad: snapshot(proxy({ count: 0 })) }
    value.child.parent = value
    expect(() => proxy(value)).toThrow(message)

    value.bad = { count: 0 }
    const state = proxy(value)
    expect(state.child.parent).toBe(state)
    const listener = vi.fn()
    subscribe(state, listener)
    state.child.parent!.bad.count = 1
    expect(listener).toHaveBeenCalledTimes(1)
    expect(snapshot(state).bad.count).toBe(1)
  })

  it('keeps the current child linked when an assignment throws', () => {
    const state = proxy({ child: { count: 0 } })
    const snap = snapshot(state)
    const listener = vi.fn()
    subscribe(state, listener)

    expect(() => {
      state.child = snap.child
    }).toThrow(message)
    state.child.count++
    expect(listener).toHaveBeenCalledTimes(1)
    expect(snapshot(state).child.count).toBe(1)
  })

  it('throws for a snapshot set in a proxyMap', () => {
    const map = proxyMap<string, object>()
    const snap = snapshot(proxy({ count: 0 }))
    expect(() => map.set('a', snap)).toThrow(message)
  })

  it('looks up a snapshot in a proxySet without throwing', () => {
    const item = proxy({ count: 0 })
    const set = proxySet<object>([item])
    const snap = snapshot(proxy({ count: 0 }))
    expect(set.has(snap)).toBe(false)
    expect(set.delete(snap)).toBe(false)
    expect(set.has(item)).toBe(true)
    expect(() => set.add(snap)).toThrow(message)
  })

  it('looks up a proxySet member as adding it would', () => {
    const item = { count: 0 }
    proxy(item)
    ref(item)
    const set = proxySet<object>([item])
    expect(set.has(item)).toBe(true)

    const snap = snapshot(proxy({ count: 0 }))
    set.add(ref(snap))
    expect(set.has(snap)).toBe(true)
    expect(set.delete(snap)).toBe(true)

    // proxy() made for an object that adding stores as is
    const date = new Date()
    proxy(date)
    set.add(date)
    expect(set.has(date)).toBe(true)
    const existing = proxy({ count: 0 })
    proxy(existing)
    set.add(existing)
    expect(set.has(existing)).toBe(true)

    // a lookup makes no proxy, so adding still checks for the snapshot
    const holder = { child: snapshot(proxy({ count: 0 })) }
    expect(set.has(holder)).toBe(false)
    expect(() => set.add(holder)).toThrow(message)
  })

  it('stores a snapshot wrapped with ref as is', () => {
    const state = proxy<{ history: object[] }>({ history: [] })
    const snap = snapshot(proxy({ count: 0 }))
    state.history.push(ref(snap))
    expect(state.history[0]).toBe(snap)
  })

  it('makes a proxy from a deep clone of a snapshot', () => {
    const snap = snapshot(proxy({ child: { count: 0 } }))
    const state = proxy<{ child: { count: number } }>(deepClone(snap))
    state.child.count = 1
    expect(state.child.count).toBe(1)
  })

  it('leaves the brand out of Object.keys, spread and JSON', () => {
    const snap = snapshot(proxy({ count: 0 }))
    expect(Object.keys(snap)).toEqual(['count'])
    expect(proxy({ ...snap }).count).toBe(0)
    expect(proxy(JSON.parse(JSON.stringify(snap))).count).toBe(0)
  })
})
