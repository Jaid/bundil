import type {Project} from './project.ts'

import {dirname, join} from 'node:path'

import fs from 'fs-extra'

import {minify} from './minify.ts'
import {inside, isInside, relativePath} from './paths.ts'

export const copyPackageFiles = async (project: Project, destination: string) => {
  const {options, root} = project
  const rootFiles = await fs.readdir(root)
  for (const [pattern, output] of [[/^readme\.md$/iu, 'README.md'], [/^licen[cs]e(?:\.(?:md|txt))?$/iu, 'LICENSE']] as const) {
    const file = rootFiles.find(name => pattern.test(name))
    if (file) {
      await fs.copy(join(root, file), join(destination, output))
    }
  }
  const seen = new Set<string>
  const runtime = options.precompiled && project.entries.get('.')!.source
  const copy = async (source: string) => {
    if (source === runtime || seen.has(source)) {
      return
    }
    seen.add(source)
    const stats = await fs.lstat(source)
    if (stats.isDirectory()) {
      for (const name of await fs.readdir(source)) {
        await copy(join(source, name))
      }
      return
    }
    if (!stats.isFile()) {
      throw new Error(`Expected a regular file to copy: ${source}`)
    }
    const relative = relativePath(root, source)
    const target = inside(destination, relative)
    if (relative === 'package.json' || await fs.pathExists(target)) {
      throw new Error(`Copied file conflicts with package output: ${relative}`)
    }
    if (options.optimizeCopiedScripts && /\.[cm]?js$/u.test(source) && project.strength) {
      await Bun.write(target, await minify(await Bun.file(source).text(), project.strength, !source.endsWith('.cjs')))
    } else {
      await fs.copy(source, target)
    }
  }
  const paths = typeof options.copyFiles === 'string' ? [options.copyFiles] : options.copyFiles ?? []
  for (const path of paths) {
    const source = inside(root, path)
    if (!isInside(await fs.realpath(root), await fs.realpath(source)) || isInside(source, dirname(destination)) || isInside(source, project.outputFolder)) {
      throw new Error(`Cannot copy ${source} into the package`)
    }
    await copy(source)
  }
}
