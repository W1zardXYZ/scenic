import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanFolder, describesCondition, folderChain, isLikelyMap, classify, levelOf, mentions, parseName, provenance } from './names.ts'

test('parseName: size, grid flag and tokens from a real pack name', () => {
  const gridded = parseName('52x52 Easter Egg Hunt Meadow Day_No_Candy GRID')
  assert.equal(gridded.cols, 52)
  assert.equal(gridded.rows, 52)
  assert.equal(gridded.grid, true)
  assert.deepEqual(gridded.tokens, ['Easter', 'Egg', 'Hunt', 'Meadow', 'Day', 'No', 'Candy'])
  assert.equal(gridded.ppi, null)
  assert.equal(gridded.labelled, false)
})

test('parseName: "NG" means no grid and the two files share a key', () => {
  const grid = parseName('52x52 Easter Egg Hunt Meadow Day_No_Candy GRID')
  const ng = parseName('52x52 Easter Egg Hunt Meadow Day_No_Candy NG')
  assert.equal(ng.grid, false)
  assert.equal(ng.key, grid.key)
  assert.equal(ng.key, 'easter egg hunt meadow day no candy')
})

test('parseName: bracketed size with only a label range', () => {
  const p = parseName('[80x55] A1-A12')
  assert.equal(p.cols, 80)
  assert.equal(p.rows, 55)
  assert.deepEqual(p.tokens, ['A1-A12'])
  assert.equal(p.grid, null)
  assert.equal(p.labelled, false)
})

test('parseName: labelled and unlabelled variants share a key', () => {
  const labelled = parseName('A1-A12 labelled')
  const plain = parseName('A1-A12 unlabelled')
  assert.equal(labelled.labelled, true)
  assert.equal(plain.labelled, false)
  assert.equal(labelled.key, 'a1-a12')
  assert.equal(plain.key, labelled.key)
  assert.equal(parseName('Foo Labeled').labelled, true)
  assert.equal(parseName('Foo Keyed').labelled, true)
})

test('parseName: gridless, size and ppi are stripped from the tokens', () => {
  const p = parseName('Foo Gridless 30x20 140ppi')
  assert.equal(p.grid, false)
  assert.equal(p.cols, 30)
  assert.equal(p.rows, 20)
  assert.equal(p.ppi, 140)
  assert.deepEqual(p.tokens, ['Foo'])
  assert.equal(p.key, 'foo')
})

test('parseName: other grid spellings', () => {
  assert.equal(parseName('Foo No Grid').grid, false)
  assert.equal(parseName('Foo_nogrid').grid, false)
  assert.equal(parseName('Foo ungridded').grid, false)
  assert.equal(parseName('Foo Gridded').grid, true)
  assert.equal(parseName('Foo').grid, null)
  // Without a marker the folder decides.
  assert.equal(parseName('Foo', ['Pack', 'Gridded']).grid, true)
  assert.equal(parseName('Foo', ['Pack', 'No Grid']).grid, false)
  // The file name wins over the folder.
  assert.equal(parseName('Foo NG', ['Pack', 'Gridded']).grid, false)
})

test('parseName: "Unlabelled Bar" is not labelled and the marker leaves the key', () => {
  const p = parseName('Unlabelled Bar')
  assert.equal(p.labelled, false)
  assert.equal(p.key, 'bar')
  assert.equal(p.cols, null)
})

test('parseName: pixel dimensions are not square counts', () => {
  const p = parseName('5250x5250 thing')
  assert.equal(p.cols, null)
  assert.equal(p.rows, null)
  // Tiny and implausible sizes are ignored too.
  assert.equal(parseName('2x2 thing').cols, null)
  assert.equal(parseName('999x999 thing').cols, null)
})

test('parseName: decimals are not sizes', () => {
  assert.equal(parseName('Map 1.5x20').cols, null)
})

const place = (segments: string[], share = 0) => provenance(folderChain(segments), share)

test('provenance: platform folder chain', () => {
  assert.deepEqual(place(['Patreon', 'MatthewWayfarer', '2026', 'Easter Pack 1', 'Battle Maps']), { creator: 'MatthewWayfarer', pack: 'Easter Pack 1' })
  assert.deepEqual(place(['Patreon', 'SnowysMaps'], 1), { creator: 'SnowysMaps', pack: '' })
})

test('provenance: zip-duplicated folder name collapses', () => {
  assert.deepEqual(place(['Patreon', 'MatthewWayfarer', 'Easter Pack 1', 'Easter Pack 1', 'Battle Maps']), { creator: 'MatthewWayfarer', pack: 'Easter Pack 1' })
})

