import type {BundilOptions, ExportMap, ExportTarget, Manifest} from './types.ts'

import {basename, dirname, extname, join, resolve} from 'node:path'

import fs from 'fs-extra'

import {parseMode, parseStrategy, parseStrength} from './options.ts'
import {inside, isInside, relativePath} from './paths.ts'

const exportCondition = (entry: ExportTarget | undefined, condition: string) => {
  if (typeof entry !== 'object' || !entry || Array.isArray(entry)) {
    return
  }
  const value = entry[condition]
  return typeof value === 'string' ? value : undefined
}
const isDeclaration = (file: string) => /\.d\.[cm]?ts$/u.test(file)
const runtimeTarget = (entry?: ExportTarget) => (typeof entry === 'string' ? entry : exportCondition(entry, 'import') ?? exportCondition(entry, 'default'))
const exportMap = (field?: ExportTarget): ExportMap => {
  if (typeof field === 'object' && field && !Array.isArray(field) && Object.keys(field).some(key => key.startsWith('.'))) {
    return field
  }
  return field ? {'.': field} : {}
}
const findPackageRoot = async (file: string) => {
  let folder = dirname(file)
  while (!await Bun.file(join(folder, 'package.json')).exists()) {
    const parent = dirname(folder)
    if (parent === folder) {
      throw new Error(`No package.json found for ${file}`)
    }
    folder = parent
  }
  return folder
}
const resolveTarget = async (target = '.') => {
  const path = resolve(target)
  const stats = await fs.stat(path)
  if (stats.isDirectory()) {
    return {root: path}
  }
  return basename(path) === 'package.json' ? {root: dirname(path)} : {
    root: await findPackageRoot(path),
    file: path,
  }
}
interface RuntimeEntry {
  /** Package-relative output file name, including its extension. */
  output: string
  source: string
}
interface Entry {
  output: string
  source?: string
  types: string
}

