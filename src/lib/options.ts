const choice = <const T extends boolean | string>(name: string, allowed: ReadonlyArray<T>) => (value: unknown): T | undefined => {
  if (value === undefined) {
    return
  }
  const selected = allowed.find(option => value === option)
  if (selected === undefined) {
    throw new Error(`Unknown ${name}: ${Bun.inspect(value)}. Expected ${allowed.join(', ')}.`)
  }
  return selected
}

export const parseMode = choice('build mode', ['development', 'production'])
export const parseStrategy = choice('declaration strategy', ['auto', 'bundle', 'preserve'])
export const parseStrength = choice('Terser strength', ['auto', 'aggressive', 'max', true, false])
