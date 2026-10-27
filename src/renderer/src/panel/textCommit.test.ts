import { describe, it, expect } from 'vitest'
import { resolveTextCommit } from './textCommit'
import { commitDesignator } from './PropertiesPanel'

describe('resolveTextCommit', () => {
  it('without normalize: commits a change, ignores an unchanged draft, keeps the draft', () => {
    expect(resolveTextCommit('b', 'a')).toEqual({ commit: 'b', draft: 'b' })
    expect(resolveTextCommit('a', 'a')).toEqual({ commit: null, draft: 'a' })
    expect(resolveTextCommit('', 'a')).toEqual({ commit: '', draft: '' })
  })
  it('a refused (blank) designator reverts the draft and commits nothing', () => {
    expect(resolveTextCommit('', 'T1', commitDesignator)).toEqual({ commit: null, draft: 'T1' })
    expect(resolveTextCommit('   ', 'T1', commitDesignator)).toEqual({ commit: null, draft: 'T1' })
  })
  it('a padded designator commits trimmed and shows trimmed', () => {
    expect(resolveTextCommit(' T2 ', 'T1', commitDesignator)).toEqual({ commit: 'T2', draft: 'T2' })
    expect(resolveTextCommit(' T1 ', 'T1', commitDesignator)).toEqual({ commit: null, draft: 'T1' })
  })
})