export const dependencyName = (id: string) => id.split('/').slice(0, id.startsWith('@') ? 2 : 1).join('/')
export const resolveProject = async (options: BundilOptions) => {
  const {root, file} = await resolveTarget(options.target)
  const manifest = await Bun.file(join(root, 'package.json')).json() as Manifest
  if (typeof manifest.name !== 'string' || !/^(?:@[\w\-~][\w\-.~]*\/)?[\w\-~][\w\-.~]*$/u.test(manifest.name) || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`Expected a package name and version in ${join(root, 'package.json')}`)
  }
  const mode = parseMode(options.mode) ?? (Bun.env.NODE_ENV === 'development' ? 'development' : 'production')
  const strategy = parseStrategy(options.dtsStrategy) ?? 'auto'
  const terser = parseStrength(options.terserStrength) ?? 'auto'
  if (options.bundle && options.precompiled) {
    throw new Error('A precompiled build cannot bundle dependencies.')
  }
  const outputFolder = resolve(root, options.outputFolder ?? 'dist', manifest.name, mode)
  const sourceExports = exportMap(manifest.exports)
  let sourceBin = manifest.bin
  if (!sourceBin) {
    for (const candidate of ['src/cli.ts', 'src/cli.js']) {
      if (await Bun.file(join(root, candidate)).exists()) {
        sourceBin = candidate
        break
      }
    }
  }
  const commands = typeof sourceBin === 'string' ? {[basename(manifest.name)]: sourceBin} : sourceBin
  const binSources = new Set(Object.values(commands ?? {}).map(path => inside(root, path)))
  const entries = new Map<string, Entry>
  const passthrough: ExportMap = {}
  const explicitRuntime = options.runtimeEntryFile ?? file ?? runtimeTarget(sourceExports['.']) ?? manifest.main
  const explicitTypes = exportCondition(sourceExports['.'], 'types') ?? manifest.types ?? manifest.typings
  const defaultRuntime = join('src', options.inputFileName ?? 'main.ts')
  const fallback = inside(root, defaultRuntime)
  const rootTarget = explicitRuntime ?? (!explicitTypes && !Object.keys(sourceExports).length && !binSources.has(fallback) && await Bun.file(fallback).exists() ? defaultRuntime : undefined)
  let rootTypes = file ?? explicitTypes ?? rootTarget
  if (!rootTarget && !rootTypes && !Object.keys(sourceExports).length && !binSources.size) {
    for (const candidate of ['src/main.d.ts', 'src/index.d.ts', 'index.d.ts']) {
      if (await Bun.file(join(root, candidate)).exists()) {
        rootTypes = candidate
        break
      }
    }
  }
  const rootRuntime = rootTarget && !isDeclaration(rootTarget) ? inside(root, rootTarget) : undefined
  if (options.precompiled && (!rootRuntime || !/\.m?js$/u.test(rootRuntime))) {
    throw new Error('Expected precompiled ESM JavaScript. Set runtimeEntryFile to the .js or .mjs entry.')
  }
  if (rootTypes) {
    entries.set('.', {
      output: 'lib.js',
      source: rootRuntime,
      types: inside(root, rootTypes),
    })
  }
  for (const [key, value] of Object.entries(sourceExports)) {
    if (key === '.') {
      continue
    }
    if (value === null || options.precompiled || key === './package.json' && value === './package.json') {
      passthrough[key] = value
      continue
    }
    const target = runtimeTarget(value)
    const types = exportCondition(value, 'types') ?? target
    if (!key.startsWith('./') || key.includes('*') || !types || !/\.[cm]?[jt]sx?$/u.test(types) || target && !/\.[cm]?[jt]sx?$/u.test(target)) {
      throw new Error('Expected a concrete ESM or declaration entry for export ' + key + '. Use precompiled mode for an existing export graph.')
    }
    const output = 'exports/' + key.slice(2) + '.js'
    if (relativePath(root, inside(root, output)) !== output) {
      throw new Error('Invalid export path: ' + key)
    }
    entries.set(key, {
      output,
      source: target && !isDeclaration(target) ? inside(root, target) : undefined,
      types: inside(root, types),
    })
  }
  const bins = new Map<string, RuntimeEntry>
  const binFiles = new Map<string, string>
  for (const [name, path] of Object.entries(commands ?? {})) {
    if (!/^[\w\-.]+$/u.test(name) || name === '.' || name === '..') {
      throw new Error(`Invalid bin name: ${name}`)
    }
    const source = inside(root, path)
    const output = binFiles.get(source) ?? (binFiles.size ? `bin/${name}.js` : 'cli.js')
    binFiles.set(source, output)
    bins.set(name, {
      source,
      output,
    })
  }
  if (!entries.size && !bins.size) {
    throw new Error('No library, declaration or CLI entry found in ' + root)
  }
  const sourceFiles = [root, ...entries.values().map(entry => entry.types), ...entries.values().flatMap(entry => entry.source ? [entry.source] : []), ...bins.values().map(entry => entry.source)]
  if (sourceFiles.some(source => isInside(outputFolder, source))) {
    throw new Error(`Output would overwrite the input package: ${outputFolder}`)
  }
  const dependencies = new Set([
    ...Object.keys(options.bundle ? {} : manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  const external = (id: string) => id === 'bun' || id.startsWith('bun:') || id.startsWith('node:') || dependencies.has(dependencyName(id))
  const production = mode === 'production'
  const hasDeclarationOnlyEntries = entries.values().some(entry => !entry.source)
  if (hasDeclarationOnlyEntries && options.emitDts === false) {
    throw new Error('Declaration-only exports require declaration emission.')
  }
  const emitDts = Boolean(entries.size) && (options.emitDts === undefined || options.emitDts === 'auto' ? production || hasDeclarationOnlyEntries : options.emitDts)
  const strength = terser === 'auto' ? production : terser
  return {
    root,
    outputFolder,
    manifest,
    mode,
    entries,
    bins,
    passthrough,
    external,
    emitDts,
    strategy,
    production,
    strength,
    options,
  }
}

export type Project = Awaited<ReturnType<typeof resolveProject>>
export const entryName = (output: string) => output.slice(0, -extname(output).length)
