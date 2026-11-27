import {
  Activity,
  memo,
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import {
  batch,
  proxy,
  subscribe,
  unstable_replaceInternalFunction,
  useSnapshot,
} from 'valtio'

type Item = { count: number }

// The item-hook pattern: an item follows its key on the parent.
const useItem = <T extends object>(parent: Record<string, T>, key: string) => {
  const item = parent[key]!
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useLayoutEffect(() => {
    const unsubscribe = subscribe(parent, rerender, { keys: [key] })
    if (parent[key] !== item) {
      rerender()
    }
    return unsubscribe
  }, [parent, key, item])
  return useSnapshot(item)
}

// Renders and commits synchronously, with the updates that the commit
// schedules synchronously. That is what the first paint shows.
const renderBeforePaint = (element: ReactNode): string => {
  const env = globalThis as {
    IS_REACT_ACT_ENVIRONMENT?: boolean | undefined
  }
  const prev = env.IS_REACT_ACT_ENVIRONMENT
  env.IS_REACT_ACT_ENVIRONMENT = false
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    flushSync(() => root.render(element))
    return container.textContent || ''
  } finally {
    root.unmount()
    env.IS_REACT_ACT_ENVIRONMENT = prev
  }
}

describe('subscriptions', () => {
  it('should wake only the component that read a value', () => {
    const state = proxy({
      items: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [`k${i}`, { count: 0 }]),
      ) as Record<string, Item>,
    })
    const renders = new Map<string, number>()
    const Row = ({ id }: { id: string }) => {
      const tracked = useSnapshot(state)
      renders.set(id, (renders.get(id) || 0) + 1)
      return <div>{`${id}: ${tracked.items[id]!.count}`}</div>
    }
    render(
      <>
        {Object.keys(state.items).map((id) => (
          <Row key={id} id={id} />
        ))}
      </>,
    )
    renders.clear()

    act(() => {
      state.items.k5!.count++
    })
    expect(screen.getByText('k5: 1')).toBeInTheDocument()
    expect([...renders]).toEqual([['k5', 1]])
  })

  it('should keep a list parent quiet on item writes and item replacement', () => {
    const state = proxy({
      items: { a: { count: 0 }, b: { count: 0 } } as Record<string, Item>,
    })
    const parentRender = vi.fn()
    const itemRender = vi.fn()
    const Row = ({ id }: { id: string }) => {
      const tracked = useItem(state.items, id)
      itemRender(id)
      return <div>{`${id}: ${tracked.count}`}</div>
    }
    const List = () => {
      const tracked = useSnapshot(state)
      parentRender()
      return (
        <>
          {Object.keys(tracked.items).map((id) => (
            <Row key={id} id={id} />
          ))}
        </>
      )
    }
    render(<List />)
    parentRender.mockClear()
    itemRender.mockClear()

    act(() => {
      state.items.a!.count++
    })
    expect(screen.getByText('a: 1')).toBeInTheDocument()
    expect(parentRender).not.toHaveBeenCalled()
    expect(itemRender.mock.calls).toEqual([['a']])

    itemRender.mockClear()
    act(() => {
      state.items.b = { count: 5 }
    })
    expect(screen.getByText('b: 5')).toBeInTheDocument()
    expect(parentRender).not.toHaveBeenCalled()
    expect(itemRender.mock.calls.every(([id]) => id === 'b')).toBe(true)

    act(() => {
      state.items.c = { count: 7 }
    })
    expect(screen.getByText('c: 7')).toBeInTheDocument()
    expect(parentRender).toHaveBeenCalledTimes(1)
  })

  it('should show an item replaced in a layout effect before paint', () => {
    const state = proxy({ items: { a: { count: 0 } } as Record<string, Item> })
    // A child's layout effect runs before the row subscribes.
    const Writer = () => {
      useLayoutEffect(() => {
        state.items.a = { count: 1 }
      }, [])
      return null
    }
    const Row = () => {
      const tracked = useItem(state.items, 'a')
      return (
        <div>
          {`a: ${tracked.count}`}
          <Writer />
        </div>
      )
    }
    expect(renderBeforePaint(<Row />)).toBe('a: 1')
  })

  it.each(['child', 'later sibling'])(
    "should show a write from a %s's layout effect to a key read for the first time before paint",
    (writer) => {
      const state = proxy({ count: 0 })
      // A child's layout effect runs before the reader subscribes, and a
      // later sibling's after.
      const Writer = () => {
        useLayoutEffect(() => {
          state.count = 1
        }, [])
        return null
      }
      const Reader = () => {
        const tracked = useSnapshot(state)
        return (
          <div>
            {`count: ${tracked.count}`}
            {writer === 'child' && <Writer />}
          </div>
        )
      }
      expect(
        renderBeforePaint(
          <>
            <Reader />
            {writer === 'later sibling' && <Writer />}
          </>,
        ),
      ).toBe('count: 1')
    },
  )

  it('should re-render an in reader only when the key is added or deleted', () => {
    const state = proxy<{ value?: number }>({})
    const renderFn = vi.fn()
    const Component = () => {
      const tracked = useSnapshot(state)
      renderFn()
      return <div>{'value' in tracked ? 'yes' : 'no'}</div>
    }
    render(<Component />)

    act(() => {
      state.value = 1
    })
    expect(screen.getByText('yes')).toBeInTheDocument()
    expect(renderFn).toHaveBeenCalledTimes(2)

    act(() => {
      state.value = 2
    })
    expect(renderFn).toHaveBeenCalledTimes(2)

    act(() => {
      delete state.value
    })
    expect(screen.getByText('no')).toBeInTheDocument()
    expect(renderFn).toHaveBeenCalledTimes(3)
  })

  it('should not loop on a getter that returns a new object', async () => {
    const state = proxy({
      count: 0,
      get box() {
        return { count: this.count }
      },
    })
    const renderFn = vi.fn()
    const Component = () => {
      const tracked = useSnapshot(state)
      renderFn()
      return <div>box: {tracked.box.count}</div>
    }
    render(<Component />)
    await act(() => Promise.resolve())
    expect(renderFn).toHaveBeenCalledTimes(1)

    act(() => {
      state.count = 1
    })
    expect(screen.getByText('box: 1')).toBeInTheDocument()
    expect(renderFn).toHaveBeenCalledTimes(2)
  })

  it('should subscribe to a key read in an event handler until the snapshot changes', async () => {
    const state = proxy({ count: 0, other: 0 })
    const renderFn = vi.fn()
    const Component = () => {
      const tracked = useSnapshot(state)
      renderFn()
      return (
        <button
          onClick={() => {
            // a late read
            void tracked.other
          }}
        >
          count: {tracked.count}
        </button>
      )
    }
    render(<Component />)
    fireEvent.click(screen.getByText('count: 0'))
    await act(() => Promise.resolve())

    act(() => {
      state.other = 1
    })
    expect(renderFn).toHaveBeenCalledTimes(2)

    act(() => {
      state.other = 2
    })
    expect(renderFn).toHaveBeenCalledTimes(2)
  })

  it('should take one snapshot for a burst of writes', () => {
    let snapshots = 0
    let original!: <T extends object>(target: T, version: number) => T
    unstable_replaceInternalFunction('createSnapshot', (prev) => {
      original = prev
      return (...args) => {
        ++snapshots
        return prev(...args)
      }
    })
    try {
      const state = proxy({ items: Array.from({ length: 100 }, () => 0) })
      const Component = () => {
        const tracked = useSnapshot(state)
        return <div>length: {tracked.items.length}</div>
      }
      render(<Component />)
      snapshots = 0
      act(() => {
        for (let i = 0; i < 100; i++) {
          state.items[i] = 1
        }
        state.items.push(1)
      })
      expect(screen.getByText('length: 101')).toBeInTheDocument()
      // one render, which takes one snapshot
      expect(snapshots).toBe(1)
    } finally {
      unstable_replaceInternalFunction('createSnapshot', () => original)
    }
  })

  it('should not keep a binding that a late read made to another proxy', async () => {
    const shared = proxy({ count: 0 })
    const state = proxy({ a: shared, b: shared, show: false })
    const Component = () => {
      const tracked = useSnapshot(state)
      return (
        <button
          onClick={() => {
            // a late read, made after state.a became another proxy
            void tracked.a.count
          }}
        >
          {tracked.show ? `b: ${tracked.b.count}` : 'hidden'}
        </button>
      )
    }
    render(<Component />)
    act(() => {
      state.a = { count: 0 }
    })
    fireEvent.click(screen.getByText('hidden'))
    await act(() => Promise.resolve())

    act(() => {
      state.show = true
    })
    act(() => {
      state.b.count = 1
    })
    expect(screen.getByText('b: 1')).toBeInTheDocument()
  })

  it('should re-render when a getter is replaced by a value', () => {
    const state = proxy<{ value: number }>({
      get value() {
        return 1
      },
    })
    const Component = () => <div>value: {useSnapshot(state).value}</div>
    render(<Component />)
    act(() => {
      batch(() => {
        Reflect.deleteProperty(state, 'value')
        Object.assign(state, { value: 2 })
      })
    })
    expect(screen.getByText('value: 2')).toBeInTheDocument()
  })

  it('should re-render when an own property shadows an inherited one', () => {
    class State {
      label() {
        return 'before'
      }
    }
    const state = proxy(new State())
    const Component = () => <div>label: {useSnapshot(state).label()}</div>
    render(<Component />)
    act(() => {
      state.label = () => 'after'
    })
    expect(screen.getByText('label: after')).toBeInTheDocument()
  })

  it('should drop its subscriptions on unmount', () => {
    const state = proxy({ count: 0 })
    let rendered = 0
    const Component = () => {
      rendered++
      return <div>{useSnapshot(state).count}</div>
    }
    const { unmount } = render(<Component />)
    unmount()
    act(() => {
      state.count = 1
    })
    expect(rendered).toBe(1)
  })

  it('should keep a memoized child current when it bails out', () => {
    const state = proxy({ a: { x: 0 }, b: 0 })
    const childRender = vi.fn()
    const Child = memo(function Child({ a }: { a: { x: number } }) {
      childRender()
      return <div>x: {a.x}</div>
    })
    const Parent = () => {
      const tracked = useSnapshot(state)
      return (
        <>
          <div>b: {tracked.b}</div>
          <Child a={tracked.a} />
        </>
      )
    }
    render(<Parent />)
    act(() => {
      state.b = 1
    })
    expect(childRender).toHaveBeenCalledTimes(1)

    act(() => {
      state.a.x = 1
    })
    expect(screen.getByText('x: 1')).toBeInTheDocument()
  })

  it.skipIf(typeof Activity === 'undefined')(
    'should show writes made while hidden in the first visible commit',
    () => {
      const state = proxy({ count: 0 })
      const painted = vi.fn()
      const Reader = () => {
        const tracked = useSnapshot(state)
        useEffect(() => {
          painted(tracked.count)
        })
        return <div>count: {tracked.count}</div>
      }
      const App = () => {
        const [visible, setVisible] = useState(true)
        return (
          <>
            <button onClick={() => setVisible((v) => !v)}>toggle</button>
            <Activity mode={visible ? 'visible' : 'hidden'}>
              <Reader />
            </Activity>
          </>
        )
      }
      render(<App />)
      fireEvent.click(screen.getByText('toggle'))
      act(() => {
        state.count = 1
      })
      painted.mockClear()
      fireEvent.click(screen.getByText('toggle'))
      expect(screen.getByText('count: 1')).toBeInTheDocument()
      expect(painted).toHaveBeenLastCalledWith(1)
    },
  )
})
