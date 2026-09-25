import { subscribe } from '../../vanilla.js'

/**
 * subscribeKey
 *
 * The subscribeKey utility enables subscription to a primitive subproperty of a given state proxy.
 * Subscriptions created with subscribeKey will only fire when the specified property changes.
 * notifyInSync: same as the parameter to subscribe(); true disables batching of subscriptions.
 *
 * @example
 * import { subscribeKey } from 'valtio/utils'
 * subscribeKey(state, 'count', (v) => console.log('state.count has changed to', v))
 */
export function subscribeKey<T extends object, K extends keyof T>(
  proxyObject: T,
  key: K,
  callback: (value: T[K]) => void,
): () => void {
  // eslint-disable-next-line prefer-rest-params
  if (typeof arguments[3] === 'boolean') {
    throw new Error(
      'notifyInSync has been removed. subscribeKey() is synchronous. Use batch() to group notifications.',
    )
  }
  let prevValue = proxyObject[key]
  return subscribe(proxyObject, () => {
    const nextValue = proxyObject[key]
    if (!Object.is(prevValue, nextValue)) {
      callback((prevValue = nextValue))
    }
  })
}
