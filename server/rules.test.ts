import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RULES, normaliseRules, parseRuleText, type ScanRules } from '../shared/rules.ts'
import { describesCondition, isLikelyMap, parseName, useRules } from './names.ts'

const withRules = (patch: Partial<ScanRules>, check: () => void) => {
  useRules({ ...DEFAULT_RULES, ...patch })
  try {
    check()
  } finally {
    useRules(DEFAULT_RULES)
  }
}

test('rule text splits on lines and commas, without blanks or repeats', () => {
  assert.deepEqual(parseRuleText('Tokens, art\n\n  NPC ,tokens'), ['Tokens', 'art', 'NPC'])
})

test('stored rules keep their lists and fill the rest from the defaults', () => {
  const rules = normaliseRules({ skipFiles: ['map key', 7, 'x'.repeat(200)], bogus: ['y'] })
  assert.deepEqual(rules.skipFiles, ['map key'])
  assert.deepEqual(rules.skipFolders, DEFAULT_RULES.skipFolders)
  assert.equal('bogus' in rules, false)
  assert.deepEqual(normaliseRules(undefined), DEFAULT_RULES)
})

test('default rules skip monster and NPC folders, and character sheets', () => {
  assert.equal(isLikelyMap(['Pack', 'Questiary Monsters', 'Siren Grass'], 'SirenGrass'), false)
  assert.equal(isLikelyMap(['Pack', '03 NPCs'], 'Barkeep'), false)
  assert.equal(isLikelyMap(['Pack'], 'Hero_Character_Sheet'), false)
  assert.equal(isLikelyMap(['Monster Lair'], 'Cave'), true)
})

test('a skip word matches whole words and plurals, not parts of words', () => {
  withRules({ skipFiles: ['handout'] }, () => {
    assert.equal(isLikelyMap([], 'Tavern Handouts'), false)
    assert.equal(isLikelyMap([], 'Tavern_handout'), false)
    assert.equal(isLikelyMap([], 'Handoutside'), true)
  })
})

test('* stands for any text', () => {
  withRules({ skipFolders: ['promo*'], skipFiles: ['*_v0'] }, () => {
    assert.equal(isLikelyMap(['Promotional'], 'Map'), false)
    assert.equal(isLikelyMap(['Maps'], 'Draft_v0'), false)
    assert.equal(isLikelyMap(['Maps'], 'Draft v1'), true)
  })
})

test('always include wins over a skip rule', () => {
  withRules({ include: ['battle art'] }, () => {
    assert.equal(isLikelyMap(['Pack', 'Art'], 'Portrait'), false)
    assert.equal(isLikelyMap(['Pack', 'Battle Art'], 'x'), true)
  })
  withRules({ include: ['ruins'] }, () => {
    assert.equal(isLikelyMap(['Pack', 'Art'], 'Ruins Night'), true)
  })
})

test('removing a default skip word lets those files in', () => {
  withRules({ skipFiles: [] }, () => assert.equal(isLikelyMap(['Pack'], 'Cover'), true))
})

test('extra grid and label words are understood and kept out of the name', () => {
  withRules({ gridded: ['sq'], gridless: ['clean'], labelled: ['gm'], unlabelled: ['player'] }, () => {
    const a = parseName('Tavern_sq')
    assert.equal(a.grid, true)
    assert.deepEqual(a.tokens, ['Tavern'])
    assert.equal(parseName('Tavern clean').grid, false)
    assert.equal(parseName('Tavern GM').labelled, true)
    assert.equal(parseName('Tavern GM').key, parseName('Tavern Player').key)
    assert.equal(parseName('Tavern Player').labelled, false)
  })
  // Without the words, they are ordinary parts of the name.
  assert.equal(parseName('Tavern_sq').grid, null)
})

test('variant words group otherwise different names', () => {
  assert.equal(describesCondition(['Cutaway']), true)
  assert.equal(describesCondition(['Ruined']), false)
  withRules({ variants: ['ruined'] }, () => assert.equal(describesCondition(['Ruined']), true))
})
