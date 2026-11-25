import type {Project} from './project.ts'
import type {InputOptions} from 'rolldown'

import {join} from 'node:path'

import fs from 'fs-extra'
import {build} from 'rolldown'

import {minify} from './minify.ts'
import {modulePath, relativePath} from './paths.ts'
import {entryName} from './project.ts'

export const rolldownInput = ({root, external}: Project): InputOptions => ({
  cwd: root,
  external,
  platform: 'node',
  preserveEntrySignatures: 'strict',
  onLog(level, log, handler) {
    handler(log.code === 'UNRESOLVED_IMPORT' || log.code === 'FILENAME_CONFLICT' ? 'error' : level, log)
  },
})

const writePrecompiledEntry = async (project: Project, destination: string) => {
  const {source, output} = project.entries.get('.')!
  const script = await Bun.file(source).text()
  const runtimeFile = join(destination, relativePath(project.root, source))
  await Bun.write(runtimeFile, await minify(script, project.strength))
  const facade = join(destination, output)
  if (facade !== runtimeFile) {
    const specifier = JSON.stringify(modulePath(facade, runtimeFile))
    const transpiler = new Bun.Transpiler({loader: 'js'})
    const hasDefault = transpiler.scan(script).exports.includes('default')
    await Bun.write(facade, `${hasDefault ? `export {default} from ${specifier}\n` : ''}export * from ${specifier}\n`)
  }
}

export const writeRuntime = async (project: Project, destination: string) => {
  const {options, entries, bins, production, strength} = project
  if (options.precompiled) {
    await writePrecompiledEntry(project, destination)
  }
  const input = Object.fromEntries([...options.precompiled ? [] : entries.values(), ...bins.values()].map(entry => [entryName(entry.output), entry.source]))
  if (!Object.keys(input).length) {
    return
  }
  const define: Record<string, string> = {}
  if (production) {
    define['process.env.NODE_ENV'] = '"production"'
  }
  if (options.bunExclusive) {
    define['globalThis.Deno'] = 'undefined'
  }
  if (options.platform) {
    define['process.platform'] = JSON.stringify(options.platform === 'native' ? process.platform : options.platform)
    define['process.env.GRACEFUL_FS_PLATFORM'] = define['process.platform']
  }
  if (options.arch) {
    define['process.arch'] = JSON.stringify(options.arch === 'native' ? process.arch : options.arch)
  }
  await build({
    ...rolldownInput(project),
    input,
    experimental: {importAttributes: true},
    ...options.bunExclusive ? {resolve: {conditionNames: ['bun', 'node']}} : {},
    transform: {define: {
      ...define,
      ...options.define,
    }},
    plugins: options.plugins,
    output: {
      dir: destination,
      format: 'es',
      entryFileNames: '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
      minify: production,
      plugins: strength ? [{
        name: 'bundil:terser',
        renderChunk: code => minify(code, strength),
      }] : [],
    },
  })
  for (const output of new Set(bins.values().map(entry => entry.output))) {
    const file = Bun.file(join(destination, output))
    const script = await file.text()
    if (!script.startsWith('#!')) {
      await Bun.write(file, `#!/usr/bin/env bun\n${script}`)
    }
    await fs.chmod(file.name!, 0o755)
  }
}
