import type {BundilOptions, BundilResult} from './lib/types.ts'

import {join} from 'node:path'

import fs from 'fs-extra'

import {copyPackageFiles} from './lib/files.ts'
import {writeManifest} from './lib/manifest.ts'
import {slash} from './lib/paths.ts'
import {resolveProject} from './lib/project.ts'
import {writeRuntime} from './lib/runtime.ts'

const packageFiles = new Bun.Glob('**/*')
export const bundil = async (options: BundilOptions = {}): Promise<BundilResult> => {
  const project = await resolveProject(options)
  const temporary = join(project.root, 'temp')
  await fs.ensureDir(temporary)
  const work = await fs.mkdtemp(join(temporary, 'bundil-'))
  const destination = join(work, 'package')
  try {
    // Give TypeScript and Rolldown a package boundary without the source project's import aliases.
    await Bun.write(join(destination, 'package.json'), '{"type":"module"}')
    await writeRuntime(project, destination)
    const declarations = project.emitDts ? await import('./lib/declarations.ts').then(({writeDeclarations}) => writeDeclarations(project, work, destination)) : undefined
    await copyPackageFiles(project, destination)
    await writeManifest(project, destination, declarations)
    const files = Array.from(packageFiles.scanSync({
      cwd: destination,
      dot: true,
      onlyFiles: true,
    }), slash).toSorted()
    await fs.move(destination, project.outputFolder, {overwrite: true})
    return {
      outputFolder: slash(project.outputFolder),
      files,
      declarationStrategy: declarations?.strategy,
    }
  } finally {
    await fs.remove(work)
  }
}

export default bundil

export type {BundilOptions, BundilResult, DeclarationStrategy, Mode, TerserStrength} from './lib/types.ts'
