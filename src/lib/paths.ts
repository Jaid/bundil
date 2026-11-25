import {dirname, isAbsolute, relative, resolve} from 'node:path'

export const slash = (path: string) => path.replaceAll('\\', '/')
export const relativePath = (folder: string, file: string) => slash(relative(folder, file))
export const isInside = (folder: string, file: string) => {
  const path = relativePath(folder, file)
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path)
}
export const inside = (folder: string, file: string) => {
  const result = resolve(folder, file)
  if (!isInside(folder, result) || !relative(folder, result)) {
    throw new Error(`Expected a path inside ${folder}: ${file}`)
  }
  return result
}
export const modulePath = (from: string, to: string) => {
  const path = relativePath(dirname(from), to)
  return path.startsWith('../') ? path : `./${path}`
}
