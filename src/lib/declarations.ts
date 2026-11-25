import type {Project} from './project.ts'

import {join} from 'node:path'

import fs from 'fs-extra'
import {build} from 'rolldown'
import {dts} from 'rolldown-plugin-dts'

import {emitDeclarationGraph, validateDeclarations} from './declarationGraph.ts'
import {inside, relativePath} from './paths.ts'
import {dependencyName, entryName} from './project.ts'
import {rolldownInput} from './runtime.ts'

const inlineTypeLibraries = new Set(['type-fest', 'ts-toolbelt', 'ts-essentials', 'utility-types', 'more-types'])
export const writeDeclarations = async (project: Project, work: string, destination: string) => {
  const graph = join(work, 'graph')
  const {paths, options} = await emitDeclarationGraph(project, graph)
  const {strategy} = project
  if (strategy !== 'preserve') {
    const rootName = project.options.dtsFileName ?? 'lib.d.ts'
    if (relativePath(destination, inside(destination, rootName)) !== rootName || !rootName.endsWith('.d.ts')) {
      throw new Error(`Invalid bundled declaration file name: ${rootName}`)
    }
    // Validate separately so a failed bundle cannot leak stale files into the package.
    const bundled = join(work, 'bundled')
    await Bun.write(join(bundled, 'package.json'), '{"type":"module"}')
    const bundledPaths = new Map([...project.entries].map(([key, entry]) => [key, key === '.' ? rootName : `${entryName(entry.output)}.d.ts`]))
    const filenames = new Set(bundledPaths.values())
    if (filenames.size !== bundledPaths.size) {
      throw new Error(`Conflicting declaration file name: ${rootName}`)
    }
    let imports: Set<string> | undefined
    try {
      const input = Object.fromEntries([...paths].map(([key, path]) => [entryName(project.entries.get(key)!.output), join(graph, path)]))
      await build({
        ...rolldownInput(project),
        external: id => project.external(id) && !inlineTypeLibraries.has(dependencyName(id)),
        input,
        plugins: [dts({
          cwd: project.root,
          dtsOnly: true,
          tsconfig: false,
          generator: 'tsc',
        })],
        output: {
          dir: bundled,
          format: 'es',
          entryFileNames: chunk => (chunk.name === 'lib' ? rootName : '[name].d.ts'),
          chunkFileNames: 'chunks/[name]-[hash].d.ts',
        },
      })
      imports = validateDeclarations(project.root, bundled, bundledPaths, options)
    } catch (error) {
      if (strategy === 'bundle') {
        throw error
      }
      console.warn(`Using preserved declarations: ${Error.isError(error) ? error.message : String(error)}`)
    }
    if (imports) {
      await fs.remove(join(bundled, 'package.json'))
      await fs.copy(bundled, destination, {
        overwrite: false,
        errorOnExist: true,
      })
      return {
        paths: bundledPaths,
        strategy: 'bundle' as const,
        imports,
      }
    }
  }
  const preservedPaths = new Map([...paths].map(([key, path]) => [key, `types/${path}`]))
  await fs.move(graph, join(destination, 'types'))
  const imports = validateDeclarations(project.root, destination, preservedPaths, options)
  return {
    paths: preservedPaths,
    strategy: 'preserve' as const,
    imports,
  }
}
