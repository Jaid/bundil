import {expect, test} from 'bun:test'

const {default: bundil} = await import('#src/main.ts')

test('should run', () => {
  const result = bundil()
  expect(result).toBe('bundil') // TODO Test actual functionality
})
