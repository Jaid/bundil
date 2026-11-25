import type {Project} from './project.ts'

export const minify = async (code: string, strength: Project['strength'], module = true) => {
  if (!strength) {
    return code
  }
  const {minify: terser} = await import('terser')
  const aggressive = strength === 'aggressive' || strength === 'max'
  const result = await terser(code, {
    module,
    ecma: 2020,
    compress: {
      passes: 100,
      pure_new: aggressive,
      unsafe_comps: aggressive,
      unsafe_Function: aggressive,
      unsafe_math: aggressive,
      unsafe_methods: aggressive,
      unsafe_proto: aggressive,
      unsafe_regexp: aggressive,
      unsafe_undefined: aggressive,
      unsafe: strength === 'max',
    },
    format: {semicolons: false},
  })
  return result.code ?? ''
}
