import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { proxy, snapshot } from 'valtio'
import { trackKey, useSnapshot } from 'valtio/react'

describe('trackKey', () => {
  const setup = (track: boolean) => {
    const state = proxy({ obj: { a: 0, b: 0 } })
    const renderFn = vi.fn()
    const Component = () => {
      const tracked = useSnapshot(state)
      if (track) {
        trackKey(tracked.obj)
      }
      renderFn(tracked.obj.a)
      return null
    }
    render(<Component />)
    return { state, renderFn }
  }

  it('should not re-render for an unread property without it', () => {
    const { state, renderFn } = setup(false)
    act(() => {
      state.obj.b += 1
    })
    expect(renderFn).toBeCalledTimes(1)
  })

  it('should re-render for any change under the object', () => {
    const { state, renderFn } = setup(true)
    act(() => {
      state.obj.b += 1
    })
    expect(renderFn).toBeCalledTimes(2)
  })

  it('should return what it is given', () => {
    const state = proxy({ obj: { a: 0 } })
    let tracked!: { obj: { a: number } }
    const Component = () => {
      tracked = useSnapshot(state)
      return null
    }
    render(<Component />)
    expect(trackKey(tracked.obj)).toBe(tracked.obj)
    const snap = snapshot(state)
    expect(trackKey(snap)).toBe(snap)
    expect(trackKey(1)).toBe(1)
  })
})
