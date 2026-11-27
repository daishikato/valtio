import { useLayoutEffect, useReducer } from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  proxy,
  subscribe,
  unstable_replaceInternalFunction,
  useSnapshot,
} from 'valtio'

// The shape of #1160: N item components, and a write that changes one item.
// Run it with `BENCH=1 pnpm vitest run tests/perf/leafWrite.test.tsx`.

type Item = { count: number }
type State = { items: Record<string, Item> }

const SIZES = [1_000, 5_000, 50_000]
const WRITES = 15

let snapshots = 0
let original!: <T extends object>(target: T, version: number) => T

const createState = (size: number) =>
  proxy<State>({
    items: Object.fromEntries(
      Array.from({ length: size }, (_, i) => [`k${i}`, { count: 0 }]),
    ),
  })

// Each item calls useSnapshot(state) and reads items[id].count.
const mountRootHooks = (state: State, renders: { count: number }) => {
  const Row = ({ id }: { id: string }) => {
    const tracked = useSnapshot(state)
    ++renders.count
    return <div>{tracked.items[id]!.count}</div>
  }
  return render(
    <>
      {Object.keys(state.items).map((id) => (
        <Row key={id} id={id} />
      ))}
    </>,
  )
}

// Each item follows its key and calls useSnapshot on its item, and the list
// reads the keys.
const mountItemHooks = (state: State, renders: { count: number }) => {
  const useItem = (parent: Record<string, Item>, key: string) => {
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
  const Row = ({ id }: { id: string }) => {
    const tracked = useItem(state.items, id)
    ++renders.count
    return <div>{tracked.count}</div>
  }
  const List = () => {
    const tracked = useSnapshot(state)
    ++renders.count
    return (
      <>
        {Object.keys(tracked.items).map((id) => (
          <Row key={id} id={id} />
        ))}
      </>
    )
  }
  return render(<List />)
}

const measure = (
  size: number,
  mount: typeof mountRootHooks,
): [rendered: number, ms: number, snapshots: number] => {
  const state = createState(size)
  const renders = { count: 0 }
  const { unmount } = mount(state, renders)
  const times: number[] = []
  renders.count = 0
  snapshots = 0
  for (let i = 0; i < WRITES; i++) {
    const item = state.items[`k${(i * 7919) % size}`]!
    const start = performance.now()
    act(() => {
      item.count++
    })
    times.push(performance.now() - start)
  }
  unmount()
  times.sort((a, b) => a - b)
  return [renders.count / WRITES, times[WRITES >> 1]!, snapshots / WRITES]
}

describe.skipIf(!process.env.BENCH)('#1160: one item write', () => {
  it('reports components rendered, write-to-commit time and snapshot() calls per write', () => {
    unstable_replaceInternalFunction('createSnapshot', (prev) => {
      original = prev
      return (...args) => {
        ++snapshots
        return prev(...args)
      }
    })
    try {
      const rows = SIZES.flatMap((size) =>
        (
          [
            ['root hook', mountRootHooks],
            ['item hook', mountItemHooks],
          ] as const
        ).map(([pattern, mount]) => {
          const [rendered, ms, perWrite] = measure(size, mount)
          return {
            pattern,
            size,
            rendered,
            'write to commit (ms)': Number(ms.toFixed(2)),
            'snapshot() calls per write': perWrite,
          }
        }),
      )
      console.table(rows)
      expect(rows.every((row) => row.rendered === 1)).toBe(true)
    } finally {
      unstable_replaceInternalFunction('createSnapshot', () => original)
    }
  }, 600_000)
})