test('provenance: parallel grid trees resolve to the same adventure', () => {
  const expected = { creator: 'Questonomicon tactical maps', pack: 'Hunt for Haldraxis' }
  assert.deepEqual(place(['Questonomicon tactical maps', '01 WITH GRID', '01 Hunt for Haldraxis']), expected)
  assert.deepEqual(place(['Questonomicon tactical maps', '02 NO GRID', '01 Hunt for Haldraxis']), expected)
})

test('provenance: a lone folder is a project only when its files echo its name', () => {
  assert.deepEqual(place(['Butterskull'], 4 / 7), { creator: '', pack: 'Butterskull' })
  assert.deepEqual(place(['Czepeku'], 0), { creator: 'Czepeku', pack: '' })
  assert.equal(mentions('Butterskull', 'Butterskull Ranch v1.0 (roof)'), true)
  assert.equal(mentions('Butterskull', 'Shrine of Savras'), false)
})

test('cleanFolder keeps names that merely start with a number word', () => {
  assert.equal(cleanFolder('10 Rosewood’s Invitation'), 'Rosewood’s Invitation')
  assert.equal(cleanFolder('1. Keep'), 'Keep')
})

test('levels and conditions', () => {
  assert.equal(levelOf(['cellar']), -1)
  assert.equal(levelOf(['Floor', '2']), 2)
  assert.equal(levelOf(['b1']), -1)
  assert.equal(levelOf(['Slaughter']), null)
  assert.equal(describesCondition(['upper']), true)
  assert.equal(describesCondition(['Night', 'Rain']), true)
  assert.equal(describesCondition(['Keep']), false)
})

test('parseName: attached resolution and version stay out of the name', () => {
  const a = parseName('Haldraxis_Keep_no_grid_72')
  assert.deepEqual(a.tokens, ['Haldraxis', 'Keep'])
  assert.equal(a.ppi, 72)
  assert.equal(a.grid, false)
  const b = parseName('Butterskull Ranch v1.03 (cellar)')
  assert.deepEqual(b.tokens, ['Butterskull', 'Ranch', 'cellar'])
  assert.equal(b.version, 'v1.03')
  assert.deepEqual(parseName('Shrine of Savras v1.0 54x42 @140pps').tokens, ['Shrine', 'of', 'Savras'])
})

test('isLikelyMap: token and art folders are excluded', () => {
  assert.equal(isLikelyMap(['Pack', 'Tokens'], 'Orc'), false)
  assert.equal(isLikelyMap(['Pack', 'Token'], 'Orc'), false)
  assert.equal(isLikelyMap(['Pack', 'Portraits'], 'Hero'), false)
  assert.equal(isLikelyMap(['Pack', '__MACOSX'], 'x'), false)
  assert.equal(isLikelyMap(['Pack', 'Music'], 'x'), false)
  assert.equal(isLikelyMap(['Pack', 'Battle Maps'], 'Forest Day'), true)
})

test('isLikelyMap: cover images and previews are excluded', () => {
  assert.equal(isLikelyMap(['Pack'], 'Cover'), false)
  assert.equal(isLikelyMap(['Pack'], 'Pack Cover Image'), false)
  assert.equal(isLikelyMap(['Pack'], 'Forest_Preview'), false)
  assert.equal(isLikelyMap(['Pack'], 'thumbnail'), false)
  assert.equal(isLikelyMap(['Pack'], 'Logo'), false)
  assert.equal(isLikelyMap(['Pack'], 'Credits'), false)
  assert.equal(isLikelyMap(['Pack'], 'Poster'), false)
  // Words that merely contain a skip word stay in.
  assert.equal(isLikelyMap(['Pack'], 'Discovery Cave'), true)
  assert.equal(isLikelyMap(['Pack'], 'Covered Bridge'), true)
  // A folder that only starts like "tokens" is a map folder.
  assert.equal(isLikelyMap(['Token Pack'], 'x'), true)
})

test('classify: time, weather and biomes', () => {
  assert.deepEqual(classify('Forest Clearing Night Rain', 'Patreon/Creator'), {
    time: 'Night', weather: 'Rain', biomes: ['Forest'],
  })
  assert.deepEqual(classify('Meadow Day', 'Pack'), { time: 'Day', weather: '', biomes: ['Grassland'] })
  assert.deepEqual(classify('Plain', 'x'), { time: '', weather: '', biomes: [] })
  assert.equal(classify('Harbor at Dusk', 'x').time, 'Dusk')
  assert.equal(classify('Misty Dawn', 'x').weather, 'Fog')
  assert.equal(classify('Misty Dawn', 'x').time, 'Dawn')
})

test('classify: biomes use the path too, time and weather only the name', () => {
  const c = classify('Entrance', 'Creator/Cave Pack/Night')
  assert.deepEqual(c.biomes, ['Cave'])
  assert.equal(c.time, '')
  assert.equal(c.weather, '')
  assert.deepEqual(classify('Ruined Temple Castle', 'x').biomes.sort(), ['Castle', 'Temple'])
})
