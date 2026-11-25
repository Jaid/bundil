import type {Project} from './project.ts'

import {dirname, join, resolve} from 'node:path'

import ts from 'typescript'

import {inside, isInside, modulePath, relativePath} from './paths.ts'
import {dependencyName} from './project.ts'

const declaration = /\.d\.[cm]?ts$/u
const toDeclaration = (file: string) => (declaration.test(file) ? file : file.replace(/\.([cm]?)[jt]sx?$/u, '.d.$1ts'))
const local = (root: string, file: string) => isInside(root, file) && !relativePath(root, file).split('/').includes('node_modules')
const diagnostics = (items: ReadonlyArray<ts.Diagnostic>) => ts.formatDiagnostics(items, {
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  getCanonicalFileName: file => file,
  getNewLine: () => '\n',
})
const compilerConfig = (project: Project) => {
  const file = join(project.root, 'tsconfig.json')
  const result = ts.sys.fileExists(file) ? ts.readConfigFile(file, path => ts.sys.readFile(path)) : {config: {files: project.entries.values().map(entry => entry.types).toArray()}}
  if (result.error) {
    throw new Error(diagnostics([result.error]))
  }
  const parsed = ts.parseJsonConfigFileContent(result.config, ts.sys, project.root, undefined, file)
  const errors = parsed.errors.filter(error => error.code !== 18_003) // The package entry can be outside `include`.
  if (errors.length) {
    throw new Error(diagnostics(errors))
  }
  return parsed
}
const visitSpecifiers = (file: ts.SourceFile, callback: (specifier: ts.StringLiteral) => void) => {
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) {
      const parent = node.parent
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent) || ts.isModuleDeclaration(parent) || ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) {
        callback(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}
/** Rewrite only module specifiers, including import types. A public string-literal type like './file.ts' is data. */
const rewriteSpecifiers = (text: string, source: string, root: string, options: ts.CompilerOptions, cache: ts.ModuleResolutionCache, include: (file: string) => void) => {
  const file = ts.createSourceFile(toDeclaration(source), text, ts.ScriptTarget.Latest, true)
  const edits: Array<{
    end: number
    start: number
    value: string
  }> = []
  for (const ref of file.referencedFiles) {
    const target = toDeclaration(resolve(dirname(source), ref.fileName))
    include(target)
    edits.push({
      start: ref.pos,
      end: ref.end,
      value: modulePath(source, target),
    })
  }
  visitSpecifiers(file, node => {
    const target = ts.resolveModuleName(node.text, source, options, ts.sys, cache).resolvedModule
    if (!target || target.isExternalLibraryImport || !local(root, target.resolvedFileName)) {
      return
    }
    const declarationFile = toDeclaration(target.resolvedFileName)
    include(declarationFile)
    const path = declarationFile.replace(/\.d\.([cm]?)ts$/u, '.$1js')
    const specifier = modulePath(source, path)
    if (specifier !== node.text) {
      edits.push({
        start: node.getStart(file),
        end: node.end,
        value: JSON.stringify(specifier),
      })
    }
  })
  for (const {start, end, value} of edits.toReversed()) {
    text = text.slice(0, start) + value + text.slice(end)
  }
  return text
}
const compiler = (root: string, roots: Array<string>, options: ts.CompilerOptions) => {
  const host = ts.createCompilerHost(options)
  host.getCurrentDirectory = () => root
  return ts.createProgram(roots, options, host)
}

/** Emit once. Both the bundler and the preserve fallback consume this same relocatable graph. */
export const emitDeclarationGraph = async (project: Project, folder: string) => {
  const {root, entries} = project
  const parsed = compilerConfig(project)
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    jsx: ts.JsxEmit.ReactJSX,
    ...parsed.options,
    allowImportingTsExtensions: true,
    allowJs: true,
    resolveJsonModule: true,
    composite: false,
    incremental: false,
    noEmit: false,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmitOnError: false,
    rootDir: root,
    outDir: folder,
    declarationDir: folder,
  }
  const roots = new Set(entries.values().map(entry => entry.types))
  for (const file of roots) {
    if (!await Bun.file(file).exists()) {
      throw new Error(`Declaration entry does not exist: ${file}`)
    }
  }
  for (const file of parsed.fileNames) {
    if (declaration.test(file) && local(root, file) && !isInside(join(root, 'temp'), file) && !isInside(project.outputFolder, file)) {
      roots.add(file)
    }
  }
  const program = compiler(root, [...roots], options)
  const cache = ts.createModuleResolutionCache(root, ts.sys.useCaseSensitiveFileNames ? file => file : file => file.toLowerCase(), options)
  const files = new Map<string, {
    content: string
    source: string
  }>
  const collect = (source: string, content: string) => {
    files.set(relativePath(root, toDeclaration(source)), {
      source,
      content,
    })
  }
  const result = program.emit(undefined, (_path, content, _bom, _error, sources) => {
    const source = sources?.[0]?.fileName
    if (source && local(root, source)) {
      collect(source, content)
    }
  }, undefined, true)
  if (result.diagnostics.length) {
    throw new Error(`Declaration emit failed.\n${diagnostics(result.diagnostics)}`)
  }
  for (const source of program.getSourceFiles()) {
    if (local(root, source.fileName) && (source.isDeclarationFile || source.fileName.endsWith('.json'))) {
      collect(source.fileName, source.text)
    }
  }
  const paths = new Map([...entries].map(([key, entry]) => [key, relativePath(root, toDeclaration(entry.types))]))
  // Only ship files reachable from public declarations, even if the implementation imported more JSON or TS.
  const needed = new Set(paths.values())
  for (const path of needed) {
    const file = files.get(path)
    if (!file) {
      throw new Error(`TypeScript did not emit declarations for ${path}`)
    }
    const text = path.endsWith('.json') ? file.content : rewriteSpecifiers(file.content, file.source, root, options, cache, target => needed.add(relativePath(root, target)))
    await Bun.write(inside(folder, path), text)
  }
  return {
    paths,
    options,
  }
}

/** Check the declarations as package files. Errors in the consumer’s installed third-party declarations are unrelated. */
export const validateDeclarations = (root: string, folder: string, paths: Map<string, string>, options: ts.CompilerOptions) => {
  const program = compiler(root, paths.values().map(path => resolve(folder, path)).toArray(), {
    ...options,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    paths: undefined,
    baseUrl: undefined,
    skipLibCheck: false,
    noEmit: true,
  })
  const errors: Array<ts.Diagnostic> = []
  const imports = new Set<string>
  for (const path of paths.values()) {
    if (!program.getSourceFile(resolve(folder, path))) {
      throw new Error(`Missing declaration entry: ${path}`)
    }
  }
  for (const file of program.getSourceFiles()) {
    if (!isInside(folder, file.fileName)) {
      continue
    }
    errors.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file))
    visitSpecifiers(file, specifier => imports.add(dependencyName(specifier.text)))
    for (const ref of file.typeReferenceDirectives) {
      imports.add(ref.fileName)
      imports.add(`@types/${ref.fileName.replace(/^@/u, '').replace('/', '__')}`)
    }
  }
  if (errors.length) {
    throw new Error(`Declaration output failed validation.\n${diagnostics(errors)}`)
  }
  return imports
}
